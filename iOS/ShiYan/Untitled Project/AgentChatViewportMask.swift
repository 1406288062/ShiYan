import SwiftUI

 
 
 
struct AgentChatFadeGeometry {
    var topGone: CGFloat
    var topClear: CGFloat
    var bottomClear: CGFloat
    var bottomGone: CGFloat
    var bottomTailEnd: CGFloat? = nil

     
    static let fadeExponent = 3.15
    static let topEdgeOpacity = 1.0
    static let bottomEdgeOpacity = 1.0
    static let bottomTailOpacity = 1.0

     
     
    static func chat(top: CGFloat, bottom: CGFloat, composerHeight: CGFloat,
                     height: CGFloat) -> AgentChatFadeGeometry {
        let composerTop = height - bottom - composerHeight
        return AgentChatFadeGeometry(
            topGone: max(8, top * 0.45), topClear: top + 95,
            bottomClear: composerTop, bottomGone: composerTop + 26,
            bottomTailEnd: height)
    }

     
     
     
    func blurCoverage(at y: CGFloat, edge: AgentChatBlurEdge) -> CGFloat {
        guard y.isFinite, topGone.isFinite, topClear.isFinite,
              bottomClear.isFinite, bottomGone.isFinite,
              topGone < topClear, topClear < bottomClear,
              bottomClear < bottomGone else { return 0 }
        switch edge {
        case .top:
            return 0  
        case .bottom:
            return 0  
        }
    }

    func blurStops(edge: AgentChatBlurEdge, height: CGFloat) -> [AgentChatBlurStop] {
        let origin: CGFloat = edge == .top ? 0 : bottomClear
        let end = edge == .top ? topClear : height
        guard origin.isFinite, end.isFinite, end > origin else { return [] }
        let junction = edge == .top ? topGone : bottomGone
        var positions = (0...48).map { origin + (end - origin) * CGFloat($0) / 48 }
        positions.append(min(max(junction, origin), end))
        return Array(Set(positions)).sorted().map {
            AgentChatBlurStop(location: ($0 - origin) / (end - origin),
                             coverage: blurCoverage(at: $0, edge: edge))
        }
    }

    private var resolvedBottomTailEnd: CGFloat {
        guard let end = bottomTailEnd, end.isFinite, end > bottomGone else {
            return bottomGone + 32
        }
        return end
    }

    private func smooth(_ a: CGFloat, _ b: CGFloat, _ x: CGFloat) -> Double {
        let t = min(max((x - a) / max(b - a, 1), 0), 1)
        return Double(t * t * (3 - 2 * t))
    }

    func visibility(at y: CGFloat) -> Double {
        guard y.isFinite, topGone.isFinite, topClear.isFinite,
              bottomClear.isFinite, bottomGone.isFinite else { return 1 }

         
         
        return 1.0
    }

    func stops(height: CGFloat) -> [Gradient.Stop] {
        guard height.isFinite, height > 0 else {
            return [.init(color: .black, location: 0), .init(color: .black, location: 1)]
        }
        var positions: [CGFloat] = [0, height]
         
         
        for i in 0...32 {
            let t = CGFloat(i) / 32
            positions.append(topGone + (topClear - topGone) * t)
            positions.append(bottomClear + (bottomGone - bottomClear) * t)
            positions.append(bottomGone + (resolvedBottomTailEnd - bottomGone) * t)
        }
        return Array(Set(positions.filter(\.isFinite).map { min(max($0, 0), height) })).sorted().map {
            Gradient.Stop(color: .black.opacity(visibility(at: $0)), location: $0 / height)
        }
    }
}

struct AgentChatViewportMask: View {
    let geometry: AgentChatFadeGeometry
    var body: some View {
        GeometryReader { proxy in
            LinearGradient(stops: geometry.stops(height: proxy.size.height),
                           startPoint: .top, endPoint: .bottom)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

 
enum AgentChatBlurEdge { case top, bottom }
struct AgentChatBlurStop: Equatable {
    let location: CGFloat
    let coverage: CGFloat
}
