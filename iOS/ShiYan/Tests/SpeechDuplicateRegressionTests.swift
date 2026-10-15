import Foundation

@main
enum SpeechDuplicateRegressionTests {
    static func main() {
        var passed = 0
        func assertEqual(_ actual: String, _ expected: String, _ name: String) {
            guard actual == expected else {
                fputs("FAIL \(name): expected [\(expected)], got [\(actual)]\n", stderr)
                exit(1)
            }
            print("PASS \(name)")
            passed += 1
        }
        var speech = SpeechTranscriptAccumulator()
        assertEqual(speech.accept("帮我画一只猫", firstSegmentTime: 0.1),
                    "帮我画一只猫", "initial recognition")
        assertEqual(speech.accept("帮我画一只猫", firstSegmentTime: 1.2),
                    "帮我画一只猫", "same sentence with shifted ASR timestamp")
        assertEqual(speech.accept("帮我画一只猫在花园里", firstSegmentTime: 1.8),
                    "帮我画一只猫在花园里", "expanded hypothesis with shifted timestamp")
        assertEqual(speech.accept("帮我画一只猫在花园里", firstSegmentTime: 2.8),
                    "帮我画一只猫在花园里", "another duplicate callback")
        print("PASS: \(passed) tests")
    }
}
