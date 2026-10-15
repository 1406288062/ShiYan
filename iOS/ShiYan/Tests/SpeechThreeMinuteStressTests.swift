import Foundation
@main enum SpeechThreeMinuteStressTests {
 static func main() {
    var passed = 0
    func eq(_ got:String,_ expected:String,_ name:String) {
      if got != expected {
        fputs("FAIL \(name): gotLen=\(got.count), expectLen=\(expected.count), gotTail=\(got.suffix(65))\n",stderr)
        exit(1)
      }
      passed += 1
    }
    for round in 0..<25 {
      var a=SpeechTranscriptAccumulator()
      var all=""
      for i in 0..<60 {
        let fragment="第\(round)轮第\(i+1)段，请在录音换行后继续保持前文不会被覆盖。"
        let from=Double(i*3)
        let end=from+2.35
        eq(a.accept(String(fragment.prefix(5)),firstSegmentTime:from,lastSegmentEndTime:from+0.55),all+String(fragment.prefix(5)),"partial-\(round)-\(i)")
        all+=fragment
        eq(a.accept(fragment,firstSegmentTime:from,lastSegmentEndTime:end),all,"completed-\(round)-\(i)")
        eq(a.accept(fragment,firstSegmentTime:from+0.04,lastSegmentEndTime:end+0.08),all,"duplicate-\(round)-\(i)")
        if (i+round)%8==0 {
          eq(a.accept(all,firstSegmentTime:0,lastSegmentEndTime:end+0.1),all,"cumulative-\(round)-\(i)")
        }
      }
      eq(a.accept(all,firstSegmentTime:0,lastSegmentEndTime:180,isFinal:true),all,"final-\(round)")
      eq("已有草稿："+a.text,"已有草稿："+all,"draft-\(round)")
      a.reset()
      eq(a.accept("再次录音",firstSegmentTime:0,lastSegmentEndTime:2),"再次录音","restart-\(round)")
    }
    print("ALL \(passed) THREE-MINUTE STRESS ASSERTIONS PASSED (25 virtual 180-second sessions)")
 }
}
