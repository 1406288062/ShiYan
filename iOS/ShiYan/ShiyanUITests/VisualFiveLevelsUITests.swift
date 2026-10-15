import XCTest
import UIKit

 
final class VisualFiveLevelsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFiveSliderStopsAndBlueEndPositions() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25))

        let gauge = app.buttons["agent-animated-small-gauge"]
        XCTAssertTrue(gauge.waitForExistence(timeout: 8))
        gauge.tap()
        let slider = app.otherElements.matching(
            NSPredicate(format: "label == %@", "推理档位")).firstMatch
        XCTAssertTrue(slider.waitForExistence(timeout: 8), app.debugDescription)

        var blueEnds = [Int]()
        var titles = [String]()
        for (i, x) in [0.10, 0.30, 0.50, 0.70, 0.90].enumerated() {
            slider.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
            Thread.sleep(forTimeInterval: 0.30)
            let title = app.staticTexts["reasoning-current-title"]
            XCTAssertTrue(title.exists)
            titles.append(title.label)
            let screenshot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = "reference-slider-\(i + 1)-\(title.label)"
            attachment.lifetime = .keepAlways
            add(attachment)
            guard let cg = screenshot.image.cgImage else {
                XCTFail("Screenshot pixels unavailable")
                return
            }
            let scale = CGFloat(cg.width) / app.frame.width
            let f = slider.frame
            let rect = CGRect(x: f.minX * scale, y: f.minY * scale,
                              width: f.width * scale, height: f.height * scale).integral
            guard let crop = cg.cropping(to: rect) else {
                XCTFail("Slider crop unavailable")
                return
            }
            var bytes = [UInt8](repeating: 0, count: crop.width * crop.height * 4)
            guard let ctx = CGContext(data: &bytes, width: crop.width, height: crop.height,
                                      bitsPerComponent: 8, bytesPerRow: crop.width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
                                                  CGBitmapInfo.byteOrder32Big.rawValue) else {
                XCTFail("Pixel buffer unavailable")
                return
            }
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
            var blueEnd = -1
            for y in 0..<crop.height {
                for x in 0..<crop.width {
                    let j = (y * crop.width + x) * 4
                    let r = Int(bytes[j]), g = Int(bytes[j + 1]), b = Int(bytes[j + 2])
                    if r < 145 && g < 170 && b > 170 && b > r + 65 && b > g + 35 {
                        blueEnd = max(blueEnd, x)
                    }
                }
            }
            XCTAssertGreaterThan(blueEnd, 0, "No blue bar/ring at stop \(i + 1)")
            blueEnds.append(blueEnd)
        }

        XCTAssertEqual(Set(titles).count, 5, "Five stops must retain five different efforts")
        for i in 1..<blueEnds.count {
            XCTAssertGreaterThan(blueEnds[i], blueEnds[i - 1] + 12,
                                 "Blue extent must grow cleanly at every stop: \(blueEnds)")
        }
        print("SHIYAN_FIVE_REFERENCE_STOPS", titles, blueEnds)
    }
}
