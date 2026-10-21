import SwiftUI

enum ShiyanTheme {
     
    static let accent: Color = .accentColor
     
    static let animeAccent = Color(red: 1.0, green: 0.42, blue: 0.54)
    static let accentDeep: Color = .primary
    static let panelRadius: CGFloat = 24
}

struct ShiyanGlass<S: Shape>: ViewModifier {
    let shape: S
    let tint: Color?
    let interactive: Bool

    func body(content: Content) -> some View {
        content.glassEffect(
            .regular
                .tint(tint)
                .interactive(interactive),
            in: shape
        )
    }
}

extension View {
    func shiyanGlass<S: Shape>(
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        modifier(ShiyanGlass(shape: shape, tint: tint, interactive: interactive))
    }
}

 
struct ShiyanMoreButtonLabel: View {
    var showsCloseIcon = false
    var isLoading = false
    var hasGlass = true

    var body: some View {
        Group {
            if hasGlass {
                labelContent.shiyanGlass(in: Circle(), tint: .white.opacity(showsCloseIcon ? 0.10 : 0.04), interactive: true)
            } else {
                labelContent
            }
        }
    }

    private var labelContent: some View {
        Group {
            if isLoading { ProgressView().tint(.primary) }
            else {
                Image(systemName: showsCloseIcon ? "xmark" : "ellipsis")
                    .font(.system(size: showsCloseIcon ? 19 : 18, weight: .semibold))
                    .foregroundStyle(.primary)
            }
        }
        .frame(width: ShiyanPreviewLayout.controlDiameter, height: ShiyanPreviewLayout.controlDiameter)
        .contentShape(Circle())
    }
}

 
struct ShiyanMoreMenu<Content: View>: View {
    var showsCloseIcon = false
    var inToolbar = false
    var hasGlass = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        Menu { content() } label: {
            ShiyanMoreButtonLabel(showsCloseIcon: showsCloseIcon, hasGlass: hasGlass)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("更多")
    }
}

 
struct ShiyanCloseButton: View {
    let action: () -> Void
    var foreground: Color = .primary
    var tint: Color = .white.opacity(0.10)
    var inToolbar = false
    var diameter: CGFloat = 36

    var body: some View {
        Group {
            if inToolbar {
                 
                Button(action: action) {
                    closeIcon
                }
                .buttonStyle(.plain)
            } else {
                Button(action: action) {
                    closeIcon
                        .contentShape(Circle())
                        .shiyanGlass(in: Circle(), tint: tint)
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityLabel(Text("关闭"))
    }

    private var closeIcon: some View {
        Image(systemName: "xmark")
            .font(.system(size: inToolbar ? ShiyanPreviewLayout.toolbarIconPointSize : (diameter > 36 ? 19 : 15), weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: inToolbar ? ShiyanPreviewLayout.toolbarContentDiameter : diameter,
                   height: inToolbar ? ShiyanPreviewLayout.toolbarContentDiameter : diameter)
    }
}

 
enum ShiyanPreviewLayout {
     
    static let toolbarContentDiameter: CGFloat = 36
    static let toolbarIconPointSize: CGFloat = 18
    static let controlDiameter: CGFloat = 46
    static var topPadding: CGFloat {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return (windows.first(where: \.isKeyWindow)?.safeAreaInsets.top ?? 59) + 3
    }
    static var toastTopPadding: CGFloat { topPadding + controlDiameter + 14 }
}

 
struct ShiyanPreviewSaveButton: View {
    let isSaving: Bool
    let action: () -> Void
    var accessibilityText = "保存图片"
    var diameter: CGFloat = ShiyanPreviewLayout.controlDiameter

    var body: some View {
        Button(action: action) {
            Group {
                if isSaving {
                    ProgressView().tint(.white)
                } else {
                    ShiyanDownloadTrayIcon()
                }
            }
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .shiyanGlass(in: Circle(), tint: .black.opacity(0.28))
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .accessibilityLabel(accessibilityText)
    }
}


 
private struct ShiyanDownloadTrayIcon: View {
    var body: some View {
        Path { path in
             
            path.move(to: CGPoint(x: 12, y: 1))
            path.addLine(to: CGPoint(x: 12, y: 15.5))
            path.move(to: CGPoint(x: 6.5, y: 10.4))
            path.addLine(to: CGPoint(x: 12, y: 16))
            path.addLine(to: CGPoint(x: 17.5, y: 10.4))

             
            path.move(to: CGPoint(x: 2.75, y: 13))
            path.addLine(to: CGPoint(x: 2.75, y: 20.3))
            path.addQuadCurve(to: CGPoint(x: 4.7, y: 22.25),
                              control: CGPoint(x: 2.75, y: 22.25))
            path.addLine(to: CGPoint(x: 19.3, y: 22.25))
            path.addQuadCurve(to: CGPoint(x: 21.25, y: 20.3),
                              control: CGPoint(x: 21.25, y: 22.25))
            path.addLine(to: CGPoint(x: 21.25, y: 13))
        }
        .stroke(.white, style: StrokeStyle(lineWidth: 2.3, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }
}
