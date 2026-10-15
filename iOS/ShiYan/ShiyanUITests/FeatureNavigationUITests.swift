import XCTest

final class FeatureNavigationUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25), app.debugDescription)
        XCTAssertFalse(app.buttons["关闭聊天"].exists)
        return app
    }

    private func openSidebar(_ app: XCUIApplication) {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "历史会话")).firstMatch.tap()
        XCTAssertTrue(app.buttons["sidebar-feature-enhance"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["sidebar-feature-space"].exists)
        XCTAssertTrue(app.images["sidebar-brand-logo"].exists)
        let enhance = app.buttons["sidebar-feature-enhance"]
        let space = app.buttons["sidebar-feature-space"]
        XCTAssertLessThan(enhance.frame.maxY, space.frame.maxY)
        XCTAssertLessThanOrEqual(enhance.frame.maxY, space.frame.minY + 1)
        let pinned = app.staticTexts["置顶"]
        if pinned.exists { XCTAssertLessThan(space.frame.maxY, pinned.frame.minY) }
    }

    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testDefaultChatEnhanceSpaceAndDraftReturn() throws {
        let app = launch()
        app.buttons["新建聊天"].tap()
        let field = app.textFields["agent-message-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        field.tap(); field.typeText("navigation draft")
        openSidebar(app)
        capture("sidebar-logo-independent-features")
        app.buttons["sidebar-feature-enhance"].tap()
        XCTAssertTrue(app.buttons["feature-open-sidebar-enhance"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["photo-start-enhance"].exists)
        XCTAssertFalse(app.buttons["老照片上色"].exists)
        XCTAssertFalse(app.buttons["AI 消除"].exists)
        XCTAssertFalse(app.buttons["clock.arrow.circlepath"].exists)
        XCTAssertFalse(app.images["sidebar-brand-logo"].isHittable)
        capture("enhance-independent-page")
        app.buttons["feature-open-sidebar-enhance"].tap()
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND value CONTAINS %@", "session-row-", "当前会话")).firstMatch.tap()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.textFields["agent-message-input"].value as? String, "navigation draft")
        openSidebar(app)
        app.buttons["sidebar-feature-space"].tap()
        XCTAssertTrue(app.buttons["feature-open-sidebar-space"].waitForExistence(timeout: 8))
        let records = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "history-entry-"))
        XCTAssertGreaterThan(records.count, 0, "Pre-existing image history must still be accessible")
        let record = records.firstMatch
        let identifier = record.identifier
        capture("space-preserves-existing-history")
        record.tap()
        XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 8), app.debugDescription)
        app.buttons["关闭"].tap()
        XCTAssertTrue(app.buttons[identifier].waitForExistence(timeout: 8))
        app.buttons["feature-open-sidebar-space"].tap()
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND value CONTAINS %@", "session-row-", "当前会话")).firstMatch.tap()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.textFields["agent-message-input"].value as? String, "navigation draft")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25))
        XCTAssertFalse(app.buttons["feature-open-sidebar-space"].exists)
        openSidebar(app); app.buttons["sidebar-feature-space"].tap()
        XCTAssertTrue(app.buttons[identifier].waitForExistence(timeout: 8))
    }
}
