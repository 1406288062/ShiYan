import SwiftUI
import PhotosUI

private struct EnhanceButtonHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

enum ShiyanFeaturePage: String, Identifiable {
    case enhance
    case space
    case dots
    case scheduled
    case settings

    var id: String { rawValue }
    var title: String { self == .enhance ? "变清晰" : self == .space ? "空间" : self == .scheduled ? "定时任务" : self == .settings ? "设置" : "Dots" }
    var iconAsset: String { self == .enhance ? "enhanceFeatureIcon" : self == .space ? "spaceFeatureIcon" : "dotsPersonalIcon" }

    @ViewBuilder var icon: some View {
        if self == .settings { Image(systemName: "gearshape").resizable().scaledToFit() }
        else if self == .scheduled { Image(systemName: "clock").resizable().scaledToFit() }
        else if self == .dots { Image("dotsPersonalIcon").renderingMode(.template).resizable().scaledToFit() }
        else { Image(iconAsset).renderingMode(.template).resizable().scaledToFit() }
    }

    var heading: some View {
        Text(title).font(.headline)
            .accessibilityIdentifier("feature-page-title-\(rawValue)")
    }

}

 
struct ShiyanFeatureHeader<Trailing: View>: View {
    let page: ShiyanFeaturePage
    let topInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    var onBack: (() -> Void)? = nil
    var backLabel: String = "返回"
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack {
            if let onBack {
                AgentRoundButton(symbol: "chevron.left", label: backLabel,
                                 diameter: ShiyanPreviewLayout.controlDiameter, action: onBack)
                    .accessibilityIdentifier("feature-back-\(page.rawValue)")
            } else {
                AgentSidebarButton(hasUnread: hasUnread, diameter: ShiyanPreviewLayout.controlDiameter, action: onSidebar)
                    .accessibilityIdentifier("feature-open-sidebar-\(page.rawValue)")
            }
            Spacer()
            trailing().frame(width: 46, height: 46)
        }
        .padding(.horizontal, 16)
        .padding(.top, topInset + 3)
        .padding(.bottom, 20)
    }
}

 
struct ContentView: View {
    @StateObject private var history = HistoryManager()

    var body: some View {
        AIAgentView(history: history)
#if DEBUG
            .task { await ShiyanDeviceSmokeProbe.runIfRequested() }
#endif
    }
}

struct EnhanceView: View {
    @ObservedObject var history: HistoryManager
    let topInset: CGFloat
    let hasUnread: Bool
    let onSidebar: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var inputImage: CGImage?
    @State private var outputImage: CGImage?
    @State private var outputFilename: String?
    @State private var originalFilename = "photo"
    @State private var selectedModel: ESRGANEngine.Model = .x4

    @State private var isProcessing = false
    @State private var progressValue: Double = 0
    @State private var enhanceTask: Task<Void, Never>?

    @State private var photoPickerPresented = false
    @State private var showToast = false
    @State private var toastMessage = ""
    @State private var toastIsError = false
    @State private var showOriginal = false
    @State private var scanPhase: CGFloat = 0
    @State private var largeImageAlert = false
    @State private var pendingImage: CGImage?
    @State private var isSaving = false
    @State private var enhanceButtonHeight: CGFloat = 48


    private let engine = ESRGANEngine()

    private var isBusy: Bool { isProcessing }
    private var debugProxy: Bool {
        ProcessInfo.processInfo.environment["SHIYAN_DEBUG_PROXY"] == "1"
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 16) {
                    imageArea.shiyanQAGeometry("home-image").accessibilityElement(children: .contain).accessibilityIdentifier("home-image-area")
                    bottomControls
                }
                .padding(.horizontal, 16)
                .padding(.top, topInset + 80)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity, alignment: .top)
            }
            .scrollDisabled(true)
            .scrollBounceBehavior(.basedOnSize)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .safeAreaBar(edge: .top, spacing: -(topInset + 69)) {
                ShiyanFeatureHeader(page: .enhance, topInset: topInset,
                                    hasUnread: hasUnread, onSidebar: onSidebar) { Color.clear }
            }
            .photosPicker(
                isPresented: $photoPickerPresented,
                selection: $selectedPhoto,
                matching: .images
            )
            .onChange(of: selectedPhoto) { _, newValue in
                guard let newValue else { return }
                Task { await loadImage(newValue) }
            }
            .alert("图片较大", isPresented: $largeImageAlert) {
                Button("取消", role: .cancel) { pendingImage = nil }
                Button("继续") {
                    if let pendingImage {
                        acceptInputImage(pendingImage)
                    }
                    pendingImage = nil
                }
            } message: {
                Text("图片分辨率超过 2000px，处理时间可能较长且占用更多内存，是否继续？")
            }
            .overlay(alignment: .top) {
                if showToast {
                    HStack(spacing: 12) {
                        Image(systemName: toastIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(toastIsError ? .red : .green)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("拾燕").font(.subheadline).fontWeight(.semibold)
                            Text(toastMessage).font(.caption).foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .shiyanGlass(
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous),
                        tint: .white.opacity(0.06)
                    )
                    .padding(.horizontal, 16)
                     
                     
                    .padding(.top, max(0, topInset) + 3 + ShiyanPreviewLayout.controlDiameter + 14)
                    .transition(.push(from: .top))
                }
            }
            .animation(.spring(response: 0.45, dampingFraction: 0.75), value: showToast)
            .onAppear {
#if DEBUG
                do { _ = try AgentIdentity.shared.enrollment() }
                catch { NSLog("[ShiyanIdentityInit] %@", error.localizedDescription) }
                if let id = ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_DOWNLOAD_ASSET"], UUID(uuidString: id) != nil {
                    Task {
                        do {
                            let asset = try await CodexClient.shared.download(AgentRemoteAsset(id: id, filename: "network-test.png", mimeType: "image/png", bytes: nil))
                            NSLog("[ShiyanDownloadProbe] saved=%@", asset.relativePath)
                        } catch { NSLog("[ShiyanDownloadProbe] error=%@", error.localizedDescription) }
                    }
                }
                if let fixture = ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_IMAGE"],
                   !fixture.contains("/"),
                   let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
                   let data = try? Data(contentsOf: folder.appendingPathComponent(fixture)),
                   let image = UIImage(data: data)?.normalizedCGImage {
                    acceptInputImage(image)
                }
#endif
            }
        }
    }

    private var bottomControls: some View {
        VStack(spacing: 16) {
            modelSelector
            enhanceButton
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .shiyanGlass(in: RoundedRectangle(cornerRadius: 28, style: .continuous),
                     tint: .white.opacity(0.035), interactive: false)
        .shiyanQAGeometry("home-panel")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-tool-panel")
        .padding(.bottom, 8)
    }

     

    private var imageArea: some View {
        Group {
            if let input = inputImage {
                imageWorkspace(input: input).frame(maxWidth: .infinity)
            } else {
                Button {
                    photoPickerPresented = true
                } label: {
                    VStack(spacing: 12) {
                        Image(systemName: "photo.badge.plus")
                            .font(.system(size: 40))
                            .foregroundStyle(ShiyanTheme.accent)
                        Text("选择图片")
                            .font(.headline)
                            .foregroundStyle(ShiyanTheme.accent)
                        Text("支持 JPG / PNG / HEIC")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).aspectRatio(1, contentMode: .fit)
                    .background(
                        Color(.systemGray6),
                        in: RoundedRectangle(cornerRadius: ShiyanTheme.panelRadius, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
            }
        }
    }

    private func imageWorkspace(input: CGImage) -> some View {
        imageContent(input: input)
            .overlay {
                if isBusy {
                    processingOverlay
                }
            }
            .overlay(alignment: .bottom) {
                if !isBusy {
                    Button {
                        photoPickerPresented = true
                    } label: {
                        Text("点击更换图片")
                            .font(.caption2)
                            .padding(.vertical, 3)
                            .padding(.horizontal, 8)
                            .background(.thinMaterial)
                            .cornerRadius(5)
                            .padding(.bottom, 6)
                    }
                    .buttonStyle(.plain)
                }
            }
            .overlay(alignment: .topLeading) {
                imageOverlay(input: input)
            }
    }

    private var processingOverlay: some View {
        ZStack {
            Color.black.opacity(0.3)
            GeometryReader { geo in
                Rectangle()
                    .fill(
                        LinearGradient(
                            stops: [
                                .init(color: .white.opacity(0), location: 0),
                                .init(color: .white.opacity(0.15), location: 0.45),
                                .init(color: .white.opacity(0.4), location: 0.5),
                                .init(color: .white.opacity(0.15), location: 0.55),
                                .init(color: .white.opacity(0), location: 1),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(height: 80)
                    .offset(y: scanOffset(geo.size.height))
                    .blur(radius: 2)
                    .onAppear {
                        scanPhase = 0
                        withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) {
                            scanPhase = 1
                        }
                    }
            }

                ZStack {
                    Circle().stroke(Color.white.opacity(0.3), lineWidth: 4)
                        .frame(width: 56, height: 56)
                    Circle()
                        .trim(from: 0, to: progressValue)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .frame(width: 56, height: 56)
                        .rotationEffect(.degrees(-90))
                    Text("\(Int(progressValue * 100))%")
                        .foregroundColor(.white)
                        .font(.system(size: 13, weight: .medium))
                }

        }
    }

    private func imageContent(input: CGImage) -> some View {
        let img = (outputImage != nil && !showOriginal) ? outputImage! : input
        return Image(decorative: img, scale: 1.0)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(maxHeight: 360)
            .clipShape(RoundedRectangle(cornerRadius: ShiyanTheme.panelRadius, style: .continuous))
    }

    private func imageOverlay(input: CGImage) -> some View {
        let img = (!showOriginal && outputImage != nil) ? outputImage! : input
        return Group {
            if outputImage != nil {
                HStack(spacing: 6) {
                    Button {
                        withAnimation { showOriginal = false }
                    } label: {
                        Text(resultLabel)
                            .font(.caption2)
                            .fontWeight(!showOriginal ? .semibold : .regular)
                            .padding(.vertical, 3)
                            .padding(.horizontal, 10)
                            .background(
                                !showOriginal
                                    ? AnyShapeStyle(activeAccent)
                                    : AnyShapeStyle(.thinMaterial)
                            )
                            .foregroundColor(!showOriginal ? .white : .primary)
                            .cornerRadius(5)
                    }
                    Button {
                        withAnimation { showOriginal = true }
                    } label: {
                        Text("原图")
                            .font(.caption2)
                            .fontWeight(showOriginal ? .semibold : .regular)
                            .padding(.vertical, 3)
                            .padding(.horizontal, 10)
                            .background(
                                showOriginal
                                    ? AnyShapeStyle(activeAccent)
                                    : AnyShapeStyle(.thinMaterial)
                            )
                            .foregroundColor(showOriginal ? .white : .primary)
                            .cornerRadius(5)
                    }
                    Text("\(img.width)×\(img.height)")
                        .font(.caption2)
                        .padding(.vertical, 3)
                        .padding(.horizontal, 6)
                        .background(.thinMaterial)
                        .cornerRadius(5)
                }
                .padding(6)
            } else {
                Text("\(img.width)×\(img.height)")
                    .font(.caption2)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 8)
                    .background(.thinMaterial)
                    .cornerRadius(5)
                    .padding(6)
            }
        }
    }

     

    private var modelSelector: some View {
        HStack(spacing: 0) {
            ForEach(ESRGANEngine.Model.allCases, id: \.rawValue) { model in
                Button {
                    selectedModel = model
                } label: {
                    HStack(spacing: 10) {
                        modelIcon(model)
                            .frame(width: 44, height: 44)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.label)
                                .font(.headline)
                                .fontWeight(.semibold)
                                .foregroundStyle(.primary)
                                .lineLimit(1)

                            Text(model.subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.78)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                    .background {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(
                                selectedModel == model
                                    ? modelAccent(model).opacity(colorScheme == .dark ? 0.16 : 0.08)
                                    : .clear
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(
                                        selectedModel == model
                                            ? modelAccent(model).opacity(0.35)
                                            : .clear,
                                        lineWidth: selectedModel == model ? 1.5 : 0
                                    )
                            }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        .disabled(isBusy)
    }

    @ViewBuilder
    private func modelIcon(_ model: ESRGANEngine.Model) -> some View {
        switch model {
        case .x4:
            ZStack(alignment: .topTrailing) {
                Image(systemName: "photo")
                    .font(.system(size: 34, weight: .medium))
                Image(systemName: "sparkles")
                    .font(.system(size: 17, weight: .bold))
                    .offset(x: 7, y: -7)
            }
            .foregroundStyle(ShiyanTheme.accent)

        case .x4anime:
            Image("animeEnhancementIcon")
                .resizable()
                .scaledToFit()
                .padding(1)
        }
    }

    private var enhanceButton: some View {
        HStack(spacing: 10) {
            Button {
                guard let img = inputImage else { return }
                progressValue = 0
                enhanceTask = Task { await runEnhance(img) }
            } label: {
                HStack {
                    ShiyanFeaturePage.enhance.icon.frame(width: 20, height: 20)
                    Text(isProcessing ? "增强中…" : "开始增强")
                }
                .font(.headline)
                .foregroundStyle(inputImage == nil || isBusy ? Color.secondary : Color.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(
                    inputImage == nil || isBusy ? Color.primary.opacity(0.045) : modelAccent(selectedModel).opacity(0.85),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                )
            }
            .buttonStyle(.plain)
            .disabled(isBusy || inputImage == nil)
            .accessibilityIdentifier("photo-start-enhance")
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: EnhanceButtonHeightPreferenceKey.self,
                        value: proxy.size.height
                    )
                }
            }
            .onPreferenceChange(EnhanceButtonHeightPreferenceKey.self) { height in
                guard height > 0, abs(enhanceButtonHeight - height) > 0.5 else { return }
                enhanceButtonHeight = height
            }

            resultSaveButton

            if isProcessing {
                stopButton
            }
        }
    }

    @ViewBuilder
    private var resultSaveButton: some View {
        if outputImage != nil && !isBusy {
            Button {
                startSaving()
            } label: {
                Group {
                    if isSaving {
                        ProgressView()
                    } else {
                        Image(systemName: "square.and.arrow.down")
                    }
                }
                .font(.title3)
                .foregroundStyle(isSaving ? Color.secondary : Color.primary)
                .frame(width: enhanceButtonHeight, height: enhanceButtonHeight)
                .shiyanGlass(
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous),
                    tint: .white.opacity(0.08)
                )
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityLabel(isSaving ? "保存中" : "保存结果")
        }
    }

    private var stopButton: some View {
        Button {
            enhanceTask?.cancel()
            isProcessing = false
            progressValue = 0
            withAnimation(.default) { scanPhase = 0 }
        } label: {
            Image(systemName: "stop.circle.fill")
                .font(.title2)
                .foregroundColor(.red)
                .frame(width: enhanceButtonHeight, height: enhanceButtonHeight)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("取消")
    }

     

    private var resultLabel: String { "增强" }
    private var activeAccent: Color { modelAccent(selectedModel) }

    private func scanOffset(_ height: CGFloat) -> CGFloat {
        (scanPhase * (height + 160)) - 80
    }

    private func modelAccent(_ model: ESRGANEngine.Model) -> Color {
        model == .x4anime ? ShiyanTheme.animeAccent : ShiyanTheme.accent
    }

    private func loadImage(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let uiImage = UIImage(data: data),
              let rawImage = uiImage.normalizedForEditing(maxDimension: 3000).normalizedCGImage else {
            await MainActor.run { showToastMessage("无法读取图片，请重试") }
            return
        }

        await MainActor.run {
            if max(rawImage.width, rawImage.height) > 2000 {
                pendingImage = rawImage
                largeImageAlert = true
            } else {
                acceptInputImage(rawImage)
            }
            selectedPhoto = nil
        }
    }

    private func acceptInputImage(_ image: CGImage) {
        inputImage = image
        outputImage = nil
        outputFilename = nil
        showOriginal = false

        let counter = UserDefaults.standard.integer(forKey: "saveCounter") + 1
        UserDefaults.standard.set(counter, forKey: "saveCounter")
        originalFilename = String(format: "IMG_%04d", counter)
    }

    private func runEnhance(_ img: CGImage) async {
        isProcessing = true
         
         
        let processingModel = selectedModel
        let filename = ShiyanEnhancedFilename.jpegName(originalFilename, modelName: processingModel.label)
        let result = await engine.enhance(img, model: processingModel) { p in
            progressValue = p
        }

        guard !Task.isCancelled else {
            isProcessing = false
            progressValue = 0
            withAnimation(.default) { scanPhase = 0 }
            return
        }

        outputImage = result
        outputFilename = result == nil ? nil : filename
        isProcessing = false
        progressValue = 0
        withAnimation(.default) { scanPhase = 0 }

        if let result {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            history.add(filename: filename, modelName: processingModel.label, image: result)
        } else {
            showToastMessage("增强失败，请重试")
        }
    }

    private func startSaving() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            await saveToPhotos()
            isSaving = false
        }
    }

    private func saveToPhotos() async {
        guard let img = outputImage, let filename = outputFilename else { return }
        let jpegData = await Task.detached(priority: .utility) {
            UIImage(cgImage: img).jpegData(compressionQuality: 0.95)
        }.value
        guard let jpegData else {
            await MainActor.run { showToastMessage("图片编码失败") }
            return
        }

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let auth: Bool
        if status == .notDetermined {
            auth = await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized
        } else {
            auth = status == .authorized || status == .limited
        }
        guard auth else {
            await MainActor.run { showToastMessage("无相册权限") }
            return
        }

        let success = await withCheckedContinuation { continuation in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = filename
                request.addResource(with: .photo, data: jpegData, options: options)
            } completionHandler: { success, _ in
                continuation.resume(returning: success)
            }
        }

        await MainActor.run {
            toastMessage = success ? "保存成功" : "保存失败"
            toastIsError = !success
            showToast = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                showToast = false
            }
        }
    }

    private func showToastMessage(_ msg: String) {
#if DEBUG
        NSLog("[ShiyanPhotoError] %@", msg)
#endif
        toastMessage = msg
        toastIsError = true
        showToast = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            showToast = false
        }
    }
}

