import XCTest

final class RenameDialogUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func screenshot(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }

    func testInputAlignedAndBlueSaveButton() throws {
        let app = XCUIApplication(bundleIdentifier: "com.shiyan.enhancer")
        app.launchEnvironment["SHIYAN_UI_TEST_OPEN_AGENT"] = "1"
        app.launch()
        let opener = app.buttons["历史会话"]
        XCTAssertTrue(opener.waitForExistence(timeout: 25))
        opener.tap()
        XCTAssertTrue(app.buttons["搜索会话"].waitForExistence(timeout: 7))

        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-row-")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), app.debugDescription)
        let originalTitle = row.label
        row.press(forDuration: 0.9)
        let rename = app.buttons["重命名"]
        XCTAssertTrue(rename.waitForExistence(timeout: 6), app.debugDescription)
        rename.tap()

        let field = app.textFields["rename-conversation-field"]
        let cancel = app.buttons["rename-conversation-cancel"]
        let save = app.buttons["rename-conversation-save"]
        XCTAssertTrue(field.waitForExistence(timeout: 7), app.debugDescription)
        XCTAssertTrue(cancel.exists && save.exists)
        XCTAssertEqual(field.frame.minX, cancel.frame.minX, accuracy: 3)
        XCTAssertEqual(field.frame.maxX, save.frame.maxX, accuracy: 3)
        XCTAssertEqual(cancel.frame.midY, save.frame.midY, accuracy: 2)
        XCTAssertGreaterThan(field.frame.width, 210)
        XCTAssertEqual((field.value as? String ?? ""), originalTitle)
        screenshot("rename-aligned-input-blue-save")
        print("RENAME_FIELD_BUTTON_ALIGNMENT", field.frame, cancel.frame, save.frame)
        field.tap()
        field.typeText("Z")
        XCTAssertTrue((field.value as? String ?? "").hasSuffix("Z"),
                      "Rename TextField must remain editable with a keyboard")
        screenshot("rename-typing-aligned-keyboard")
        cancel.tap()
        XCTAssertFalse(field.waitForExistence(timeout: 3))

        let sameRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "session-row-", originalTitle)).firstMatch
        XCTAssertTrue(sameRow.waitForExistence(timeout: 6))
        sameRow.press(forDuration: 0.9)
        app.buttons["重命名"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 7))
        save.tap()
        XCTAssertFalse(field.waitForExistence(timeout: 3))
        XCTAssertTrue(sameRow.waitForExistence(timeout: 5))
        print("RENAME_DIALOG_LAYOUT_AND_SAVE_PASSED")
    }
}
