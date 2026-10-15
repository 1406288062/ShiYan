import Foundation

 
 
enum AgentSlingGestureMath {
    static let horizontalDeadZone: CGFloat = 5
    static let pullThreshold: CGFloat = 36
    static let pullReleaseThreshold: CGFloat = 28

    static func modelPosition(start: CGFloat, translation: CGFloat, step: CGFloat, count: Int) -> CGFloat {
        guard count > 1 else { return 0 }
        let magnitude = max(0, abs(translation) - horizontalDeadZone)
        let travel = translation < 0 ? -magnitude : magnitude
        return min(max(start + travel / max(step, 1), 0), CGFloat(count - 1))
    }

    static func modelIndex(position: CGFloat, previous: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        let candidate = min(max(Int(position.rounded()), 0), count - 1)
         
        if candidate > previous, position < CGFloat(previous) + 0.56 { return previous }
        if candidate < previous, position > CGFloat(previous) - 0.56 { return previous }
        return candidate
    }

     
    static func highAnchor(levels: [String], fallback: String) -> String {
        supportedEffort("high", levels: levels, fallback: fallback)
    }

    static let effortStride: CGFloat = 32
    static let effortHysteresis: CGFloat = 8
    static func effortOffset(pull: CGFloat, previous: Int = 0) -> Int {
        guard pull.isFinite else { return 0 }
        let magnitude = abs(pull)
        let direction = pull < 0 ? 1 : -1
        let candidate = magnitude < pullThreshold ? 0
            : min(6, 1 + Int((min(magnitude, 1000) - pullThreshold) / effortStride))
        if previous != 0, (previous > 0) == (direction > 0), candidate < abs(previous) {
            let exitThreshold = pullThreshold + CGFloat(abs(previous) - 1) * effortStride - effortHysteresis
            if magnitude >= exitThreshold { return previous }
        }
        return candidate * direction
    }

    static func anchoredEffort(offset: Int, levels: [String], fallback: String) -> String {
        steppedEffort(highAnchor(levels: levels, fallback: fallback),
                      delta: offset, levels: levels, fallback: fallback)
    }

    static func supportedEffort(_ effort: String, levels: [String], fallback: String) -> String {
        guard !levels.isEmpty else { return fallback }
        if levels.contains(effort) { return effort }
        let ranking = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        guard let desired = ranking.firstIndex(of: effort) else {
            return levels.contains(fallback) ? fallback : levels[0]
        }
        let known = levels.compactMap { value -> (String, Int)? in
            guard let rank = ranking.firstIndex(of: value) else { return nil }
            return (value, rank)
        }
        return known.min { abs($0.1 - desired) < abs($1.1 - desired) }?.0
            ?? (levels.contains(fallback) ? fallback : levels[0])
    }

    static func steppedEffort(_ effort: String, delta: Int, levels: [String], fallback: String) -> String {
        let base = supportedEffort(effort, levels: levels, fallback: fallback)
        guard let index = levels.firstIndex(of: base) else { return base }
        return levels[min(max(index + delta, 0), levels.count - 1)]
    }

    static func elasticLoad(_ pull: CGFloat) -> CGFloat {
        let magnitude = abs(pull)
        return magnitude / (magnitude + 54)
    }
}

 
 
enum AgentModelPowerOrder {
    private static let ranks: [String: Int] = [
        "gpt-5.6-luna": 10, "gpt-5.6-terra": 20,
        "gpt-6-luna": 30, "gpt-5.6-sol": 40,
        "gpt-6-sol": 50, "gpt-6.1-sol": 60, "gpt-6-astra": 70
    ]
    static func isRanked(_ id: String) -> Bool { ranks[id] != nil }
    static func indices(for ids: [String]) -> [Int] {
        let knownSlots = ids.indices.filter { ranks[ids[$0]] != nil }
        let ranked = knownSlots.sorted {
            let a = ranks[ids[$0]] ?? 0, b = ranks[ids[$1]] ?? 0
            return a == b ? $0 < $1 : a < b
        }
        var result = Array(ids.indices)
         
        for (slot, index) in zip(knownSlots, ranked) { result[slot] = index }
         
        if let position = result.firstIndex(where: { ids[$0] == "gpt-5.6-sol" }) {
            result.insert(result.remove(at: position), at: 0)
        }
        return result
    }
}

 
 
enum AgentRubberBandGeometry {
    static let maximumBend: CGFloat = 24
    static let straightSteps = 20
    static let capSteps = 20
    static func displacement(pull: CGFloat) -> CGFloat {
        guard pull.isFinite else { return 0 }
        return (pull < 0 ? -1 : 1) * maximumBend * AgentSlingGestureMath.elasticLoad(pull)
    }
    static func centerOffset(x: CGFloat, width: CGFloat, focus: CGFloat, bend: CGFloat) -> CGFloat {
        guard x.isFinite, width.isFinite, width > 0, focus.isFinite, bend.isFinite else { return 0 }
        let t = min(max(x / width, 0), 1)
        let peak = min(max(focus, 0.18), 0.82)
        let phase = t <= peak ? t / peak : (1 - t) / (1 - peak)
        let smooth = phase * phase * (3 - 2 * phase)
        return min(max(bend, -maximumBend), maximumBend) * smooth
    }
    static func slope(x: CGFloat, width: CGFloat, focus: CGFloat, bend: CGFloat) -> CGFloat {
        guard x.isFinite, width.isFinite, width > 0, focus.isFinite, bend.isFinite else { return 0 }
        let t = min(max(x / width, 0), 1)
        let peak = min(max(focus, 0.18), 0.82)
        let rising = t <= peak
        let phase = rising ? t / peak : (1 - t) / (1 - peak)
        let span = width * (rising ? peak : 1 - peak)
        return min(max(bend, -maximumBend), maximumBend) * 6 * phase * (1 - phase)
            / span * (rising ? 1 : -1)
    }
     
     
     
    static func upperEdgeSample(x: CGFloat, width: CGFloat, height: CGFloat,
                                focus: CGFloat, bend: CGFloat) -> (y: CGFloat, slope: CGFloat) {
        guard x.isFinite, width.isFinite, width > 0, height.isFinite, height > 0,
              focus.isFinite, bend.isFinite else { return (0, 0) }
        let radius = min(height / 2, width / 2)
        let span = width - 2 * radius
        guard span > 0 else { return (centerOffset(x: width / 2, width: width, focus: focus, bend: bend), 0) }
        let sampleX = min(max(x, radius), width - radius)
        let count = straightSteps
        let step = span / CGFloat(count)
        let index = min(max(Int((sampleX - radius) / step), 0), count - 1)
        func outlinePoint(_ index: Int) -> CGPoint {
            let px: CGFloat
            let py: CGFloat
            if index < 0 {
                let angle = 1.5 * CGFloat.pi - CGFloat.pi / CGFloat(capSteps)
                px = radius + radius * cos(angle)
                py = height / 2 + radius * sin(angle)
            } else if index > count {
                let angle = -CGFloat.pi / 2 + CGFloat.pi / CGFloat(capSteps)
                px = width - radius + radius * cos(angle)
                py = height / 2 + radius * sin(angle)
            } else {
                px = radius + step * CGFloat(index)
                py = height / 2 - radius
            }
            return CGPoint(x: px, y: py + centerOffset(x: px, width: width, focus: focus, bend: bend))
        }
        let previous = outlinePoint(index - 1)
        let start = outlinePoint(index)
        let end = outlinePoint(index + 1)
        let following = outlinePoint(index + 2)
        let control1 = CGPoint(x: start.x + (end.x - previous.x) / 6,
                               y: start.y + (end.y - previous.y) / 6)
        let control2 = CGPoint(x: end.x - (following.x - start.x) / 6,
                               y: end.y - (following.y - start.y) / 6)
        func cubic(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat, _ t: CGFloat) -> CGFloat {
            let inverse = 1 - t
            return inverse * inverse * inverse * a + 3 * inverse * inverse * t * b
                + 3 * inverse * t * t * c + t * t * t * d
        }
        let t: CGFloat
        if index > 0, index < count - 1 {
             
             
            t = min(max((sampleX - start.x) / step, 0), 1)
        } else {
            var low: CGFloat = 0, high: CGFloat = 1
            for _ in 0..<22 {
                let middle = (low + high) / 2
                if cubic(start.x, control1.x, control2.x, end.x, middle) < sampleX { low = middle }
                else { high = middle }
            }
            t = (low + high) / 2
        }
        let inverse = 1 - t
        let dx = 3 * inverse * inverse * (control1.x - start.x)
            + 6 * inverse * t * (control2.x - control1.x) + 3 * t * t * (end.x - control2.x)
        let dy = 3 * inverse * inverse * (control1.y - start.y)
            + 6 * inverse * t * (control2.y - control1.y) + 3 * t * t * (end.y - control2.y)
        return (cubic(start.y, control1.y, control2.y, end.y, t), abs(dx) > 0.0001 ? dy / dx : 0)
    }

     
     
     
    static func titleAttachment(centerX: CGFloat, textWidth: CGFloat, glassWidth: CGFloat,
                                glassHeight: CGFloat, focus: CGFloat, bend: CGFloat) -> (y: CGFloat, angle: CGFloat) {
        let sample = upperEdgeSample(x: centerX, width: glassWidth, height: glassHeight, focus: focus, bend: bend)
        let angle = atan(sample.slope)
        let half = max(0, textWidth / 2)
        var attachment = sample.y
        for index in 0...32 {
            let offset = -half + 2 * half * CGFloat(index) / 32
            let x = centerX + offset * cos(angle)
            let edge = upperEdgeSample(x: x, width: glassWidth, height: glassHeight, focus: focus, bend: bend).y
            attachment = min(attachment, edge - offset * sin(angle))
        }
        return (attachment, angle)
    }

    static func capsuleOutline(width: CGFloat, height: CGFloat, originX: CGFloat = 0,
                               parentWidth: CGFloat, focus: CGFloat, bend: CGFloat) -> [CGPoint] {
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              originX.isFinite, parentWidth.isFinite, parentWidth > 0,
              focus.isFinite, bend.isFinite else { return [] }
        let radius = min(height / 2, width / 2)
        let center = height / 2
        var points: [CGPoint] = []
        func point(_ x: CGFloat, _ y: CGFloat) {
            points.append(CGPoint(x: x, y: y + centerOffset(x: originX + x,
                width: parentWidth, focus: focus, bend: bend)))
        }
        for i in 0...straightSteps {
            point(radius + (width - 2 * radius) * CGFloat(i) / CGFloat(straightSteps), center - radius)
        }
        for i in 1...capSteps {
            let angle = -.pi / 2 + .pi * CGFloat(i) / CGFloat(capSteps)
            point(width - radius + radius * cos(angle), center + radius * sin(angle))
        }
        for i in 1...straightSteps {
            point(width - radius - (width - 2 * radius) * CGFloat(i) / CGFloat(straightSteps), center + radius)
        }
         
        for i in 1..<capSteps {
            let angle = .pi / 2 + .pi * CGFloat(i) / CGFloat(capSteps)
            point(radius + radius * cos(angle), center + radius * sin(angle))
        }
        return points
    }
}

struct AgentSlingInteraction {
    let startModelPosition: CGFloat
    let initialReasoning: String
    var position: CGFloat
    var modelIndex: Int
    private(set) var pull: CGFloat = 0
    private(set) var previewEffortOffset = 0
    private var verticalAnchor: CGFloat = 0
    private var lastTranslation = CGSize(width: 0, height: 0)
    private var verticalArmed = false
    private(set) var isCancelled = false
    var hasSelectionIntent: Bool { !isCancelled && (verticalArmed || abs(lastTranslation.width) > 8) }

    init(modelIndex: Int, reasoning: String) {
        startModelPosition = CGFloat(modelIndex)
        initialReasoning = reasoning
        position = CGFloat(modelIndex)
        self.modelIndex = modelIndex
    }

    mutating func update(translation: CGSize, step: CGFloat, modelCount: Int) {
        let deltaX = translation.width - lastTranslation.width
        let deltaY = translation.height - lastTranslation.height
         
         
        if !verticalArmed, abs(translation.width) > 8,
           abs(deltaX) > abs(deltaY) * 1.35,
           abs(translation.height - verticalAnchor) < 18 {
            verticalAnchor = translation.height
        }
        pull = translation.height - verticalAnchor
        if abs(pull) >= 20 { verticalArmed = true }
        position = AgentSlingGestureMath.modelPosition(
            start: startModelPosition, translation: translation.width, step: step, count: modelCount)
        modelIndex = AgentSlingGestureMath.modelIndex(position: position, previous: modelIndex, count: modelCount)
        previewEffortOffset = AgentSlingGestureMath.effortOffset(pull: pull, previous: previewEffortOffset)
        lastTranslation = translation
    }

    func effortForRelease(levels: [String], fallback: String) -> String? {
        guard hasSelectionIntent, !levels.isEmpty else { return nil }
        return AgentSlingGestureMath.anchoredEffort(offset: previewEffortOffset, levels: levels, fallback: fallback)
    }
    mutating func cancel() { isCancelled = true }
}
