import SwiftUI
import UIKit

 
struct AgentNewChatPullObserver: UIViewRepresentable {
    var enabled: Bool
    var topExclusion: CGFloat
    var conversationID: UUID?
    var began: () -> Void
    var changed: (CGFloat) -> Void
    var ended: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.isUserInteractionEnabled = false
        probe.backgroundColor = .clear
        probe.resolve = { [weak coordinator = context.coordinator] view in coordinator?.attach(from: view) }
        return probe
    }
    func updateUIView(_ view: Probe, context: Context) {
        let coordinator = context.coordinator
        if coordinator.conversationID != conversationID || (coordinator.enabled && !enabled) { coordinator.cancel(notify: false) }
        coordinator.enabled = enabled
        coordinator.topExclusion = topExclusion
        coordinator.conversationID = conversationID
        coordinator.began = began
        coordinator.changed = changed
        coordinator.ended = ended
         
        view.resolve?(view)
    }
    static func dismantleUIView(_ view: Probe, coordinator: Coordinator) {
        view.resolve = nil
        coordinator.detach(notify: false)
    }

    final class Probe: UIView {
        var resolve: ((UIView) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); resolve?(self) }
        override func didMoveToSuperview() { super.didMoveToSuperview(); resolve?(self) }
        override func layoutSubviews() { super.layoutSubviews(); resolve?(self) }
    }

    final class Coordinator: NSObject {
        var enabled = false
        var topExclusion: CGFloat = 0
        var conversationID: UUID?
        var began: () -> Void = {}
        var changed: (CGFloat) -> Void = { _ in }
        var ended: (Bool) -> Void = { _ in }
        private weak var scrollView: UIScrollView?
        private var tracking = false

        func attach(from view: UIView) {
            var ancestor = view.superview
            while let candidate = ancestor {
                if let scroll = candidate as? UIScrollView {
                    guard scrollView !== scroll else { return }
                    detach(notify: false)
                    scrollView = scroll
                    scroll.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
                    return
                }
                ancestor = candidate.superview
            }
        }
        func cancel(notify: Bool = true) {
            guard tracking else { return }
            tracking = false
            if notify { ended(true) }
        }
        func detach(notify: Bool = true) {
            cancel(notify: notify)
            scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(panned(_:)))
            scrollView = nil
        }
        @objc private func panned(_ pan: UIPanGestureRecognizer) {
            guard let scroll = scrollView else { return }
            let translation = pan.translation(in: scroll.window)
            switch pan.state {
            case .began:
                let bottom = max(-scroll.adjustedContentInset.top,
                                 scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                let point = pan.location(in: scroll)
                let windowPoint = pan.location(in: scroll.window)
                let velocity = pan.velocity(in: scroll.window)
                guard enabled, abs(scroll.contentOffset.y - bottom) <= 14,
                      windowPoint.y > topExclusion,
                      velocity.y < 0, abs(velocity.y) > abs(velocity.x) * 1.2 else { return }
                var touched = scroll.hitTest(point, with: nil)
                while let view = touched, view !== scroll {
                    if view is UIControl { return }
                    if let text = view as? UITextView, text.selectedRange.length > 0 { return }
                    touched = view.superview
                }
                tracking = true
                began()
                changed(max(0, -translation.y))
            case .changed:
                guard tracking else { return }
                guard enabled, abs(translation.x) <= max(14, abs(translation.y) * 0.85) else { cancel(); return }
                changed(max(0, -translation.y))
            case .ended:
                guard tracking else { return }
                tracking = false
                guard enabled else { ended(true); return }
                changed(max(0, -translation.y))
                ended(false)
            case .cancelled, .failed:
                cancel()
            default: break
            }
        }
    }
}

struct AgentNewChatPullIndicator: View {
    let progress: Double
    let reveal: Double
    let ready: Bool
    let reduceMotion: Bool
    private let blue = Color(.sRGB, red: 64 / 255, green: 101 / 255, blue: 231 / 255, opacity: 1)
    private let track = Color(.sRGB, red: 212 / 255, green: 221 / 255, blue: 250 / 255, opacity: 1)

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().fill(blue)
                    .frame(width: 44, height: 44)
                    .scaleEffect(ready ? 1 : 34.0 / 44)
                    .opacity(ready ? 1 : 0)
                ZStack {
                    Circle().stroke(track, lineWidth: 2.7)
                    Circle().trim(from: 0, to: progress)
                        .stroke(blue, style: StrokeStyle(lineWidth: 2.7, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }.frame(width: 31.3, height: 31.3)
                    .opacity(ready ? 0 : 1)
                    .scaleEffect(ready ? 1.18 : 1)
                AgentNewChatWriteIcon()
                    .stroke(.white, style: StrokeStyle(lineWidth: 1.63, lineCap: .round, lineJoin: .round))
                    .frame(width: 16.3, height: 16.3)
                    .scaleEffect(ready ? 1 : 0.55)
                    .opacity(ready ? 1 : 0)
                    .blur(radius: reduceMotion || ready ? 0 : 3)
            }.frame(width: 48, height: 48)
            Text("New chat")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color(.sRGB, red: 143 / 255, green: 143 / 255, blue: 143 / 255, opacity: 1))
                .scaleEffect(ready ? 1 : 0.94)
        }
        .scaleEffect(reduceMotion ? 1 : 0.46 + 0.54 * reveal, anchor: .bottom)
        .blur(radius: reduceMotion ? 0 : 7 * (1 - reveal))
        .opacity(reveal)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ready ? "松手创建新聊天" : "上滑创建新聊天")
        .accessibilityValue(ready ? "已就绪" : "\(Int(progress * 100))%")
        .accessibilityIdentifier("agent-pull-new-chat-indicator")
    }
}

 
private struct AgentNewChatWriteIcon: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 19, y: 2.7)); p.addLine(to: CGPoint(x: 10.5, y: 2.7))
        p.addCurve(to: CGPoint(x: 2.7, y: 10.5), control1: CGPoint(x: 5.8, y: 2.7), control2: CGPoint(x: 2.7, y: 5.8))
        p.addLine(to: CGPoint(x: 2.7, y: 37.2))
        p.addCurve(to: CGPoint(x: 10.5, y: 45.1), control1: CGPoint(x: 2.7, y: 42), control2: CGPoint(x: 5.8, y: 45.1))
        p.addLine(to: CGPoint(x: 37.2, y: 45.1))
        p.addCurve(to: CGPoint(x: 45.1, y: 37.2), control1: CGPoint(x: 42, y: 45.1), control2: CGPoint(x: 45.1, y: 42))
        p.addLine(to: CGPoint(x: 45.1, y: 29.9))
        p.move(to: CGPoint(x: 16.1, y: 31.6)); p.addLine(to: CGPoint(x: 18.2, y: 23.4))
        p.addQuadCurve(to: CGPoint(x: 20.2, y: 20.2), control: CGPoint(x: 18.6, y: 21.8))
        p.addLine(to: CGPoint(x: 36.6, y: 3.8))
        p.addCurve(to: CGPoint(x: 44.3, y: 3.9), control1: CGPoint(x: 39.1, y: 1.3), control2: CGPoint(x: 41.8, y: 1.4))
        p.addCurve(to: CGPoint(x: 44.2, y: 11.6), control1: CGPoint(x: 46.8, y: 6.4), control2: CGPoint(x: 46.7, y: 9.1))
        p.addLine(to: CGPoint(x: 27.8, y: 28))
        p.addQuadCurve(to: CGPoint(x: 24.6, y: 30), control: CGPoint(x: 26.2, y: 29.6))
        p.addLine(to: CGPoint(x: 16.1, y: 32.1)); p.closeSubpath()
        return p.applying(CGAffineTransform(scaleX: rect.width / 48, y: rect.height / 48)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}
