import Foundation

 
 
enum HistoryMasonryLayout {
    static func columns<Item>(items: [Item], columnCount: Int, columnWidth: Double,
                              spacing: Double, aspectRatio: (Item) -> Double) -> [[Item]] {
        let count = max(1, min(6, columnCount))
        let width = columnWidth.isFinite && columnWidth > 0 ? columnWidth : 1
        let gap = spacing.isFinite ? max(0, spacing) : 0
        var columns = Array(repeating: [Item](), count: count)
        var heights = Array(repeating: 0.0, count: count)
        for item in items {
            let column = heights.indices.min { heights[$0] < heights[$1] } ?? 0
            let ratio = aspectRatio(item)
            let safeRatio = ratio.isFinite && ratio > 0 ? ratio : 1
            columns[column].append(item)
            heights[column] += width / safeRatio + gap
        }
        return columns
    }
}
