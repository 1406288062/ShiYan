import SwiftUI

struct AgentQuestionForm: View {
    let questions: [AgentChoiceQuestion]
    let isBusy: Bool
    let submit: ([String: String]) async -> String?
    @State private var selections: [String: String] = [:]
    @State private var customAnswers: [String: String] = [:]
    @State private var submitting = false
    @State private var error: String?

    private var answers: [String: String] {
        Dictionary(uniqueKeysWithValues: questions.map { question in
            let custom = customAnswers[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            return (question.id, custom.isEmpty ? selections[question.id, default: ""] : custom)
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.title).font(.body.weight(.semibold))
                    ForEach(question.options, id: \.self) { option in
                        Button {
                            selections[question.id] = option
                            customAnswers[question.id] = ""
                            error = nil
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: selections[question.id] == option ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selections[question.id] == option ? Color.accentColor : .secondary)
                                    .padding(.top, 2)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(option).multilineTextAlignment(.leading)
                                    if let description = question.descriptions[option] {
                                        Text(description).font(.footnote).foregroundStyle(.secondary)
                                            .multilineTextAlignment(.leading)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(Color.primary.opacity(selections[question.id] == option ? 0.07 : 0.035),
                                        in: RoundedRectangle(cornerRadius: 12))
                            .contentShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selections[question.id] == option ? [.isSelected] : [])
                    }
                    TextField("也可以填写自己的答案", text: Binding(
                        get: { customAnswers[question.id, default: ""] },
                        set: { value in
                            customAnswers[question.id] = String(value.prefix(4000))
                            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { selections[question.id] = nil }
                            error = nil
                        }), axis: .vertical)
                        .lineLimit(1...4).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("自填答案：" + question.title)
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Button {
                guard !submitting, AgentChoiceQuestion.reply(questions: questions, answers: answers) != nil else { return }
                let value = answers
                submitting = true
                Task {
                    error = await submit(value)
                    submitting = false
                }
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "正在提交…" : "提交选择")
                }.frame(maxWidth: .infinity, minHeight: 32)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy || submitting || AgentChoiceQuestion.reply(questions: questions, answers: answers) == nil)
            .accessibilityIdentifier("agent-submit-choice")
        }
        .disabled(submitting || isBusy)
        .padding(16)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityIdentifier("agent-question-form")
    }
}
