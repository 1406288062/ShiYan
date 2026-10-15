import SwiftUI
import Foundation

 
struct AgentDrawerGeometryProbe: View {
    let progress: CGFloat
    let radii: RectangleCornerRadii
    var body: some View {
        Color.clear.frame(width: 0, height: 0).allowsHitTesting(false).accessibilityHidden(true)
            .onAppear { record() }
            .onChange(of: progress) { _, _ in record() }
            .onChange(of: radii) { _, _ in record() }
    }
    private func record() {
#if DEBUG
        guard ProcessInfo.processInfo.environment["SHIYAN_V2_RECORD_GEOMETRY"] == "1" else { return }
        let values: [String: Any] = ["time": Date().timeIntervalSince1970, "progress": Double(progress),
            "topLeading": Double(radii.topLeading), "bottomLeading": Double(radii.bottomLeading),
            "topTrailing": Double(radii.topTrailing), "bottomTrailing": Double(radii.bottomTrailing)]
        guard let data = try? JSONSerialization.data(withJSONObject: values) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("v2-drawer-geometry.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            do { try handle.seekToEnd(); try handle.write(contentsOf: data + Data([10])) } catch {}
        }
#endif
    }
}
