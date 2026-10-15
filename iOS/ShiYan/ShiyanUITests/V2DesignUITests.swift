import XCTest

final class V2DesignUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_CHAT_REPAIR"] = scenario
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 30))
        return app
    }
    private func capture(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name; a.lifetime = .keepAlways; add(a)
    }
    func test01ShortUserPreviewGeometry() {
        let app = launch("preview-short")
        let bubble = app.staticTexts["user-bubble-11111111-1111-1111-1111-111111111111"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10)); XCTAssertTrue(bubble.isHittable)
        print("V2_BUBBLE_FRAME=\(bubble.frame)")
        capture("v2-short-before-longpress")
        bubble.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["选择文本"].waitForExistence(timeout: 7), app.debugDescription)
        XCTAssertTrue(app.buttons["复制"].exists); XCTAssertTrue(app.buttons["编辑"].exists)
        print("V2_MENU_COPY_FRAME=\(app.buttons["复制"].frame)")
        capture("v2-short-context-preview")
        app.buttons["选择文本"].tap()
        let text = app.textViews["message-selection-text"]
        XCTAssertTrue(text.waitForExistence(timeout: 8))
        XCTAssertEqual(text.value as? String, "长得像哪个明星")
        app.buttons["完成"].tap()
    }
    func test02ImageCaptionAndBothEdges() {
        let app = launch("render")
        let bubble = app.staticTexts["user-bubble-11111111-1111-1111-1111-111111111111"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10))
        let text = bubble.label
        capture("v2-edges-initial")
        let screen = app.windows.firstMatch.frame
        for round in 0..<3 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.27))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.68)), withVelocity: .slow, thenHoldForDuration: 0.2)
            capture("v2-edges-older-\(round)")
            if bubble.exists { XCTAssertEqual(bubble.label, text) }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.70))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.21)), withVelocity: .slow, thenHoldForDuration: 0.2)
            capture("v2-edges-newer-\(round)")
            if bubble.exists { XCTAssertEqual(bubble.label, text) }
        }
        let bottom = app.buttons["chat-scroll-bottom"]
        if bottom.exists { XCTAssertEqual(bottom.frame.midX, screen.midX, accuracy: 3); bottom.tap() }
        capture("v2-edges-final")
    }

    func test03V3HeaderAndContextPreview() {
        let app = launch("preview-1000")
        let header = app.buttons["新建聊天"]
        XCTAssertTrue(header.exists)
        let headerY = header.frame.minY
        print("V3_CHAT_HEADER_Y=\(headerY)")
        XCTAssertLessThan(headerY, 70, "Top row should move slightly up from the previous baseline")
        let bubble = app.staticTexts["user-bubble-11111111-1111-1111-1111-111111111111"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10))
        XCTAssertEqual(bubble.label, "输出1000字小说")
        print("V3_ORIGINAL_BUBBLE_FRAME=\(bubble.frame)")
        capture("v3-original-bubble-before-longpress")
        bubble.press(forDuration: 0.9)
        XCTAssertTrue(app.buttons["选择文本"].waitForExistence(timeout: 7), app.debugDescription)
        XCTAssertTrue(app.buttons["复制"].exists)
        XCTAssertTrue(app.buttons["编辑"].exists)
        print("V3_MENU_COPY_FRAME=\(app.buttons["复制"].frame)")
        capture("v3-user-bubble-longpress-no-grey-sidepanels")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.18)).tap()
        app.buttons["历史会话"].tap()
        let search = app.buttons["搜索会话"]
        XCTAssertTrue(search.waitForExistence(timeout: 7))
        print("V3_SIDEBAR_SEARCH_Y=\(search.frame.minY)")
        XCTAssertLessThan(search.frame.minY, 70)
        capture("v3-sidebar-title-search-shifted-up")
    }

    func test04V3ThreeMinuteSpeech() {
        let app = launch("speech-long")
        let input = app.textFields["agent-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("已有草稿：")
        let started = Date()
        app.buttons["语音转文字"].tap()
        XCTAssertTrue(app.buttons["结束语音输入"].waitForExistence(timeout: 8))
        let parts = (1...60).map { "第\($0)段语音请保持先后顺序，继续补充故事的风景人物动作与细节。" }
        let target = "已有草稿：" + parts.joined()
        func eventually(_ seconds: TimeInterval, _ predicate: @escaping () -> Bool) {
            let goal = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [goal], timeout: seconds), .completed)
        }
        eventually(85) { ((input.value as? String) ?? "").contains("第20段语音") }
        let twenty = (input.value as? String) ?? ""
        XCTAssertTrue(twenty.hasPrefix("已有草稿：第1段语音"))
        capture("v3-60-seconds-voice-input")
        eventually(95) { ((input.value as? String) ?? "").contains("第40段语音") }
        let forty = (input.value as? String) ?? ""
        XCTAssertGreaterThan(forty.count, twenty.count)
        capture("v3-120-seconds-voice-input")
        eventually(95) { ((input.value as? String) ?? "") == target }
        eventually(12) { app.buttons["语音转文字"].exists }
        let got = (input.value as? String) ?? ""
        XCTAssertEqual(got, target)
        XCTAssertEqual(got.components(separatedBy: "第40段语音").count - 1, 1)
        XCTAssertEqual(got.components(separatedBy: "第60段语音").count - 1, 1)
        print("V3_LONG_SPEECH_SECONDS=\(Date().timeIntervalSince(started))")
        print("V3_LONG_SPEECH_CHARS=\(got.count)")
        capture("v3-180-seconds-voice-input-no-duplication")
    }

}
