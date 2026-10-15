import SwiftUI

 
private func agentEdgeVisibility(_ y: CGFloat, _ topGone: CGFloat, _ topClear: CGFloat,
                                 _ bottomClear: CGFloat, _ bottomGone: CGFloat) -> Double {
    func smooth(_ a: CGFloat, _ b: CGFloat, _ x: CGFloat) -> CGFloat {
        let t = min(max((x - a) / max(b - a, 1), 0), 1)
        return t * t * (3 - 2 * t)
    }
    return Double(min(smooth(topGone, topClear, y), 1 - smooth(bottomClear, bottomGone, y)))
}

 
 
private struct AgentEdgeTextRenderer: TextRenderer {
    var originY: CGFloat
    let topGone: CGFloat
    let topClear: CGFloat
    let bottomClear: CGFloat
    let bottomGone: CGFloat
    let reduceTransparency: Bool
    var animatableData: CGFloat { get { originY } set { originY = newValue } }
    var displayPadding: EdgeInsets { EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10) }
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            let y = originY + line.typographicBounds.rect.midY
            let visibility = agentEdgeVisibility(y, topGone, topClear, bottomClear, bottomGone)
            guard visibility > 0.001 else { continue }
            var lineContext = context
            if !reduceTransparency { lineContext.addFilter(.blur(radius: 8 * (1 - visibility))) }
            lineContext.draw(line)
        }
    }
}

struct AgentEdgeFade: ViewModifier {
    let space: String
    let topGone: CGFloat
    let topClear: CGFloat
    var bottomClear: CGFloat = 100000
    var bottomGone: CGFloat = 100100
    var blurWholeRow = false
    @State private var frame: CGRect = .zero
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        Group {
            if blurWholeRow {
                 
                content.compositingGroup()
                    .blur(radius: reduceTransparency ? 0 : 8 * (1 - agentEdgeVisibility(frame.midY, topGone, topClear, bottomClear, bottomGone)))
            } else {
                content.textRenderer(AgentEdgeTextRenderer(originY: frame.minY, topGone: topGone, topClear: topClear,
                    bottomClear: bottomClear, bottomGone: bottomGone, reduceTransparency: reduceTransparency))
            }
        }
            .mask {
                GeometryReader { geometry in
                    LinearGradient(stops: (0...32).map { n in
                        let location = CGFloat(n) / 32
                        let visibility = agentEdgeVisibility(frame.minY + geometry.size.height * location, topGone, topClear, bottomClear, bottomGone)
                        return Gradient.Stop(color: .black.opacity(visibility), location: location)
                    }, startPoint: .top, endPoint: .bottom)
                }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(space)) } action: { value in
                if abs(value.minY-frame.minY) > 0.25 || value.size != frame.size { frame = value }
            }
    }
}

extension View {
    func agentEdgeFade(space: String, topGone: CGFloat, topClear: CGFloat,
                       bottomClear: CGFloat = 100000, bottomGone: CGFloat = 100100, blurWholeRow: Bool = false) -> some View {
        modifier(AgentEdgeFade(space: space, topGone: topGone, topClear: topClear, bottomClear: bottomClear, bottomGone: bottomGone, blurWholeRow: blurWholeRow))
    }
}
