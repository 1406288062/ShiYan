import Foundation

nonisolated struct AgentChoiceQuestion: Identifiable, Equatable, Sendable {
    let title: String
    let options: [String]
    private let questionID: String?
    let descriptions: [String: String]
    init(title: String, options: [String], id: String? = nil, descriptions: [String: String] = [:]) {
        self.title = title; self.options = options; self.questionID = id; self.descriptions = descriptions
    }
    var id: String { questionID ?? (title + "\u{1F}" + options.joined(separator: "\u{1F}")) }

    // The current transport renders input requests as question + Markdown list.
    // Recognize complete, explicit questions; never turn ordinary lists into UI.
    static func parse(_ text: String, isStreaming: Bool = false) -> [AgentChoiceQuestion] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var result: [AgentChoiceQuestion] = []
        var inFence = false
        var index = 0
        while index < lines.count, result.count < 3 {
            let line = lines[index].trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") { inFence.toggle(); index += 1; continue }
            guard !inFence, line.count <= 1000,
                  line.hasSuffix("？") || line.hasSuffix("?"),
                  !line.hasPrefix(">"), !line.hasPrefix("- "), !line.hasPrefix("* ") else {
                index += 1; continue
            }
            var next = index + 1
            while next < lines.count, lines[next].trimmingCharacters(in: .whitespaces).isEmpty { next += 1 }
            var options: [String] = []
            while next < lines.count {
                let value = lines[next].trimmingCharacters(in: .whitespaces)
                guard value.hasPrefix("- ") || value.hasPrefix("* ") || value.hasPrefix("• ") else { break }
                let label = String(value.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                guard !label.isEmpty, label.count <= 1000 else { break }
                options.append(label); next += 1
            }
            let ended = next < lines.count || !isStreaming
            if ended, (2...6).contains(options.count), Set(options).count == options.count {
                let question = AgentChoiceQuestion(title: line, options: options)
                if !result.contains(where: { $0.id == question.id }) { result.append(question) }
            }
            index = max(index + 1, next)
        }
        return result
    }

    static func reply(questions: [AgentChoiceQuestion], answers: [String: String]) -> String? {
        guard (1...3).contains(questions.count) else { return nil }
        var parts: [String] = []
        for question in questions {
            guard let answer = answers[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !answer.isEmpty, answer.count <= 4000 else { return nil }
            parts.append("关于「\(question.title)」，我的选择是：\(answer)")
        }
        return parts.joined(separator: "\n\n") + "\n\n请按这些选择继续当前任务。"
    }
}

// Structured questions belong to the running server job, not to reply text.
nonisolated struct AgentLiveInputOption: Decodable, Equatable, Sendable {
    let label: String
    let description: String?
}
nonisolated struct AgentLiveInputQuestion: Decodable, Equatable, Sendable {
    let id: String
    let question: String
    let options: [AgentLiveInputOption]?
    var choice: AgentChoiceQuestion {
        let details = Dictionary((options ?? []).compactMap { option -> (String, String)? in
            guard let description = option.description, !description.isEmpty else { return nil }
            return (option.label, description)
        }, uniquingKeysWith: { _, last in last })
        return AgentChoiceQuestion(title: question, options: (options ?? []).map(\.label), id: id, descriptions: details)
    }
}
nonisolated struct AgentLiveInputRequest: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let jobId: String
    let status: String
    let questions: [AgentLiveInputQuestion]
    var choices: [AgentChoiceQuestion] { questions.map(\.choice) }
    func answerPayload(_ answers: [String: String]) -> [String: [String: [String]]]? {
        guard status == "pending", (1...3).contains(questions.count),
              Set(questions.map(\.id)).count == questions.count,
              Set(answers.keys) == Set(questions.map(\.id)),
              AgentChoiceQuestion.reply(questions: choices, answers: answers) != nil else { return nil }
        return Dictionary(uniqueKeysWithValues: questions.map { ($0.id, ["answers": [answers[$0.id]!.trimmingCharacters(in: .whitespacesAndNewlines)]]) })
    }
}
nonisolated struct AgentLiveInputListing: Decodable, Sendable { let pendingQuestions: [AgentLiveInputRequest] }
nonisolated struct AgentLiveInputAnswer: Decodable, Sendable { let request: AgentLiveInputRequest }
nonisolated struct AgentLiveInputScope: Hashable, Sendable {
    let conversationID: UUID
    let messageID: UUID
    let jobID: String
    let accountGeneration: UUID
    let isWorking: Bool
}
