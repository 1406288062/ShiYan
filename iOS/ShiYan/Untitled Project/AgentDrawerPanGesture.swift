import SwiftUI
import UIKit

 
 
struct AgentDrawerPanGesture: UIGestureRecognizerRepresentable {
    var progress: CGFloat
    var excludedFrame: CGRect
    var changed: (CGFloat) -> Void
    var ended: (CGFloat, CGFloat, Bool) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.cancelsTouchesInView = true
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        context.coordinator.progress = progress
        context.coordinator.excludedFrame = excludedFrame
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator(progress: progress, excludedFrame: excludedFrame)
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
         
        let translation = pan.translation(in: nil).x
        switch pan.state {
        case .began, .changed:
            changed(translation)
        case .ended:
            ended(translation, pan.velocity(in: nil).x, false)
        case .cancelled, .failed:
            ended(translation, 0, true)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var progress: CGFloat
        var excludedFrame: CGRect

        init(progress: CGFloat, excludedFrame: CGRect) {
            self.progress = progress
            self.excludedFrame = excludedFrame
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            traceTouch(touch)
             
             
             
             
             
            guard excludedFrame.isEmpty || !excludedFrame.contains(touch.location(in: touch.window)) else { return false }
            var view = touch.view
            while let current = view {
                if let textView = current as? UITextView, textView.selectedRange.length > 0 {
                    return false
                }
                view = current.superview
            }
            return true
        }

        private func traceTouch(_ touch: UITouch) {
#if DEBUG
            guard ProcessInfo.processInfo.environment["SHIYAN_UI_TEST_CHAT_REPAIR"] != nil else { return }
            let point = touch.location(in: touch.window)
            var chain: [String] = []; var view = touch.view
            while let current = view, chain.count < 9 { chain.append(String(describing: type(of: current))); view = current.superview }
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("chat-repair-touch-events.json")
            var values = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
            values.append(["time": Date().timeIntervalSince1970, "point": [Double(point.x), Double(point.y)], "viewChain": chain, "drawer": Double(progress)])
            if let data = try? JSONSerialization.data(withJSONObject: Array(values.suffix(150))) { try? data.write(to: url, options: .atomic) }
#endif
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: nil)
            guard abs(velocity.x) > abs(velocity.y) * 1.2 else { return false }
            if progress <= 0.001 { return velocity.x > 0 }
            if progress >= 0.999 { return velocity.x < 0 }
            return true
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
             
             
            otherGestureRecognizer is UIPanGestureRecognizer ||
                otherGestureRecognizer is UILongPressGestureRecognizer ||
                otherGestureRecognizer is UITapGestureRecognizer
        }
    }
}
