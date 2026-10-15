import AppKit
import Foundation

 
let args = CommandLine.arguments
if args.count < 3 { fputs("usage: export-symbols output-dir symbol-names.json\n", stderr); exit(2) }
let output = URL(fileURLWithPath: args[1], isDirectory: true)
let names = try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
_ = NSApplication.shared
NSApp.appearance = NSAppearance(named: .aqua)
var exported = 0
var missing: [String] = []
func export(_ name: String, filename: String, canvas: CGFloat? = 24, pointSize: CGFloat = 20, weight: NSFont.Weight = .medium) throws {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
          let symbol = base.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)) else {
        missing.append(name); return
    }
    let scale: CGFloat = 3
    let canvasSize = canvas.map { NSSize(width: $0, height: $0) } ?? symbol.size
    let pixelsWide = Int(ceil(canvasSize.width * scale))
    let pixelsHigh = Int(ceil(canvasSize.height * scale))
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw NSError(domain: "Symbols", code: 1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: scale, y: scale)
    context.cgContext.clear(CGRect(x: 0, y: 0, width: canvasSize.width, height: canvasSize.height))
    context.imageInterpolation = .high
    let size = symbol.size
    let fit = canvas.map { min(1, ($0 - 2) / max(size.width, size.height)) } ?? 1
    let drawSize = NSSize(width: size.width * fit, height: size.height * fit)
    let rect = NSRect(x: (canvasSize.width - drawSize.width) / 2, y: (canvasSize.height - drawSize.height) / 2, width: drawSize.width, height: drawSize.height)
    symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
    bitmap.size = canvasSize
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "Symbols", code: 2) }
    try png.write(to: output.appendingPathComponent(filename + ".png"), options: .atomic)
    exported += 1
}
 
try export("photo.badge.plus", filename: "photo-placeholder", canvas: nil, pointSize: 40, weight: .regular)
if args.contains("--placeholder-only") { print("Exported exact 40pt regular photo-placeholder"); exit(0) }
for name in names { try export(name, filename: name) }
try export("arrow.up", filename: "send-arrow", canvas: 36, pointSize: 19, weight: .bold)
try export("stop.fill", filename: "send-stop", canvas: 36, pointSize: 16, weight: .bold)
print("Exported \(exported) native symbol assets; unavailable: \(missing.joined(separator: ", "))")
if !missing.isEmpty { exit(1) }
