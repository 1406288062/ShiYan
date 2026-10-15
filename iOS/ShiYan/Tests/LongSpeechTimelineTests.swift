import Foundation

@main
enum LongSpeechTimelineTests {
    static func main() {
        var cases = 0
        func eq(_ got: String, _ wanted: String, _ label: String) {
            if got != wanted { fputs("FAIL \(label): expected [\(wanted.prefix(100))] got [\(got.prefix(150))]\n",stderr);exit(1) }
            cases += 1
        }
        var speech=SpeechTranscriptAccumulator()
        eq(speech.accept("帮我画一只猫",firstSegmentTime: 0,lastSegmentEndTime: 1.8),"帮我画一只猫","first partial")
        eq(speech.accept("帮我画一只猫在花园里",firstSegmentTime: 2,lastSegmentEndTime: 4),"帮我画一只猫在花园里","cumulative hypothesis with moving timestamp")
        eq(speech.accept("帮我画一只猫在花园里",firstSegmentTime: 2.05,lastSegmentEndTime: 4.2),"帮我画一只猫在花园里","duplicate updated time")
        eq(speech.accept("在花园里晒太阳",firstSegmentTime: 5.5,lastSegmentEndTime: 7.5),"帮我画一只猫在花园里晒太阳","suffix-prefix overlapping new phrase")
        eq(speech.accept("帮我画一只猫在花园里晒太阳",firstSegmentTime: 0,lastSegmentEndTime: 7.5,isFinal:true),"帮我画一只猫在花园里晒太阳","final full rewrite")
        speech.reset()
        eq(speech.accept("你好",firstSegmentTime: 0,lastSegmentEndTime: 2),"你好","initial")
        eq(speech.accept("你好",firstSegmentTime: 2.1,lastSegmentEndTime: 2.4),"你好","adjacent timestamp jitter is not a new utterance")
        eq(speech.accept("你好",firstSegmentTime: 4,lastSegmentEndTime: 5),"你好你好","same words genuinely spoken at disjoint time")
        eq(speech.accept("你好你好",firstSegmentTime: 0,lastSegmentEndTime: 5,isFinal:true),"你好你好","full cumulative repeat")

         
        speech.reset()
        var expected=""
        for i in 0..<60 {
            let fragment="第\(i+1)段说明请保持文字的先后顺序不要删除前面的句子。"
            let start=Double(i*3)
            let end=start+2.2
            expected += fragment
            eq(speech.accept(fragment,firstSegmentTime:start,lastSegmentEndTime:end),expected,"chunk \(i) first")
            eq(speech.accept(fragment,firstSegmentTime:start+0.03,lastSegmentEndTime:end+0.1),expected,"chunk \(i) duplicate")
            if i%7==0 {
                eq(speech.accept(expected,firstSegmentTime:0.02,lastSegmentEndTime:end+0.1),expected,"chunk \(i) cumulative")
            }
        }
        eq(speech.accept(expected,firstSegmentTime:0,lastSegmentEndTime:179.6,isFinal:true),expected,"3-minute final")
        print("ALL \(cases) LONG SPEECH ASSERTIONS PASSED. CHARACTERS=\(expected.count), AUDIO_SECONDS=180")
    }
}
