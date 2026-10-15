import XCTest

 
 
final class MessageEditBranchUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testEditingRemovesOldTurnAndDownstreamReplies() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launchEnvironment["SHIYAN_UI_TEST_EDIT_BRANCH"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["新建聊天"].waitForExistence(timeout: 25), app.debugDescription)

        let previousUser = app.staticTexts["前文用户_应保留"]
        let previousReply = app.staticTexts["前文回复_应保留"]
        let oldUser = app.staticTexts["编辑目标_旧文本"]
        XCTAssertTrue(previousUser.waitForExistence(timeout: 8))
        XCTAssertTrue(previousReply.exists)
        XCTAssertTrue(oldUser.exists)
        XCTAssertTrue(app.staticTexts["被替换回复_应消失"].exists)
        XCTAssertTrue(app.staticTexts["旧分支后续消息_应消失"].exists)

         
         
        let edit = app.buttons["test-edit-branch-action"]
        XCTAssertTrue(edit.waitForExistence(timeout: 8), app.debugDescription)
        edit.tap()

        let field = app.textFields["agent-message-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["编辑后重新发送"].exists)
        XCTAssertEqual((field.value as? String), "编辑目标_旧文本")

         
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.20)).tap()
        let deletes = String(repeating: XCUIKeyboardKey.delete.rawValue, count: "编辑目标_旧文本".count)
        field.typeText(deletes + "编辑目标_新文本")
        XCTAssertEqual((field.value as? String), "编辑目标_新文本")
        let send = app.buttons["发送"]
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts["编辑目标_新文本"].waitForExistence(timeout: 7),
                      app.debugDescription)
        XCTAssertFalse(app.staticTexts["编辑目标_旧文本"].exists)
        XCTAssertFalse(app.staticTexts["被替换回复_应消失"].exists)
        XCTAssertFalse(app.staticTexts["旧分支后续消息_应消失"].exists)
        XCTAssertFalse(app.staticTexts["旧分支后续回复_应消失"].exists)
        XCTAssertTrue(previousUser.exists, "Prior user message must survive edit")
        XCTAssertTrue(previousReply.exists, "Prior assistant message must survive edit")
        XCTAssertFalse(app.staticTexts["编辑后重新发送"].exists)

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "edited-branch-keeps-prefix-removes-suffix"
        shot.lifetime = .keepAlways
        add(shot)
        print("SHIYAN_EDIT_BRANCH_REPLACES_OLD_MESSAGE_AND_REPLIES_PASSED")
    }
}
