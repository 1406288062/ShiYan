import Foundation
import SwiftUI

 
 
@main enum V2ViewportFadeTests {
    static func main() {
        var count = 0
        func expect(_ condition: Bool, _ name: String) {
            guard condition else { fputs("FAIL: \(name)\n", stderr); exit(1) }
            count += 1
            print("PASS: \(name)")
        }
        let screens: [(name: String, height: CGFloat, top: CGFloat, bottom: CGFloat, composer: CGFloat)] = [
            ("phone", 874, 62, 34, 64),
            ("small-phone", 667, 20, 0, 64),
            ("keyboard-multiline", 540, 62, 8, 210),
            ("tablet", 1194, 24, 20, 94)
        ]
        for screen in screens {
            let g = AgentChatFadeGeometry.chat(top: screen.top, bottom: screen.bottom,
                composerHeight: screen.composer, height: screen.height)
            expect(g.topClear == screen.top + 95, "\(screen.name): 20pt top lead remains configured")
            expect(g.bottomClear == screen.height - screen.bottom - screen.composer,
                   "\(screen.name): composer remains the bottom boundary")
            for i in 0...100 {
                let y = CGFloat(i) / 100 * screen.height
                expect(g.visibility(at: y) == 1, "\(screen.name): glyph opacity stays 1 at sample \(i)")
            }
            expect(g.blurCoverage(at: g.bottomClear, edge: .bottom) == 0,
                   "\(screen.name): legacy bottom glass is disabled")
            expect(g.blurCoverage(at: g.bottomGone, edge: .bottom) == 0,
                   "\(screen.name): no second bottom blur is stacked")
            expect(g.blurCoverage(at: screen.top + 75, edge: .top) == 0,
                   "\(screen.name): no custom top glass is introduced")
            let stops = g.stops(height: screen.height)
            expect(stops.first?.location == 0 && stops.last?.location == 1,
                   "\(screen.name): compatibility mask geometry remains bounded")
            expect((0...32).allSatisfy { i in
                let y = CGFloat(i) / 32 * screen.height
                return g.visibility(at: y) == 1
            }, "\(screen.name): compatibility mask carries no alpha fade")
        }
        let fallback = AgentChatFadeGeometry(topGone: 20, topClear: 100, bottomClear: 700, bottomGone: 750)
        expect(fallback.visibility(at: .nan) == 1, "invalid layout cannot fade glyphs")
        expect(fallback.stops(height: 0).count == 2, "zero-height layout has safe stops")
        print("ALL \(count) EDGE PROFILE ASSERTIONS PASSED (geometry only; no simulator)")
    }
}
