import Foundation

@main
enum AgentSlingGestureTests {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            guard condition() else { fputs("FAIL \(name)\n", stderr); exit(1) }
            checks += 1
            print("PASS \(name)")
        }
        check(AgentSlingGestureMath.modelPosition(start: 2, translation: 4, step: 50, count: 5) == 2,
              "tap and small motion preserve current model")
        check(AgentSlingGestureMath.modelPosition(start: 2, translation: 55, step: 50, count: 5) == 3,
              "horizontal drag advances continuously by one model")
        check(AgentSlingGestureMath.modelPosition(start: 0, translation: -180, step: 50, count: 5) == 0,
              "left edge clamps")
        check(AgentSlingGestureMath.modelPosition(start: 3, translation: 300, step: 50, count: 5) == 4,
              "right edge clamps")
        check(AgentSlingGestureMath.modelPosition(start: 0, translation: 100, step: 0, count: 1) == 0,
              "single model cannot divide by zero")
        check(AgentSlingGestureMath.modelIndex(position: 1.53, previous: 1, count: 5) == 1,
              "model boundary wobble is latched")
        check(AgentSlingGestureMath.modelIndex(position: 1.58, previous: 1, count: 5) == 2,
              "deliberate model boundary crossing previews next model")
        check(AgentSlingGestureMath.effortOffset(pull: -120) == 3,
              "large upward pull previews every stronger supported tier")
        check(AgentSlingGestureMath.effortOffset(pull: 120) == -3,
              "large downward pull reaches the weakest supported tier")
        check(AgentSlingGestureMath.effortOffset(pull: 10) == 0,
              "tiny vertical wobble preserves high preview")
        check(AgentSlingGestureMath.effortOffset(pull: -22) == 0,
              "short pull stays on visibly previewed high instead of a predicted tier")
        check(AgentSlingGestureMath.effortOffset(pull: 22) == 0,
              "short downward pull stays on high")
        check(AgentSlingGestureMath.effortOffset(pull: -30, previous: 1) == 1,
              "armed tier uses release hysteresis")
        check(AgentSlingGestureMath.effortOffset(pull: -20, previous: 1) == 0,
              "pull can return to the high anchor")
        var horizontal = AgentSlingInteraction(modelIndex: 1, reasoning: "medium")
        for x in stride(from: 10, through: 120, by: 10) {
            horizontal.update(translation: CGSize(width: Double(x), height: x % 20 == 0 ? 5 : 0), step: 50, modelCount: 5)
        }
        check(horizontal.modelIndex == 3, "horizontal leg selects models")
        check(horizontal.previewEffortOffset == 0 && horizontal.effortForRelease(levels: ["low", "medium", "high", "xhigh"], fallback: "low") == "high",
              "horizontal finger jitter keeps the high anchor")
        var combined = AgentSlingInteraction(modelIndex: 0, reasoning: "low")
        combined.update(translation: .init(width: 65, height: 6), step: 50, modelCount: 5)
        combined.update(translation: .init(width: 65, height: -38), step: 50, modelCount: 5)
        check(combined.modelIndex == 1 && combined.previewEffortOffset == 1,
              "one continuous model drag can turn into upward sling")
        check(combined.effortForRelease(levels: ["low", "medium", "high", "xhigh"], fallback: "low") == "xhigh",
              "combined gesture commits complete high-anchored preview")
        var direct = AgentSlingInteraction(modelIndex: 2, reasoning: "high")
        direct.update(translation: .init(width: 0, height: 50), step: 50, modelCount: 5)
        check(direct.modelIndex == 2 && direct.previewEffortOffset == -1,
              "direct downward sling preserves selected model")
        direct.update(translation: .init(width: 0, height: 5), step: 50, modelCount: 5)
        check(direct.previewEffortOffset == 0 && direct.effortForRelease(levels: ["low", "medium", "high"], fallback: "low") == "high",
              "returning finger to origin selects the high anchor")
        check(AgentSlingGestureMath.supportedEffort("ultra", levels: ["low", "medium", "high"], fallback: "low") == "high",
              "model switch maps unsupported effort to closest supported level")
        check(AgentSlingGestureMath.steppedEffort("high", delta: 1, levels: ["low", "medium", "high"], fallback: "low") == "high",
              "upper effort edge clamps")
        check(AgentSlingGestureMath.steppedEffort("low", delta: -1, levels: ["low", "medium", "high"], fallback: "low") == "low",
              "lower effort edge clamps")
        check(AgentSlingGestureMath.steppedEffort("high", delta: 1, levels: [], fallback: "low") == "low",
              "empty capabilities are safe")
        check(AgentSlingGestureMath.elasticLoad(10000) < 1 && AgentSlingGestureMath.elasticLoad(0) == 0,
              "elastic deformation remains bounded")
        let providerIDs = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
                           "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
        let orderedIDs = AgentModelPowerOrder.indices(for: providerIDs).map { providerIDs[$0] }
        check(orderedIDs == ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna",
                             "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"],
              "restored 5.6-Sol is pinned to the far-left slot without reordering others")
        check(orderedIDs.last == "gpt-6-astra"
              && orderedIDs.firstIndex(of: "gpt-6.1-sol")! > orderedIDs.firstIndex(of: "gpt-6-sol")!,
              "frontier endpoint and newer workhorse ordering")
        let withUnknown = ["gpt-6-astra", "custom-model", "gpt-6-luna", "gpt-6.1-sol"]
        let indices = AgentModelPowerOrder.indices(for: withUnknown)
        check(indices[1] == 1 && Set(indices) == Set(withUnknown.indices) && indices.count == withUnknown.count,
              "unknown model keeps its slot and no provider option is lost")
        check(!AgentModelPowerOrder.isRanked("custom-model"), "unknown tier is explicitly marked")
        for focus: CGFloat in [0.18, 0.5, 0.82] {
            for pull: CGFloat in [-200, -36, 0, 36, 200] {
                let bend = AgentRubberBandGeometry.displacement(pull: pull)
                check(AgentRubberBandGeometry.centerOffset(x: 0, width: 337, focus: focus, bend: bend) == 0
                      && AgentRubberBandGeometry.centerOffset(x: 337, width: 337, focus: focus, bend: bend) == 0,
                      "ribbon endpoints remain pinned at focus \(focus), pull \(pull)")
            }
        }
        let justBelow = AgentRubberBandGeometry.displacement(pull: 35.999)
        let justAbove = AgentRubberBandGeometry.displacement(pull: 36.001)
        check(abs(justAbove - justBelow) < 0.001,
              "effort threshold introduces no visual displacement jump")
        check(AgentRubberBandGeometry.displacement(pull: .infinity) == 0
              && AgentRubberBandGeometry.centerOffset(x: 50, width: 0, focus: 0.5, bend: 20) == 0
              && AgentRubberBandGeometry.centerOffset(x: 50, width: 300, focus: .nan, bend: 20) == 0,
              "invalid geometry cannot produce nonfinite coordinates")
        for bend: CGFloat in [-24, -14, 0, 14, 24] {
            let points = AgentRubberBandGeometry.capsuleOutline(width: 337, height: 68,
                parentWidth: 337, focus: 0.5, bend: bend)
            check(!points.isEmpty && points.allSatisfy { $0.x.isFinite && $0.y.isFinite
                && $0.x >= -0.001 && $0.x <= 337.001 && $0.y >= -24.001 && $0.y <= 92.001 },
                "entire outline remains finite within reserved elastic viewport at bend \(bend)")
            let left = points.min { $0.x < $1.x }!
            let right = points.max { $0.x < $1.x }!
            check(abs(left.x) < 0.001 && abs(right.x - 337) < 0.001
                  && abs(left.y - 34) < 0.001 && abs(right.y - 34) < 0.001,
                  "outer cap anchors do not translate at bend \(bend)")
        }
        let sharedWidth: CGFloat = 337, blueWidth: CGFloat = 180, blueHeight: CGFloat = 49
        let blueOrigin: CGFloat = 12.5, ringX = blueOrigin + blueWidth - blueHeight / 2
        let outline = AgentRubberBandGeometry.capsuleOutline(width: blueWidth, height: blueHeight,
            originX: blueOrigin, parentWidth: sharedWidth, focus: 0.5, bend: -20)
        let atRing = outline.filter { abs($0.x - (blueWidth - blueHeight / 2)) < 0.001 }
        let sharedRingY = blueHeight / 2 + AgentRubberBandGeometry.centerOffset(
            x: ringX, width: sharedWidth, focus: 0.5, bend: -20)
        check(atRing.count >= 2 && abs((atRing.map(\.y).min()! + atRing.map(\.y).max()!) / 2 - sharedRingY) < 0.001,
              "blue fill and ring share the glass centerline")
        check(AgentRubberBandGeometry.capsuleOutline(width: 0, height: 68,
              parentWidth: 337, focus: 0.5, bend: 12).isEmpty,
              "zero-size layout safely produces an empty outline")
        if CommandLine.arguments.count > 1 {
            var frames: [[String: Any]] = []
            let width: CGFloat = 337, count = providerIDs.count
            let step = (width - 22 - 52) / CGFloat(count - 1)
            for (label, position, pull) in [("Rest", CGFloat(3), CGFloat(0)),
                                          ("Pull up", CGFloat(3), CGFloat(-90)),
                                          ("Pull down", CGFloat(3), CGFloat(90)),
                                          ("Near end", CGFloat(6), CGFloat(-90))] {
                let x = 11 + 26 + position * step
                let focus = x / width
                let bend = AgentRubberBandGeometry.displacement(pull: pull)
                let glass = AgentRubberBandGeometry.capsuleOutline(width: width, height: 68,
                    parentWidth: width, focus: focus, bend: bend)
                let blueStart: CGFloat = 12.5
                let fill = AgentRubberBandGeometry.capsuleOutline(width: 49 + position * step, height: 49,
                    originX: blueStart, parentWidth: width, focus: focus, bend: bend)
                let dots = (0..<count).map { i -> [Double] in
                    let x = 37 + CGFloat(i) * step
                    return [Double(x), Double(60 + AgentRubberBandGeometry.centerOffset(
                        x: x, width: width, focus: focus, bend: bend))]
                }
                frames.append(["label": label, "width": Double(width), "height": 120,
                    "glass": glass.map { [Double($0.x), Double($0.y + 26)] },
                    "fill": fill.map { [Double($0.x + blueStart), Double($0.y + 35.5)] },
                    "dots": dots, "ring": [Double(x), Double(60 + AgentRubberBandGeometry.centerOffset(
                        x: x, width: width, focus: focus, bend: bend))],
                    "pull": Double(pull), "bend": Double(bend)])
            }
            let data = try! JSONSerialization.data(withJSONObject: frames, options: [.prettyPrinted])
            try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
        }
        let sixLevels = ["low", "medium", "high", "xhigh", "max", "ultra"]
        let fiveLevels = ["low", "medium", "high", "xhigh", "max"]
        for (pull, expected): (CGFloat, String) in [(0, "high"), (-36, "xhigh"), (-68, "max"),
                                                    (-100, "ultra"), (36, "medium"), (68, "low")] {
            let offset = AgentSlingGestureMath.effortOffset(pull: pull)
            check(AgentSlingGestureMath.anchoredEffort(offset: offset, levels: sixLevels, fallback: "low") == expected,
                  "absolute high anchor reaches \(expected) at pull \(pull)")
        }
        check(AgentSlingGestureMath.anchoredEffort(offset: 6, levels: fiveLevels, fallback: "low") == "max",
              "Luna never invents unsupported ultra")
        check(AgentSlingGestureMath.anchoredEffort(offset: -6, levels: sixLevels, fallback: "low") == "low",
              "lower boundary never invents unsupported minimal")
        check(AgentSlingGestureMath.anchoredEffort(offset: -3,
              levels: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"], fallback: "medium") == "minimal",
              "models actually supporting minimal expose it")
        check(AgentSlingGestureMath.highAnchor(levels: ["low", "medium"], fallback: "low") == "medium",
              "a model without high uses the nearest real supported anchor")
        check(AgentSlingGestureMath.effortOffset(pull: -63, previous: 2) == 2
              && AgentSlingGestureMath.effortOffset(pull: -59, previous: 2) == 1,
              "higher tier hysteresis does not chatter near a boundary")
        var absolute = AgentSlingInteraction(modelIndex: 1, reasoning: "low")
        absolute.update(translation: .init(width: 0, height: -105), step: 50, modelCount: 5)
        check(absolute.effortForRelease(levels: sixLevels, fallback: "low") == "ultra",
              "one pull reaches ultra independently of previously saved low")
        var nextGesture = AgentSlingInteraction(modelIndex: 1, reasoning: "ultra")
        nextGesture.update(translation: .init(width: 60, height: 0), step: 50, modelCount: 5)
        check(nextGesture.effortForRelease(levels: sixLevels, fallback: "low") == "high",
              "a new flat model gesture starts from high rather than saved ultra")
        var noSelection = AgentSlingInteraction(modelIndex: 1, reasoning: "ultra")
        noSelection.update(translation: .init(width: 3, height: 4), step: 50, modelCount: 5)
        check(noSelection.effortForRelease(levels: sixLevels, fallback: "low") == nil,
              "incidental motion does not overwrite an existing saved tier")
        var cancelled = AgentSlingInteraction(modelIndex: 1, reasoning: "ultra")
        cancelled.update(translation: .init(width: 60, height: 80), step: 50, modelCount: 5)
        cancelled.cancel()
        check(cancelled.effortForRelease(levels: sixLevels, fallback: "low") == nil
              && cancelled.initialReasoning == "ultra",
              "cancelled gesture cannot produce a persistent selection")
        check(AgentSlingGestureMath.effortOffset(pull: .nan) == 0
              && AgentSlingGestureMath.effortOffset(pull: .infinity) == 0,
              "nonfinite load cannot select an invalid reasoning offset")
        print("\(checks) gesture checks passed")
    }
}
