import XCTest

 
final class MessageContextShadowUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    func testLongPressCopyEditUsesRoundedOpaquePreview() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_EDIT_BRANCH"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25), app.debugDescription)

        let user = app.staticTexts["编辑目标_旧文本"]
        XCTAssertTrue(user.waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertTrue(user.isHittable)
        user.press(forDuration: 0.85)

        let copy = app.buttons["复制"]
        let edit = app.buttons["编辑"]
        XCTAssertTrue(copy.waitForExistence(timeout: 8),
                      "Expected own context menu rather than system text selection: \(app.debugDescription)")
        XCTAssertTrue(edit.exists, "Edit action must remain available")
        let todayTimestamp = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "今天")
        ).firstMatch
        XCTAssertTrue(todayTimestamp.waitForExistence(timeout: 8),
                      "Message timestamp must appear above copy/edit: \(app.debugDescription)")
        XCTAssertFalse(app.menuItems["Look Up"].exists, "Text-selection popup must not intercept long press")
        XCTAssertFalse(app.menuItems["Translate"].exists, "Text-selection popup must not intercept long press")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "user-message-context-menu-opaque-rounded-preview"
        shot.lifetime = .keepAlways
        add(shot)
        print("SHIYAN_MESSAGE_CONTEXT_COPY_EDIT_MENU_VISIBLE")
        edit.tap()

        XCTAssertTrue(app.staticTexts["编辑后重新发送"].waitForExistence(timeout: 8),
                      "Edit action must still focus the draft")
        let input = app.textFields["agent-message-input"]
        XCTAssertEqual(input.value as? String, "编辑目标_旧文本")
        print("SHIYAN_MESSAGE_CONTEXT_EDIT_STILL_WORKS")
    }
}
