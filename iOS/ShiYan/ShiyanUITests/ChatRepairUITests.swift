import XCTest

final class ChatRepairUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_CHAT_REPAIR"] = scenario
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25), app.debugDescription)
        return app
    }
    private func capture(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func eventually(timeout: TimeInterval = 12, file: StaticString = #filePath, line: UInt = #line, _ predicate: @escaping () -> Bool) {
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)], timeout: timeout)
        XCTAssertEqual(result, .completed, file: file, line: line)
    }
    private func field(_ app: XCUIApplication) -> XCUIElement { app.textFields["agent-message-input"] }
    private func assistant(_ app: XCUIApplication) -> XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH %@", "assistant-text-22222222")).firstMatch
    }
    private func older(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.30))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.71)), withVelocity: .slow, thenHoldForDuration: 0)
    }
    private func user(_ app: XCUIApplication) -> XCUIElement {
        let element = app.staticTexts["user-bubble-11111111-1111-1111-1111-111111111111"]
        for _ in 0..<4 {
            if element.exists && element.isHittable && element.frame.minY > 120 && element.frame.maxY < field(app).frame.minY { break }
            older(app)
        }
        XCTAssertTrue(element.exists, app.debugDescription)
        return element
    }

    func test01RenderingAndUserSelection() {
        let app = launch("render")
        let reply = assistant(app)
        XCTAssertTrue(reply.waitForExistence(timeout: 10), app.debugDescription)
        eventually { reply.isHittable }
        capture("01-image-caption-clear-at-bottom")
        let bubble = user(app)
        XCTAssertTrue(bubble.label.contains("这是一条有文字的用户消息"))
        capture("02-user-text-visible-below-photo")
        print("USER_BUBBLE_FRAME=\(bubble.frame)")
        bubble.press(forDuration: 0.9)
        XCTAssertTrue(app.buttons["选择文本"].waitForExistence(timeout: 6), app.debugDescription)
        XCTAssertTrue(app.buttons["复制"].exists)
        XCTAssertTrue(app.buttons["编辑"].exists)
        XCTAssertFalse(app.images["clock"].exists)
        capture("03-user-menu-time-subdued-select-text")
        app.buttons["选择文本"].tap()
        let selection = app.textViews["message-selection-text"]
        XCTAssertTrue(selection.waitForExistence(timeout: 8), app.debugDescription)
        selection.press(forDuration: 0.8)
        XCTAssertTrue(app.menuItems["全选"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.menuItems["复制"].exists)
        capture("04-native-user-text-range-handles")
        app.menuItems["全选"].tap()
        capture("05-native-select-all")
        if !app.menuItems["复制"].exists { selection.press(forDuration: 0.8) }
        XCTAssertTrue(app.menuItems["复制"].waitForExistence(timeout: 5))
        app.menuItems["复制"].tap()
        app.buttons["完成"].tap()
        XCTAssertFalse(selection.exists)
    }

    func test02AssistantDirectSelection() {
        let app = launch("render")
        let reply = assistant(app)
        XCTAssertTrue(reply.waitForExistence(timeout: 10), app.debugDescription)
        eventually { reply.isHittable }
         
        reply.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.08)).press(forDuration: 0.9)
        XCTAssertTrue(app.menuItems["复制"].waitForExistence(timeout: 6), app.debugDescription)
        XCTAssertTrue(app.menuItems["全选"].exists)
        XCTAssertFalse(app.buttons["编辑"].exists)
        XCTAssertFalse(app.textViews["message-selection-text"].exists)
        capture("06-assistant-native-selection-no-bubble-preview")
         
        app.menuItems["复制"].tap()
        reply.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.08)).press(forDuration: 0.8)
        XCTAssertTrue(app.menuItems["全选"].waitForExistence(timeout: 5))
        app.menuItems["全选"].tap()
        capture("07-assistant-select-all-no-custom-effects")
        if !app.menuItems["复制"].exists {
            reply.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.08)).press(forDuration: 0.8)
        }
        XCTAssertTrue(app.menuItems["复制"].waitForExistence(timeout: 5))
        app.menuItems["复制"].tap()
    }

    func test03FollowingAndCenteredReturnButton() {
        let app = launch("scroll")
        let input = field(app); XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap(); input.typeText("请输出用于滚动测试的长回复")
        app.buttons["发送"].tap()
        let streaming = app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "模拟回复第1段")).firstMatch
        XCTAssertTrue(streaming.waitForExistence(timeout: 8), app.debugDescription)
        capture("08-streaming-new-reply-visible")
        older(app); older(app)
        let bottom = app.buttons["chat-scroll-bottom"]
        XCTAssertTrue(bottom.waitForExistence(timeout: 8), app.debugDescription)
        print("BOTTOM_BUTTON_FRAME=\(bottom.frame)")
        XCTAssertEqual(bottom.frame.midX, app.windows.firstMatch.frame.width / 2, accuracy: 3)
        XCTAssertLessThanOrEqual(bottom.frame.height, 40, "Button hit frame must not include composer-spacing padding")
        capture("09-bottom-button-centered-history-not-hijacked")
        let oldVisible = app.staticTexts.allElementsBoundByIndex.first { $0.label.hasPrefix("历史消息第") && $0.isHittable }
        let oldY = oldVisible?.frame.minY
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(bottom.exists, "New chunks must not force a user reading history to the bottom")
        if let oldVisible, let oldY { XCTAssertEqual(oldVisible.frame.minY, oldY, accuracy: 5) }
        bottom.tap()
        eventually(timeout: 18) {
            let values = app.textViews.allElementsBoundByIndex.map { ($0.value as? String) ?? $0.label }
            return values.contains { $0.contains("回复完成标记_CHAT_REPAIR_OK") }
        }
        eventually { !bottom.exists }
        let finalReply = app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "回复完成标记_CHAT_REPAIR_OK")).firstMatch
        XCTAssertTrue(finalReply.exists, app.debugDescription)
        XCTAssertLessThanOrEqual(finalReply.frame.maxY, input.frame.minY + 4, "Reply tail must not be behind the input bar")
        capture("10-full-reply-tail-above-composer")
    }

    func test04MultilineSpeechCallbackReplay() {
        let app = launch("speech")
        let input = field(app); XCTAssertTrue(input.waitForExistence(timeout: 8))
        let initialHeight = input.frame.height
        input.tap(); input.typeText("已有草稿：")
        app.buttons["语音转文字"].tap()
        let expected = "已有草稿：请为我画一幅安静的书房插画，窗外有阳光，桌上放着一本打开的书，整体采用自然柔和的颜色。再加上一只趴在窗边的小猫。"
        eventually { (input.value as? String) == expected }
        XCTAssertGreaterThan(input.frame.height, initialHeight + 20)
        capture("11-multiline-speech-no-overwrite-no-repeat")
        eventually { app.buttons["语音转文字"].exists }
        app.buttons["语音转文字"].tap()
        let next = expected + String(expected.dropFirst("已有草稿：".count))
        eventually { (input.value as? String) == next }
        capture("12-stop-restart-preserves-draft-and-real-repeat")
    }

    func test05VerifiedCurrentImageOverridesFallback() {
        let app = launch("image-valid")
        let reply = assistant(app); XCTAssertTrue(reply.waitForExistence(timeout: 10))
        eventually { ((reply.value as? String) ?? reply.label).contains("图片已生成。") }
        XCTAssertFalse(((reply.value as? String) ?? reply.label).contains("没有返回"))
        XCTAssertGreaterThan(app.buttons.matching(NSPredicate(format: "label == %@", "查看图片")).count, 0)
        capture("13-verified-output-image-success")
    }
    func test06UserUploadIsNotGenerationSuccess() {
        let app = launch("image-upload")
        let reply = assistant(app); XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertTrue(((reply.value as? String) ?? reply.label).contains("没有返回可展示的结果"))
        XCTAssertFalse(((reply.value as? String) ?? reply.label).contains("图片已生成。"))
        capture("14-user-upload-not-misreported-as-generated")
    }
    func test07MissingDownloadedImageIsNotSuccess() {
        let app = launch("image-missing")
        let reply = assistant(app); XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertTrue(((reply.value as? String) ?? reply.label).contains("没有返回可展示的结果"))
        capture("15-missing-output-file-keeps-error")
    }
}
