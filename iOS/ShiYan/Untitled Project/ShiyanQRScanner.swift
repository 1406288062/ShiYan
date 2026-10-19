import SwiftUI
import AVFoundation
import UIKit

nonisolated struct ShiyanLoginQR {
    let id: String
    let secret: String
    init(_ text: String) throws {
        guard text.utf8.count <= 512, let url = URLComponents(string: text),
              url.scheme == "shiyan", url.host == "login", url.path.isEmpty,
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let items = url.queryItems, items.count == 3,
              items.filter({ $0.name == "v" }).map(\.value) == ["1"],
              items.filter({ $0.name == "id" }).count == 1,
              items.filter({ $0.name == "secret" }).count == 1,
              let id = items.first(where: { $0.name == "id" })?.value,
              let secret = items.first(where: { $0.name == "secret" })?.value,
              id.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw AgentClientError.message("这不是拾燕登录二维码，请扫描电脑登录页上的二维码。")
        }
        self.id = id; self.secret = secret
    }
    var fields: [String: Any] { ["id": id, "scanSecret": secret] }
}

private struct QRPreview: Decodable {
    let code: String
    let expiresAt: Double
    let device: String
}

struct ShiyanQRScanner: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var account = ShiyanAccount.shared
    @State private var cameraAllowed = false
    @State private var permissionChecked = false
    @State private var scanned = false
    @State private var busy = false
    @State private var challenge: ShiyanLoginQR?
    @State private var preview: QRPreview?
    @State private var message: String?
    @State private var completed = false
    @State private var generation: UUID?

    var body: some View {
        NavigationStack {
            Group {
                if completed {
                    VStack(spacing: 24) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 54)).foregroundStyle(.green)
                        Text("已确认登录").font(.title2.bold())
                    }
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    // Center the result in the full presentation, including the
                    // space behind the navigation bar and home indicator.
                    .ignoresSafeArea(.container, edges: .vertical)
                } else {
            VStack(spacing: 24) {
                if let preview {
                    Spacer()
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 54)).foregroundStyle(.secondary)
                    Text("登录这台电脑？").font(.title2.bold())
                    if !completed {
                        Text(preview.device).foregroundStyle(.secondary)
                        Text(preview.code).font(.system(size: 36, weight: .semibold, design: .monospaced))
                        Text("请核对电脑上的确认码。将使用当前账户“\(account.user?.name ?? "")”登录。")
                            .multilineTextAlignment(.center).foregroundStyle(.secondary)
                        if let message {
                            Image(systemName: "xmark.circle").font(.system(size: 40)).foregroundStyle(.red)
                            Text(message).foregroundStyle(.red).multilineTextAlignment(.center)
                        }
                        Button { Task { await approve(true) } } label: {
                            HStack { if busy { ProgressView() }; Text("登录这台电脑") }.frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.borderedProminent).disabled(busy || generation != ShiyanAccountStorage.generation)
                        Button("取消登录", role: .cancel) { Task { await approve(false) } }.disabled(busy)
                    }
                    Spacer()
                } else if cameraAllowed && !scanned {
                    Spacer(minLength: 0)
                    QRLiveCamera { code in
                        guard !scanned else { return }
                        scanned = true
                        Task { await inspect(code) }
                    } onError: { error in
                        scanned = true; message = error
                    }
                    .aspectRatio(1, contentMode: .fit)
                    .frame(maxWidth: 480)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 24))
                    .overlay {
                        Image(systemName: "viewfinder").font(.system(size: 100, weight: .ultraLight)).foregroundStyle(.white.opacity(0.85))
                            .accessibilityHidden(true)
                    }
                    .accessibilityLabel("扫描拾燕登录二维码")
                    Text("扫描电脑端拾燕登录页的二维码").foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                } else {
                    Spacer()
                    if busy { ProgressView("正在读取二维码…") }
                    else if let message {
                        Image(systemName: "xmark.circle").font(.system(size: 54)).foregroundStyle(.red)
                        Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        if cameraAllowed {
                            Button("重新扫描") { self.message = nil; scanned = false }.buttonStyle(.borderedProminent)
                        } else if permissionChecked {
                            Button("打开系统设置") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                        }
                    } else { ProgressView() }
                    Spacer()
                }
            }
            .padding(24)
                }
            }
            .navigationTitle(completed ? "" : "扫一扫").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ShiyanCloseButton(action: { dismiss() }, inToolbar: true) }
            }
        }
        .task {
            generation = ShiyanAccountStorage.generation
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            if status == .authorized { cameraAllowed = true }
            else if status == .notDetermined { cameraAllowed = await AVCaptureDevice.requestAccess(for: .video) }
            permissionChecked = true
            if !cameraAllowed { message = "请在系统设置中允许拾燕使用相机，以扫描登录二维码。" }
        }
    }

    private func inspect(_ text: String) async {
        busy = true; message = nil
        defer { busy = false }
        do {
            guard generation == ShiyanAccountStorage.generation, account.user != nil else { throw CancellationError() }
            let value = try ShiyanLoginQR(text)
            let data = try await CodexClient.shared.authRequest(route: "auth/qr/preview", method: "POST", object: value.fields)
            guard !Task.isCancelled, generation == ShiyanAccountStorage.generation else { return }
            preview = try JSONDecoder().decode(QRPreview.self, from: data); challenge = value
        } catch {
            guard generation == ShiyanAccountStorage.generation, !Task.isCancelled else { return }
            message = error.localizedDescription
        }
    }
    private func approve(_ accepted: Bool) async {
        guard let challenge, !busy, generation == ShiyanAccountStorage.generation, account.user != nil else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            var fields = challenge.fields; fields["approve"] = accepted
            if accepted, let avatar = shiyanLoginAvatar() { fields["avatar"] = avatar }
            _ = try await CodexClient.shared.authRequest(route: "auth/qr/approve", method: "POST", object: fields)
            guard generation == ShiyanAccountStorage.generation, !Task.isCancelled else { return }
            if accepted { completed = true } else { dismiss() }
        } catch {
            guard generation == ShiyanAccountStorage.generation, !Task.isCancelled else { return }
            message = error.localizedDescription
        }
    }
}

private struct QRLiveCamera: UIViewControllerRepresentable {
    let onCode: @MainActor @Sendable (String) -> Void
    let onError: @MainActor @Sendable (String) -> Void
    func makeUIViewController(context: Context) -> QRPreviewController { QRPreviewController(onCode: onCode, onError: onError) }
    func updateUIViewController(_ uiViewController: QRPreviewController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: QRPreviewController, coordinator: ()) { uiViewController.worker.stop() }
}

private final class QRPreviewController: UIViewController {
    let worker: QRSessionWorker
    private var cameraLayer: AVCaptureVideoPreviewLayer?
    init(onCode: @escaping @MainActor @Sendable (String) -> Void, onError: @escaping @MainActor @Sendable (String) -> Void) {
        worker = QRSessionWorker(onCode: onCode, onError: onError)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: worker.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer); cameraLayer = layer
        worker.start()
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); cameraLayer?.frame = view.bounds }
}

// Capture configuration/start/stop stays off the UI thread on one serial queue.
nonisolated private final class QRSessionWorker: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "shiyan.qr-camera")
    private let onCode: @MainActor @Sendable (String) -> Void
    private let onError: @MainActor @Sendable (String) -> Void
    private var delivered = false
    private var stopped = false
    init(onCode: @escaping @MainActor @Sendable (String) -> Void, onError: @escaping @MainActor @Sendable (String) -> Void) {
        self.onCode = onCode; self.onError = onError
    }
    func start() {
        queue.async { [self] in
            guard !stopped else { return }
            do {
                session.beginConfiguration()
                defer { session.commitConfiguration() }
                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw CameraFailure.unavailable }
                let input = try AVCaptureDeviceInput(device: device)
                let output = AVCaptureMetadataOutput()
                guard session.canAddInput(input), session.canAddOutput(output) else { throw CameraFailure.unavailable }
                session.addInput(input); session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: queue)
                guard output.availableMetadataObjectTypes.contains(.qr) else { throw CameraFailure.unavailable }
                output.metadataObjectTypes = [.qr]
            } catch {
                Task { @MainActor [onError] in onError("无法启动相机，请关闭后重试。") }
                return
            }
            if !stopped { session.startRunning() }
        }
    }
    func stop() { queue.async { [self] in stopped = true; if session.isRunning { session.stopRunning() } } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, !stopped, let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        delivered = true; session.stopRunning()
        Task { @MainActor [onCode] in onCode(code) }
    }
    private enum CameraFailure: Error { case unavailable }
}
