import Foundation

/// Presentation-only state. No transition is allowed to change the voice call.
/// Kept free of SwiftUI so the reversible material path can be tested directly.
struct DotsVoiceMaterialState {
    enum Form: String { case orb, draining, fused, dragging, gathering, returning }
    struct Transition {
        var from: Double
        var to: Double
        var elapsed: Double
        var duration: Double
    }
    private(set) var form: Form = .orb
    private(set) var progress = 0.0 // material already transferred into the composer
    private(set) var transition: Transition?
    private(set) var dragDistance = 0.0
    private(set) var dragOffsetX = 0.0
    private(set) var dragTravel = 175.0
    private(set) var dragStartedAt: Double?
    private(set) var hasRiseOrigin = false
    private(set) var releaseProgress = 1.0

    var isTransitioning: Bool { transition != nil }
    var isRising: Bool { [.dragging, .gathering, .returning].contains(form) }
    var materialAmount: Double {
        form == .draining ? Self.smooth((progress - 0.13) / 0.87) : Self.smooth(progress)
    }
    var lastGrain: (rising: Bool, phase: Double, strength: Double)? {
        guard isRising || form == .draining else { return nil }
        let position = isRising ? 1 - progress : progress
        let start = isRising ? 0.68 : 0.78, peak = isRising ? 0.90 : 0.94
        guard position > start && position < 1 else { return nil }
        return (isRising, Self.smooth((position - start) / (1 - start)),
                Self.smooth((position - start) / (peak - start)) * Self.smooth((1 - position) / (1 - peak)))
    }

    mutating func reset() { self = Self() }

    mutating func collapse(reducedMotion: Bool) {
        guard form == .orb else { return }
        hasRiseOrigin = false
        animate(to: 1, form: .draining, duration: 3.6, reducedMotion: reducedMotion)
    }

    mutating func dragChanged(x: Double, upward: Double, travel: Double, now: Double) {
        guard form == .fused || form == .dragging else { return }
        let distance = max(0, upward)
        guard distance >= 5 || form == .dragging else { return }
        if dragStartedAt == nil { dragStartedAt = now }
        form = .dragging
        hasRiseOrigin = true
        dragDistance = distance
        dragOffsetX = Self.clamp(x, -110, 110) * 0.38
        dragTravel = max(175, travel)
        progress = 1 - Self.clamp(distance / dragTravel)
    }

    mutating func dragEnded(travel: Double, now: Double, cancelled: Bool, reducedMotion: Bool) {
        guard form == .dragging else { return }
        releaseProgress = progress
        let elapsed = max(0, now - (dragStartedAt ?? now))
        dragStartedAt = nil
        if !cancelled && dragDistance >= Self.threshold(travel: travel) {
            if progress == 0 {
                // A full pull already completed formation and placement.
                form = .orb
                transition = nil
                hasRiseOrigin = false
                dragDistance = 0
                dragOffsetX = 0
                return
            }
            animate(to: 0, form: .gathering, duration: max(1.5, 3.6 - min(2.1, elapsed)), reducedMotion: reducedMotion)
        } else {
            animate(to: 1, form: .returning, duration: max(0.55, (1 - progress) * 1.6), reducedMotion: reducedMotion)
        }
    }

    mutating func expandAccessibly(reducedMotion: Bool) {
        guard form == .fused else { return }
        hasRiseOrigin = false
        animate(to: 0, form: .gathering, duration: 3.6, reducedMotion: reducedMotion)
    }

    mutating func advance(seconds: Double) {
        guard var next = transition else { return }
        next.elapsed += max(0, seconds)
        let fraction = Self.clamp(next.elapsed / max(0.001, next.duration))
        progress = next.from + (next.to - next.from) * Self.smooth(fraction)
        if fraction >= 1 {
            progress = next.to
            form = next.to == 1 ? .fused : .orb
            transition = nil
            hasRiseOrigin = false
            dragDistance = 0
            dragOffsetX = 0
        } else { transition = next }
    }

    private mutating func animate(to: Double, form: Form, duration: Double, reducedMotion: Bool) {
        self.form = form
        transition = Transition(from: progress, to: to, elapsed: 0,
                                duration: reducedMotion ? min(duration, 0.8) : duration)
    }
    static func threshold(travel: Double) -> Double { clamp(travel * 0.34, 96, 136) }
    static func clamp(_ value: Double, _ lower: Double = 0, _ upper: Double = 1) -> Double {
        min(upper, max(lower, value))
    }
    static func smooth(_ value: Double) -> Double {
        let x = clamp(value)
        return x * x * (3 - 2 * x)
    }
}
