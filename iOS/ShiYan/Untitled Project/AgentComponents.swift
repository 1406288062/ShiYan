import SwiftUI
import UIKit
import QuickLook
import CoreText

extension UIImage {
    var normalizedCGImage: CGImage? {
        if imageOrientation == .up, let cgImage { return cgImage }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in draw(in: CGRect(origin: .zero, size: size)) }.cgImage
    }
    func normalizedForEditing(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        let factor = longest > maxDimension ? maxDimension / longest : 1
        if factor == 1, imageOrientation == .up { return self }
        let target = CGSize(width: size.width * factor, height: size.height * factor)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

 
struct AgentTopGlass: UIViewRepresentable {
    func makeUIView(context: Context) -> GradientBlurView { GradientBlurView() }
    func updateUIView(_ uiView: GradientBlurView, context: Context) {}
    final class GradientBlurView: UIView {
        private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        private let gradient = CAGradientLayer()
        override init(frame: CGRect) {
            super.init(frame: frame); isUserInteractionEnabled = false
            addSubview(blur)
            gradient.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
            gradient.locations = [0, 0.60, 1]
            blur.layer.mask = gradient
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func layoutSubviews() { super.layoutSubviews(); blur.frame = bounds; gradient.frame = bounds }
    }
}

struct AgentRoundButton: View {
    let symbol: String
    let label: String
    var diameter: CGFloat = 44
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 21, weight: .medium))
                .foregroundStyle(.primary).frame(width: diameter, height: diameter)
                .contentShape(Circle()).shiyanGlass(in: Circle(), tint: .white.opacity(0.04), interactive: true)
        }.buttonStyle(.plain).accessibilityLabel(label)
    }
}

struct AgentActivityView: View {
    let message: AgentMessage
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let phase = reduceMotion ? 0.5 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
            Text("Thinking")
                .font(.body)
                .foregroundStyle(LinearGradient(colors: [.secondary.opacity(0.75), .secondary.opacity(0.20), .secondary.opacity(0.75)],
                    startPoint: UnitPoint(x: phase * 2 - 1, y: 0), endPoint: UnitPoint(x: phase * 2, y: 0)))
        }
        .accessibilityLabel("Thinking").accessibilityIdentifier("agent-thinking")
    }
}

struct AgentMarkdown: View {
    let text: String
    var identifier = ""
    var onSelectionChanged: ((Bool) -> Void)?
    @Environment(\.sizeCategory) private var sizeCategory
    private var parts: [AgentMarkdownBlock] { AgentMarkdownParser.blocks(text) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(parts) { part in
                switch part.kind {
                case .table(let rows, let alignments):
                    let widths = Self.tableColumnWidths(rows)
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(rows.indices, id: \.self) { row in
                                HStack(alignment: .top, spacing: 0) {
                                    ForEach(rows[row].indices, id: \.self) { column in
                                        AgentSelectableText(text: rows[row][column], markdown: true,
                                            headingLevel: row == 0 ? 4 : 0, textAlignment: Self.textAlignment(alignments[column]),
                                            identifier: identifier + "-table-\(part.id)-\(row)-\(column)",
                                            onSelectionChanged: onSelectionChanged)
                                            .frame(width: widths[column], alignment: Self.alignment(alignments[column]))
                                            .padding(10)
                                    }
                                }
                                if row < rows.count - 1 { Divider() }
                            }
                        }
                    }
                    .accessibilityLabel("对比表格，可横向滑动")
                case .code(let language):
                    let preview = AgentCodeSizing.preview(part.content)
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(language).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button { UIPasteboard.general.string = part.content } label: { Image(systemName: "doc.on.doc") }
                                .buttonStyle(.plain).accessibilityLabel("复制代码")
                        }
                        ScrollView(.horizontal) {
                            AgentSelectableText(text: preview, monospaced: true,
                                identifier: identifier + "-code-\(part.id)", onSelectionChanged: onSelectionChanged)
                                .frame(width: Self.codeWidth(preview), alignment: .leading)
                        }.accessibilityLabel("代码，可横向滑动")
                        if preview != part.content {
                            Text("代码较长，预览已截取；复制可获取完整代码").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 14))
                case .heading(let level):
                    selectable(part, headingLevel: level)
                case .quote:
                    HStack(alignment: .top, spacing: 10) {
                        Rectangle().fill(Color.secondary.opacity(0.35)).frame(width: 3)
                        selectable(part)
                    }.fixedSize(horizontal: false, vertical: true)
                case .listItem(let marker, let indentation, let checked):
                    HStack(alignment: .top, spacing: 8) {
                        if let checked {
                            Image(systemName: checked ? "checkmark.square" : "square")
                                .foregroundStyle(.secondary).padding(.top, 3)
                                .accessibilityLabel(checked ? "已完成" : "待完成")
                        } else { Text(marker).font(.body).frame(minWidth: 14, alignment: .trailing) }
                        selectable(part)
                    }.padding(.leading, CGFloat(min(indentation, 12)) * 4)
                case .rule: Divider()
                case .prose: selectable(part)
                }
            }
        }
    }
    private func selectable(_ part: AgentMarkdownBlock, headingLevel: Int = 0) -> some View {
        AgentSelectableText(text: part.content, markdown: true, headingLevel: headingLevel,
                            identifier: identifier + "-\(part.id)", onSelectionChanged: onSelectionChanged)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private static func alignment(_ value: AgentMarkdownAlignment) -> Alignment {
        switch value { case .leading: return .leading; case .center: return .center; case .trailing: return .trailing }
    }
    private static func textAlignment(_ value: AgentMarkdownAlignment) -> NSTextAlignment {
        switch value { case .leading: return .left; case .center: return .center; case .trailing: return .right }
    }
    private static func codeWidth(_ text: String) -> CGFloat {
         
        CGFloat(AgentCodeSizing.width(text, pointSize: Double(UIFont.preferredFont(forTextStyle: .footnote).pointSize)))
    }
    private final class CachedWidths: NSObject {
        let values: [CGFloat]
        init(_ values: [CGFloat]) { self.values = values }
    }
    private static let widthsCache: NSCache<NSString, CachedWidths> = {
        let cache = NSCache<NSString, CachedWidths>(); cache.countLimit = 64; return cache
    }()
    private static func tableColumnWidths(_ rows: [[String]]) -> [CGFloat] {
        guard let first = rows.first else { return [] }
        let font = UIFont.preferredFont(forTextStyle: .body)
        let key = "\(font.pointSize)" + String(describing: rows)
        if let cached = widthsCache.object(forKey: key as NSString) { return cached.values }
        let widths = first.indices.map { column in
            let longest = rows.reduce(CGFloat(0)) { width, row in
                guard column < row.count else { return width }
                let parsed = try? AttributedString(markdown: row[column], options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                let plain = parsed.map { String($0.characters) } ?? row[column]
                let measured = plain.components(separatedBy: "\n").map {
                    ($0 as NSString).size(withAttributes: [.font: font]).width
                }.max() ?? 0
                return max(width, measured)
            }
            return min(220, max(36, ceil(longest) + 4))
        }
        widthsCache.setObject(CachedWidths(widths), forKey: key as NSString)
        return widths
    }
}


private enum AgentReasoningTrackLayout {
    static let scale: CGFloat = 0.875
    static let trackHeight: CGFloat = 52
    static let rim: CGFloat = 4.5
    static let thumbDiameter: CGFloat = trackHeight - 2 * rim - 3
    static let blueDiameter: CGFloat = thumbDiameter + 2 * rim
    static let dotDiameter: CGFloat = 7
    static let firstCenter: CGFloat = trackHeight / 2
    static let spacing: CGFloat = 12
    static let trackHorizontalPadding: CGFloat = 11
    static let trackVerticalPadding: CGFloat = 8
    static let horizontalInset: CGFloat = 28
    static let bottomInset: CGFloat = 16
    static let elasticReserve: CGFloat = 26
    static let glassHeight = trackHeight + 2 * trackVerticalPadding
    static let viewportHeight = glassHeight + 2 * elasticReserve
}

private struct AgentRubberBandShape: Shape {
    var bend: CGFloat
    var focus: CGFloat
    var originX: CGFloat = 0
    var parentWidth: CGFloat?
    var verticalInset: CGFloat = 0
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { .init(bend, focus) }
        set { bend = newValue.first; focus = newValue.second }
    }
    func path(in rect: CGRect) -> Path {
        let outline = AgentRubberBandGeometry.capsuleOutline(width: rect.width,
            height: max(0, rect.height - 2 * verticalInset),
            originX: originX, parentWidth: parentWidth ?? rect.width, focus: focus, bend: bend)
        let points = outline.map { CGPoint(x: $0.x + rect.minX, y: $0.y + rect.minY + verticalInset) }
        guard points.count >= 4 else { return Path() }
        var path = Path()
        path.move(to: points[0])
        for i in points.indices {
            let previous = points[(i + points.count - 1) % points.count]
            let current = points[i]
            let next = points[(i + 1) % points.count]
            let following = points[(i + 2) % points.count]
            path.addCurve(to: next,
                control1: CGPoint(x: current.x + (next.x - previous.x) / 6,
                                  y: current.y + (next.y - previous.y) / 6),
                control2: CGPoint(x: next.x - (following.x - current.x) / 6,
                                  y: next.y - (following.y - current.y) / 6))
        }
        path.closeSubpath()
        return path
    }
}

 
 
private struct AgentRubberBandTrack: View, Animatable {
    let modelCount: Int
    let highlightedIndex: Int
    var position: CGFloat
    var bend: CGFloat
    var focus: CGFloat
    let modelTitle: String
    let effort: String
    let titlePointSize: CGFloat
    private typealias Layout = AgentReasoningTrackLayout
    private var titleReserve: CGFloat { titlePointSize * 1.5 }
    private var presentationHeight: CGFloat { Layout.viewportHeight + titleReserve }
    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { .init(position, .init(bend, focus)) }
        set { position = newValue.first; bend = newValue.second.first; focus = newValue.second.second }
    }
    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let innerWidth = max(0, width - 2 * Layout.trackHorizontalPadding)
            let step = max(1, (innerWidth - Layout.trackHeight) / CGFloat(max(modelCount - 1, 1)))
            let centerY = Layout.viewportHeight / 2
            let blueOrigin = Layout.trackHorizontalPadding + (Layout.trackHeight - Layout.blueDiameter) / 2
            let fillWidth = Layout.blueDiameter + position * step
            let ringX = Layout.trackHorizontalPadding + Layout.firstCenter + position * step
            let ringY = centerY + AgentRubberBandGeometry.centerOffset(x: ringX, width: width, focus: focus, bend: bend)
            let angle = atan(AgentRubberBandGeometry.slope(x: ringX, width: width, focus: focus, bend: bend))
            let blue = Color(red: 0.255, green: 0.395, blue: 0.91)
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                Color.clear.frame(width: width, height: Layout.viewportHeight)
                    .shiyanGlass(in: AgentRubberBandShape(bend: bend, focus: focus,
                                                        verticalInset: Layout.elasticReserve),
                                 tint: .white.opacity(0.12), interactive: true)
                AgentRubberBandShape(bend: bend, focus: focus, originX: blueOrigin, parentWidth: width,
                                     verticalInset: (Layout.viewportHeight - Layout.blueDiameter) / 2)
                    .fill(blue).frame(width: fillWidth, height: Layout.viewportHeight)
                    .position(x: blueOrigin + fillWidth / 2, y: centerY)
                ForEach(0..<modelCount, id: \.self) { i in
                    let x = Layout.trackHorizontalPadding + Layout.firstCenter + CGFloat(i) * step
                    Circle().fill(i < highlightedIndex ? Color.white.opacity(0.27) : Color.primary.opacity(0.18))
                        .frame(width: Layout.dotDiameter, height: Layout.dotDiameter)
                        .position(x: x, y: centerY + AgentRubberBandGeometry.centerOffset(
                            x: x, width: width, focus: focus, bend: bend))
                        .accessibilityHidden(true)
                }
                ZStack {
                    Circle().fill(blue).frame(width: Layout.blueDiameter, height: Layout.blueDiameter)
                    Circle().fill(.white).frame(width: Layout.thumbDiameter, height: Layout.thumbDiameter)
                }
                .scaleEffect(x: 1 - abs(bend) / AgentRubberBandGeometry.maximumBend * 0.035,
                             y: 1 + abs(bend) / AgentRubberBandGeometry.maximumBend * 0.035)
                .rotationEffect(.radians(Double(angle)))
                .position(x: ringX, y: ringY)
                }.frame(width: width, height: Layout.viewportHeight, alignment: .topLeading)
                    .offset(y: titleReserve)
                AgentReasoningEdgeTitle(modelTitle: modelTitle, effort: effort,
                    pointSize: titlePointSize, width: width, height: presentationHeight,
                    glassTop: titleReserve + Layout.elasticReserve, glassHeight: Layout.glassHeight,
                    bend: bend, focus: focus)
                    .mask(AgentReasoningUpperEdgeMask(glassTop: titleReserve + Layout.elasticReserve,
                        glassHeight: Layout.glassHeight, bend: bend, focus: focus))
            }.frame(width: width, height: presentationHeight, alignment: .topLeading)
        }
        .frame(height: presentationHeight)
    }
}

 
 
private struct AgentReasoningUpperEdgeMask: Shape {
    let glassTop: CGFloat
    let glassHeight: CGFloat
    var bend: CGFloat
    var focus: CGFloat
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { .init(bend, focus) }
        set { bend = newValue.first; focus = newValue.second }
    }
    func path(in rect: CGRect) -> Path {
        let points = AgentRubberBandGeometry.capsuleOutline(width: rect.width,
            height: glassHeight, parentWidth: rect.width, focus: focus, bend: bend)
        let upperEnd = AgentRubberBandGeometry.straightSteps
        guard points.count > upperEnd + 1 else { return Path() }
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        let last = points[upperEnd]
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + glassTop + last.y))
        path.addLine(to: CGPoint(x: rect.minX + last.x, y: rect.minY + glassTop + last.y))
        for index in stride(from: upperEnd, through: 1, by: -1) {
            let previous = points[index + 1]
            let current = points[index]
            let next = points[index - 1]
            let following = index > 1 ? points[index - 2] : points[points.count - 1]
            path.addCurve(to: CGPoint(x: rect.minX + next.x, y: rect.minY + glassTop + next.y),
                control1: CGPoint(x: rect.minX + current.x + (next.x - previous.x) / 6,
                                  y: rect.minY + glassTop + current.y + (next.y - previous.y) / 6),
                control2: CGPoint(x: rect.minX + next.x - (following.x - current.x) / 6,
                                  y: rect.minY + glassTop + next.y - (following.y - current.y) / 6))
        }
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + glassTop + points[0].y))
        path.closeSubpath()
        return path
    }
}

private struct AgentReasoningTitleTextKey: LayoutValueKey { static let defaultValue = "" }
private struct AgentReasoningTitlePointSizeKey: LayoutValueKey { static let defaultValue: CGFloat = 0 }
private struct AgentReasoningTitleSpacingKey: LayoutValueKey { static let defaultValue: CGFloat = 0 }
private struct AgentReasoningTitleAngleKey: LayoutValueKey { static let defaultValue: CGFloat = 0 }
private struct AgentReasoningTitleCenterReferenceKey: LayoutValueKey { static let defaultValue = "" }

private enum AgentReasoningTitleMetrics {
    private final class Entry: NSObject {
        let width: CGFloat
        let inkBottom: CGFloat
        let inkHeight: CGFloat
        init(width: CGFloat, inkBottom: CGFloat, inkHeight: CGFloat) {
            self.width = width; self.inkBottom = inkBottom; self.inkHeight = inkHeight
        }
    }
    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>(); cache.countLimit = 128; return cache
    }()
    private static func metrics(_ text: String, pointSize: CGFloat) -> Entry {
        let key = "\(pointSize)|\(text)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text,
            attributes: [.font: UIFont.systemFont(ofSize: pointSize, weight: .semibold)]))
        let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        let entry = Entry(width: CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)),
            inkBottom: ink.minY, inkHeight: ink.height)
        cache.setObject(entry, forKey: key)
        return entry
    }
    static func width(_ text: String, pointSize: CGFloat) -> CGFloat { metrics(text, pointSize: pointSize).width }
    static func inkBottom(_ text: String, pointSize: CGFloat) -> CGFloat { metrics(text, pointSize: pointSize).inkBottom }
    static func modelScale(_ model: String, matching effort: String, pointSize: CGFloat) -> CGFloat {
        guard !model.isEmpty, !effort.isEmpty else { return 1 }
        let modelInkHeight = metrics(model, pointSize: pointSize).inkHeight
        let effortInkHeight = metrics(effort, pointSize: pointSize).inkHeight
        guard modelInkHeight > 0, effortInkHeight > 0 else { return 1 }
         
        return min(1.5, max(1, effortInkHeight / modelInkHeight))
    }
    static func centerLift(_ text: String, relativeTo reference: String, pointSize: CGFloat) -> CGFloat {
        guard !reference.isEmpty else { return 0 }
        return (metrics(reference, pointSize: pointSize).inkHeight - metrics(text, pointSize: pointSize).inkHeight) / 2
    }
}

 
 
 
private struct AgentReasoningEdgeTitleLayout: Layout {
    let width: CGFloat
    let height: CGFloat
    let pointSize: CGFloat
    let glassTop: CGFloat
    let glassHeight: CGFloat
    let bend: CGFloat
    let focus: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: width, height: height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let dimensions = subviews.map { $0.dimensions(in: .unspecified) }
        let total = subviews.indices.reduce(CGFloat(0)) { result, index in
            result + dimensions[index].width + subviews[index][AgentReasoningTitleSpacingKey.self]
        }
        var left = bounds.midX - total / 2
        for index in subviews.indices {
            let view = subviews[index], size = dimensions[index]
            left += view[AgentReasoningTitleSpacingKey.self]
            let centerX = left + size.width / 2 - bounds.minX
            let attachment = AgentRubberBandGeometry.titleAttachment(centerX: centerX,
                textWidth: size.width, glassWidth: width, glassHeight: glassHeight, focus: focus, bend: bend)
            let angle = view[AgentReasoningTitleAngleKey.self]
            let text = view[AgentReasoningTitleTextKey.self]
            let glyphPointSize = view[AgentReasoningTitlePointSizeKey.self] > 0
                ? view[AgentReasoningTitlePointSizeKey.self] : pointSize
             
             
            let centerLift = AgentReasoningTitleMetrics.centerLift(text,
                relativeTo: view[AgentReasoningTitleCenterReferenceKey.self], pointSize: glyphPointSize)
            let visibleBottom = size[.firstTextBaseline]
                - AgentReasoningTitleMetrics.inkBottom(text, pointSize: glyphPointSize) + centerLift
            let descent = size.height - visibleBottom
             
             
            let originX = left - descent * sin(angle)
            let originY = bounds.minY + glassTop + attachment.y - size.height + descent * cos(angle)
            view.place(at: CGPoint(x: originX, y: originY), anchor: .topLeading,
                proposal: ProposedViewSize(width: size.width, height: size.height))
            left += size.width
        }
    }
}

private struct AgentReasoningEdgeTitle: View {
    let modelTitle: String
    let effort: String
    let pointSize: CGFloat
    let width: CGFloat
    let height: CGFloat
    let glassTop: CGFloat
    let glassHeight: CGFloat
    let bend: CGFloat
    let focus: CGFloat
    @State private var titleGlyphs: AgentReasoningTitleGlyphs
    @State private var movesUp = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    init(modelTitle: String, effort: String, pointSize: CGFloat, width: CGFloat, height: CGFloat,
         glassTop: CGFloat, glassHeight: CGFloat, bend: CGFloat, focus: CGFloat) {
        self.modelTitle = modelTitle; self.effort = effort; self.pointSize = pointSize
        self.width = width; self.height = height; self.glassTop = glassTop; self.glassHeight = glassHeight
        self.bend = bend; self.focus = focus
        _titleGlyphs = State(initialValue: AgentReasoningTitleGlyphs(title: reasoningTitle(effort)))
    }
    private static let order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    private var modelScale: CGFloat {
        AgentReasoningTitleMetrics.modelScale(modelTitle,
            matching: titleGlyphs.glyphs.map(\.text).joined(), pointSize: pointSize)
    }
    private var fittingPointSize: CGFloat {
        let natural = (modelTitle.isEmpty ? 0 : AgentReasoningTitleMetrics.width(modelTitle, pointSize: pointSize * modelScale)
            + AgentReasoningTitleMetrics.width("·", pointSize: pointSize) + 8)
            + titleGlyphs.glyphs.reduce(CGFloat(0)) { $0 + AgentReasoningTitleMetrics.width($1.text, pointSize: pointSize) }
         
        return pointSize * min(1, max(0.01, width - glassHeight - 8) / max(natural, 1))
    }
    private var transition: AnyTransition {
        guard !reduceMotion else { return .identity }
        let distance = fittingPointSize * 0.8
        return .asymmetric(
            insertion: .offset(y: movesUp ? distance : -distance).combined(with: .opacity),
            removal: .offset(y: movesUp ? -distance : distance).combined(with: .opacity))
    }
    var body: some View {
        let size = fittingPointSize
        let modelSize = size * modelScale
        let modelWidth = AgentReasoningTitleMetrics.width(modelTitle, pointSize: modelSize)
        let separatorWidth = AgentReasoningTitleMetrics.width("·", pointSize: size)
        let glyphWidths = titleGlyphs.glyphs.map { AgentReasoningTitleMetrics.width($0.text, pointSize: size) }
        let prefix = modelTitle.isEmpty ? 0 : modelWidth + separatorWidth + 8
        let total = prefix + glyphWidths.reduce(0, +)
        let start = (width - total) / 2
        AgentReasoningEdgeTitleLayout(width: width, height: height, pointSize: size,
            glassTop: glassTop, glassHeight: glassHeight, bend: bend, focus: focus) {
            if !modelTitle.isEmpty {
                Text(modelTitle).contentTransition(.numericText())
                    .font(.system(size: modelSize, weight: .semibold))
                    .lineLimit(1).fixedSize().frame(width: modelWidth)
                    .rotationEffect(.radians(Double(angle(at: start + modelWidth / 2))), anchor: .bottom)
                    .layoutValue(key: AgentReasoningTitleTextKey.self, value: modelTitle)
                    .layoutValue(key: AgentReasoningTitlePointSizeKey.self, value: modelSize)
                    .layoutValue(key: AgentReasoningTitleAngleKey.self, value: angle(at: start + modelWidth / 2))
                Text("·").fixedSize().frame(width: separatorWidth)
                    .rotationEffect(.radians(Double(angle(at: start + modelWidth + 4 + separatorWidth / 2))), anchor: .bottom)
                    .layoutValue(key: AgentReasoningTitleTextKey.self, value: "·")
                    .layoutValue(key: AgentReasoningTitleCenterReferenceKey.self,
                        value: titleGlyphs.glyphs.map(\.text).joined())
                    .layoutValue(key: AgentReasoningTitleSpacingKey.self, value: 4)
                    .layoutValue(key: AgentReasoningTitleAngleKey.self, value: angle(at: start + modelWidth + 4 + separatorWidth / 2))
            }
            ForEach(Array(titleGlyphs.glyphs.enumerated()), id: \.element.id) { index, glyph in
                let x = start + prefix + glyphWidths.prefix(index).reduce(0, +) + glyphWidths[index] / 2
                Text(glyph.text).fixedSize().frame(width: glyphWidths[index])
                    .rotationEffect(.radians(Double(angle(at: x))), anchor: .bottom)
                    .layoutValue(key: AgentReasoningTitleTextKey.self, value: glyph.text)
                    .layoutValue(key: AgentReasoningTitleSpacingKey.self, value: index == 0 && !modelTitle.isEmpty ? 4 : 0)
                    .layoutValue(key: AgentReasoningTitleAngleKey.self, value: angle(at: x))
                    .transition(transition)
            }
        }
        .font(.system(size: size, weight: .semibold)).foregroundStyle(.primary)
        .allowsHitTesting(false).accessibilityHidden(true)
        .accessibilityIdentifier("reasoning-current-title")
        .onChange(of: effort) { old, new in
            movesUp = (Self.order.firstIndex(of: new) ?? 0) >= (Self.order.firstIndex(of: old) ?? 0)
            if reduceMotion {
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) { titleGlyphs.update(title: reasoningTitle(new)) }
            } else {
                withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                    titleGlyphs.update(title: reasoningTitle(new))
                }
            }
        }
    }
    private func angle(at x: CGFloat) -> CGFloat {
        atan(AgentRubberBandGeometry.upperEdgeSample(x: x, width: width,
            height: glassHeight, focus: focus, bend: bend).slope)
    }
}

struct AgentReasoningControl: View {
     
     
    static let lowerGlassReserve: CGFloat = AgentReasoningTrackLayout.elasticReserve + AgentReasoningTrackLayout.bottomInset
    static let glassHeight: CGFloat = AgentReasoningTrackLayout.glassHeight
    static let glassHorizontalInset: CGFloat = AgentReasoningTrackLayout.horizontalInset
    static func glassBottomGap(keyboardVisible: Bool, bottomGap: CGFloat) -> CGFloat {
        keyboardVisible ? 16 : lowerGlassReserve + max(0, bottomGap - AgentComposerLayout.gutter)
    }

     
     
     
    static func backdropEnvelope(in bounds: CGRect) -> CGRect {
        let titleReserve = max(0, bounds.height - Layout.viewportHeight - Layout.bottomInset)
        let titleSize = titleReserve / 1.5
        let glass = CGRect(x: bounds.minX + Layout.horizontalInset,
                           y: bounds.minY + titleReserve + Layout.elasticReserve,
                           width: max(0, bounds.width - 2 * Layout.horizontalInset),
                           height: Layout.glassHeight)
        let title = CGRect(x: glass.minX, y: glass.minY - titleSize * 1.25,
                           width: glass.width, height: titleSize * 1.25)
        return glass.union(title).insetBy(dx: 0, dy: -AgentRubberBandGeometry.maximumBend)
    }

    let models: [AgentModelOption]
    @Binding var model: String
    @Binding var selected: String
    let dismiss: () -> Void
    @State private var interaction: AgentSlingInteraction?
    @State private var confirmedEffort: String?
    @GestureState private var activeGestureID: UUID?
    @State private var interactionGestureID: UUID?
    @State private var feedback = UISelectionFeedbackGenerator()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title2) private var headingSize: CGFloat = 22
    private typealias Layout = AgentReasoningTrackLayout
    private var orderedModels: [AgentModelOption] {
        AgentModelPowerOrder.indices(for: models.map(\.id)).map { models[$0] }
    }
    private var modelIndex: Int { orderedModels.firstIndex { $0.id == model } ?? 0 }
    private var previewModel: AgentModelOption? {
        guard !orderedModels.isEmpty else { return nil }
        return orderedModels[min(max(interaction?.modelIndex ?? modelIndex, 0), orderedModels.count - 1)]
    }
    private var previewReasoning: String {
        guard let option = previewModel else { return selected }
        if let interaction {
            return AgentSlingGestureMath.anchoredEffort(offset: interaction.previewEffortOffset,
                levels: option.reasoningEfforts, fallback: option.defaultReasoning)
        }
        if let confirmedEffort, option.reasoningEfforts.contains(confirmedEffort) { return confirmedEffort }
         
        return AgentSlingGestureMath.highAnchor(levels: option.reasoningEfforts, fallback: option.defaultReasoning)
    }
    private var modelTitle: String {
        guard let option = previewModel else { return "" }
        let name = AgentComposerLayout.shortModelName(id: option.id, displayName: option.displayName)
        return name + (AgentModelPowerOrder.isRanked(option.id) ? "" : " · 未分级")
    }
    private var title: String {
        (modelTitle.isEmpty ? "" : modelTitle + " · ") + reasoningTitle(previewReasoning)
    }
    private var presentationHeight: CGFloat { Layout.viewportHeight + headingSize * Layout.scale * 1.5 }
    var body: some View {
            GeometryReader { geo in
                let width = geo.size.width
                let innerWidth = max(0, width - 2 * Layout.trackHorizontalPadding)
                let step = max(1, (innerWidth - Layout.trackHeight) / CGFloat(max(orderedModels.count - 1, 1)))
                let position = interaction?.position ?? CGFloat(modelIndex)
                let ringX = Layout.trackHorizontalPadding + Layout.firstCenter + position * step
                AgentRubberBandTrack(modelCount: orderedModels.count,
                    highlightedIndex: interaction?.modelIndex ?? modelIndex,
                    position: position,
                    bend: reduceMotion ? 0 : AgentRubberBandGeometry.displacement(pull: interaction?.pull ?? 0),
                    focus: ringX / max(width, 1), modelTitle: modelTitle, effort: previewReasoning,
                    titlePointSize: headingSize * Layout.scale)
                .frame(width: width, height: presentationHeight)
                .contentShape(Rectangle())
                .gesture(slingGesture(step: step))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("模型与推理程度").accessibilityValue(title)
                .accessibilityHint("左右滑动切换模型，上下拉动按幅度选择推理程度，松手确认")
                .accessibilityIdentifier("agent-reasoning-track")
                .accessibilityAdjustableAction { direction in
                    adjustModel(direction == .increment ? 1 : -1)
                }
                .accessibilityAction(named: "增加推理程度") { adjustReasoning(1) }
                .accessibilityAction(named: "降低推理程度") { adjustReasoning(-1) }
            }.frame(height: presentationHeight)
            .padding(.horizontal, Layout.horizontalInset).padding(.bottom, Layout.bottomInset)
            .onChange(of: activeGestureID) { _, identifier in
                guard identifier == nil else { return }
                let finishedGesture = interactionGestureID
                 
                 
                 
                DispatchQueue.main.async {
                    guard activeGestureID == nil, finishedGesture == interactionGestureID, interaction != nil else { return }
                    rebound(cancelled: true)
                }
            }
            .onDisappear {
                interaction?.cancel()
                interactionGestureID = nil
                interaction = nil
            }
    }
    private func slingGesture(step: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 3)
            .updating($activeGestureID) { _, identifier, _ in
                if identifier == nil { identifier = UUID() }
            }
            .onChanged { value in
                guard !orderedModels.isEmpty else { return }
                let beginsNewGesture = interaction == nil || interactionGestureID != activeGestureID
                var next = interaction ?? AgentSlingInteraction(modelIndex: modelIndex, reasoning: selected)
                if beginsNewGesture {
                    next = AgentSlingInteraction(modelIndex: modelIndex, reasoning: selected)
                    interactionGestureID = activeGestureID
                    feedback.prepare()
                }
                let previousModel = next.modelIndex
                let previousReasoning = next.previewEffortOffset
                next.update(translation: value.translation, step: step, modelCount: orderedModels.count)
                interaction = next
                if next.modelIndex != previousModel || next.previewEffortOffset != previousReasoning {
                    feedback.selectionChanged()
                }
            }
            .onEnded { value in
                guard var final = interaction, !orderedModels.isEmpty else { return }
                final.update(translation: value.translation, step: step, modelCount: orderedModels.count)
                let option = orderedModels[min(max(final.modelIndex, 0), orderedModels.count - 1)]
                guard let effort = final.effortForRelease(levels: option.reasoningEfforts,
                                                         fallback: option.defaultReasoning) else {
                    rebound(cancelled: false)
                    return
                }
                 
                 
                if model != option.id { model = option.id }
                if selected != effort { selected = effort }
                confirmedEffort = effort
                rebound(cancelled: false)
            }
    }
    private func rebound(cancelled: Bool) {
        withAnimation(reduceMotion ? nil : .interpolatingSpring(stiffness: 360, damping: 28)) {
            if cancelled { interaction?.cancel() }
            interaction = nil
            interactionGestureID = nil
        }
    }
    private func adjustModel(_ delta: Int) {
        guard !orderedModels.isEmpty else { return }
        let option = orderedModels[min(max(modelIndex + delta, 0), orderedModels.count - 1)]
        let effort = AgentSlingGestureMath.highAnchor(levels: option.reasoningEfforts,
                                                     fallback: option.defaultReasoning)
        if model != option.id { model = option.id }
        if selected != effort { selected = effort }
        confirmedEffort = effort
    }
    private func adjustReasoning(_ delta: Int) {
        guard let option = previewModel else { return }
        let effort = AgentSlingGestureMath.steppedEffort(previewReasoning, delta: delta,
            levels: option.reasoningEfforts, fallback: option.defaultReasoning)
        if selected != effort { selected = effort }
        confirmedEffort = effort
    }
}

struct AgentGauge: View, Animatable {
    var value: Double
    var animatableData: Double { get { value } set { value = newValue } }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { tick in
            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let radius = min(size.width, size.height) / 2 - 2
                let level = min(max(value, 0), 1)
                let phase = reduceMotion ? 0.0 :
                    sin(tick.date.timeIntervalSinceReferenceDate * .pi * 2 / 1.8)

                 
                 
                 
                let blueEnd = 135.0 + 270.0 * (0.30 + 0.67 * level + 0.025 * phase)
                var remainder = Path()
                remainder.addArc(center: center, radius: radius,
                                 startAngle: .degrees(blueEnd), endAngle: .degrees(405), clockwise: false)
                context.stroke(remainder, with: .color(Color.gray.opacity(0.36)),
                               style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

                var active = Path()
                active.addArc(center: center, radius: radius,
                              startAngle: .degrees(135), endAngle: .degrees(blueEnd), clockwise: false)
                context.stroke(active, with: .color(Color(red: 0.20, green: 0.40, blue: 0.92)),
                               style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

                 
                let theta = blueEnd * .pi / 180
                let hubRadius: CGFloat = 2.8
                var hand = Path()
                hand.move(to: CGPoint(x: center.x + cos(theta) * hubRadius,
                                      y: center.y + sin(theta) * hubRadius))
                hand.addLine(to: CGPoint(x: center.x + cos(theta) * radius * 0.76,
                                         y: center.y + sin(theta) * radius * 0.76))
                context.stroke(hand, with: .color(.primary),
                               style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
                var hub = Path()
                hub.addEllipse(in: CGRect(x: center.x - hubRadius, y: center.y - hubRadius,
                                           width: hubRadius * 2, height: hubRadius * 2))
                context.stroke(hub, with: .color(.primary), lineWidth: 2.6)
            }
            .frame(width: 25, height: 25)
        }
        .accessibilityHidden(true)
    }
}

struct AgentFilePreview: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController { let c = QLPreviewController(); c.dataSource = context.coordinator; return c }
    func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}


struct AgentSidebarButton: View {
    let hasUnread: Bool
    var diameter: CGFloat = 46
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topLeading) {
                Path { path in
                    path.move(to: CGPoint(x: 2, y: 6))
                    path.addLine(to: CGPoint(x: hasUnread ? 10 : 19, y: 6))
                    path.move(to: CGPoint(x: 2, y: 15))
                    path.addLine(to: CGPoint(x: 12, y: 15))
                }
                .stroke(Color.primary, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                if hasUnread {
                    Circle().fill(Color.blue).frame(width: 7, height: 7).offset(x: 14, y: 2.5)
                }
            }
            .frame(width: 21, height: 21)
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .shiyanGlass(in: Circle(), tint: .white.opacity(0.04), interactive: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(hasUnread ? "历史会话，有未读消息" : "历史会话")
    }
}


