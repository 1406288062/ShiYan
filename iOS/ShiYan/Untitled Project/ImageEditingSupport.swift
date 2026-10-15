import SwiftUI
import UIKit
import Photos

struct RemovalStroke: Identifiable, Equatable {
    let id = UUID()
    var points: [CGPoint]
    var width: CGFloat
}

struct RemovalCanvasOverlay: View {
    @Binding var strokes: [RemovalStroke]
    let brushWidth: CGFloat
    @State private var activeStrokeID: UUID?

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                for stroke in strokes {
                    guard stroke.points.count > 0 else { continue }
                    var path = Path()
                    let first = stroke.points[0]
                    path.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
                    for point in stroke.points.dropFirst() {
                        path.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                    }
                    context.stroke(
                        path,
                        with: .color(ShiyanTheme.animeAccent.opacity(0.62)),
                        style: StrokeStyle(
                            lineWidth: max(8, stroke.width * min(size.width, size.height)),
                            lineCap: .round,
                            lineJoin: .round
                        )
                    )
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let point = CGPoint(
                            x: min(max(value.location.x / max(geometry.size.width, 1), 0), 1),
                            y: min(max(value.location.y / max(geometry.size.height, 1), 0), 1)
                        )
                        if let id = activeStrokeID,
                           let index = strokes.firstIndex(where: { $0.id == id }) {
                            strokes[index].points.append(point)
                        } else {
                            let stroke = RemovalStroke(points: [point], width: brushWidth)
                            strokes.append(stroke)
                            activeStrokeID = stroke.id
                        }
                    }
                    .onEnded { _ in
                        activeStrokeID = nil
                    }
            )
        }
    }
}

enum RemovalMaskRenderer {
    static func maskImage(for image: CGImage, strokes: [RemovalStroke]) -> UIImage? {
        guard !strokes.isEmpty else { return nil }
        let size = CGSize(width: image.width, height: image.height)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)

        return renderer.image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.white.setStroke()

            let cg = context.cgContext
            cg.setLineCap(.round)
            cg.setLineJoin(.round)

            for stroke in strokes {
                guard let first = stroke.points.first else { continue }
                cg.beginPath()
                cg.setLineWidth(max(8, stroke.width * min(size.width, size.height)))
                cg.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
                for point in stroke.points.dropFirst() {
                    cg.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                }
                cg.strokePath()
            }
        }
    }
}

struct GeneratedImagePreview: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var showControls = true
    @State private var isSaving = false
    @State private var showToast = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let cg = image.cgImage {
                ZoomableImageView(image: cg, showControls: $showControls, bg: .black)
                    .ignoresSafeArea()
            } else {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .top) {
            if showControls {
                HStack {
                    ShiyanCloseButton(
                        action: { dismiss() },
                        foreground: .white,
                        tint: .black.opacity(0.28),
                        diameter: ShiyanPreviewLayout.controlDiameter
                    )
                    Spacer()
                    ShiyanPreviewSaveButton(isSaving: isSaving, action: saveImage)
                }
                .padding(.horizontal, 16)
                .padding(.top, ShiyanPreviewLayout.topPadding)
                .transition(.opacity)
            }
        }
        .overlay(alignment: .top) {
            if showToast {
                Text("已保存到照片")
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(.black.opacity(0.72), in: Capsule())
                    .padding(.top, ShiyanPreviewLayout.toastTopPadding)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showControls)
        .animation(.easeInOut(duration: 0.2), value: showToast)
        .ignoresSafeArea(.container)
    }

    private func saveImage() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let success = await PhotoSaver.save(image)
            await MainActor.run {
                isSaving = false
                if success {
                    showToast = true
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(1.5))
                        showToast = false
                    }
                }
            }
        }
    }
}

enum PhotoSaver {
    static func save(_ image: UIImage) async -> Bool {
        guard let data = image.jpegData(compressionQuality: 0.95) else { return false }

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        let allowed: Bool
        if status == .notDetermined {
            allowed = await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized
        } else {
            allowed = status == .authorized || status == .limited
        }
        guard allowed else { return false }

        return await withCheckedContinuation { continuation in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = "ShiYan_\(Int(Date().timeIntervalSince1970)).jpg"
                request.addResource(with: .photo, data: data, options: options)
            } completionHandler: { success, _ in
                continuation.resume(returning: success)
            }
        }
    }
}
