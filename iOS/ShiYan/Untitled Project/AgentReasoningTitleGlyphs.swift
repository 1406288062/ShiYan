import Foundation

struct AgentReasoningTitleGlyph: Identifiable, Equatable {
    let id: Int
    let text: String
}

 
 
struct AgentReasoningTitleGlyphs {
    private(set) var glyphs: [AgentReasoningTitleGlyph] = []
    private var nextIdentity = 0

    init(title: String) {
        update(title: title)
    }

    mutating func update(title: String) {
        let characters = Array(title).map(String.init)
        let previous = glyphs
        var lengths = Array(repeating: Array(repeating: 0, count: characters.count + 1),
                            count: previous.count + 1)
        if !previous.isEmpty, !characters.isEmpty {
            for old in stride(from: previous.count - 1, through: 0, by: -1) {
                for new in stride(from: characters.count - 1, through: 0, by: -1) {
                    if previous[old].text == characters[new] {
                        lengths[old][new] = 1 + lengths[old + 1][new + 1]
                    } else {
                        lengths[old][new] = max(lengths[old + 1][new], lengths[old][new + 1])
                    }
                }
            }
        }
        var retained: [Int: AgentReasoningTitleGlyph] = [:]
        var old = 0
        var new = 0
        while old < previous.count, new < characters.count {
            if previous[old].text == characters[new] {
                retained[new] = previous[old]
                old += 1
                new += 1
            } else if lengths[old + 1][new] >= lengths[old][new + 1] {
                old += 1
            } else {
                new += 1
            }
        }
        glyphs = characters.enumerated().map { index, character in
            if let existing = retained[index] { return existing }
            let glyph = AgentReasoningTitleGlyph(id: nextIdentity, text: character)
            nextIdentity += 1
            return glyph
        }
    }
}
