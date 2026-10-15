import Foundation

@main
enum SpeechTranscriptAccumulatorTests {
    static func main() {
        var passed = 0

        func check(_ actual: String, _ expected: String, _ name: String) {
            guard actual == expected else {
                fputs("FAIL \(name): expected [\(expected)], received [\(actual)]\n", stderr)
                exit(1)
            }
            print("PASS \(name)")
            passed += 1
        }

        var speech = SpeechTranscriptAccumulator()
        check(speech.accept("帮我画"), "帮我画", "initial partial")
        check(speech.accept("帮我画一只猫"), "帮我画一只猫", "expanding partial")
        check(speech.accept("再加上花园"), "帮我画一只猫再加上花园", "pause and new phrase")
        check(speech.accept("再加上花园和阳光"), "帮我画一只猫再加上花园和阳光", "new phrase expands")
        check(speech.accept("再加上花园和阳光"), "帮我画一只猫再加上花园和阳光", "duplicate callback")
        check(speech.accept("继续生成"), "帮我画一只猫再加上花园和阳光继续生成", "multiple pauses")

        speech.reset()
        check(speech.accept("我想去南京"), "我想去南京", "partial before correction")
        check(speech.accept("我想去北京"), "我想去北京", "same phrase corrected")
        check(speech.accept("我想去"), "我想去北京", "shorter callback does not delete text")

        speech.reset()
        check(speech.accept("画一只猫"), "画一只猫", "overlap first phrase")
        check(speech.accept("一只猫在奔跑"), "画一只猫在奔跑", "overlap without duplication")

        speech.reset()
        check(speech.accept("你好", firstSegmentTime: 0, lastSegmentEndTime: 0.5), "你好", "timestamp first utterance")
        check(speech.accept("你好", firstSegmentTime: 4, lastSegmentEndTime: 4.5), "你好你好", "same words genuinely spoken twice in separate audio windows")

        speech.reset()
        check(speech.accept("Hello", firstSegmentTime: 0), "Hello", "english first phrase")
        check(speech.accept("world", firstSegmentTime: 3), "Hello world", "english spacing")

        speech.reset()
        let previousDraft = "先前已有的文字"
        check(previousDraft + speech.accept("新的录音"), "先前已有的文字新的录音", "preserve pre-recording draft")

        print("ALL \(passed) SPEECH ACCUMULATOR TESTS PASSED")
    }
}
