import SwiftUI
import Foundation

extension View {
    @ViewBuilder func shiyanQAGeometry(_ name: String) -> some View {
#if DEBUG
        if ProcessInfo.processInfo.environment["SHIYAN_V2_RECORD_LAYOUT"] == "1" {
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { rect in
                let v: [String: Any] = ["name": name, "time": Date().timeIntervalSince1970,
                    "x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
                if let bytes = try? JSONSerialization.data(withJSONObject: v) {
                    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("v2-home-geometry.jsonl")
                    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
                    if let h = try? FileHandle(forWritingTo: url) {
                        defer { try? h.close() }
                        do { try h.seekToEnd(); try h.write(contentsOf: bytes + Data([10])) } catch {}
                    }
                }
            }
        } else { self }
#else
        self
#endif
    }
}
