import SwiftUI
import UIKit

struct CompareView: View {
    let before: CGImage, after: CGImage
    @Environment(\.dismiss) var dismiss
    @State private var fullScreenImage: CGImage?

    private var useVertical: Bool { before.width >= before.height }

    var body: some View {
        NavigationStack {
            Group {
                if useVertical {
                    VStack(spacing: 0) {
                        imageBlock("原图", image: before)
                        Divider()
                        imageBlock("增强", image: after)
                    }
                } else {
                    HStack(spacing: 0) {
                        imageBlock("原图", image: before)
                        Divider()
                        imageBlock("增强", image: after)
                    }
                }
            }
            .navigationTitle("对比")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ShiyanCloseButton(action: { dismiss() }, inToolbar: true)
                }
            }
            .fullScreenCover(item: $fullScreenImage) { img in
                ZStack {
                    Color.black.ignoresSafeArea()
                    ZoomableImageView(image: img, showControls: .constant(true), bg: .black)
                        .ignoresSafeArea()
                    VStack {
                        HStack {
                            Spacer()
                            ShiyanCloseButton(
                                action: { fullScreenImage = nil },
                                foreground: .white,
                                tint: .black.opacity(0.28)
                            )
                        }
                        .padding(.horizontal, 16).padding(.top, 58)
                        Spacer()
                    }
                }
            }
        }
    }

    private func imageBlock(_ label: String, image: CGImage) -> some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption)
                .fontWeight(.medium)
                .foregroundStyle(ShiyanTheme.accentDeep)
            Image(decorative: image, scale: 1.0)
                .resizable().aspectRatio(contentMode: .fit)
                .clipShape(Rectangle())
                .onTapGesture { fullScreenImage = image }
            Text("\(image.width)×\(image.height)")
                .font(.caption2).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
    }
}

extension CGImage: @retroactive Identifiable {
    public var id: Int { hashValue }
}
