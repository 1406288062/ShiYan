import Foundation

enum AgentMessageOrder {
    static func ordered(_ messages: [AgentMessage]) -> [AgentMessage] {
        let sorted = messages.enumerated().sorted {
            if $0.element.createdAt != $1.element.createdAt { return $0.element.createdAt < $1.element.createdAt }
            if $0.element.role != $1.element.role { return $0.element.role == .user }
            return $0.offset < $1.offset
        }.map(\.element)
        var parents: [String: UUID] = [:]
        for message in sorted where message.role == .user {
            if let request = message.requestID?.lowercased(), parents[request] == nil { parents[request] = message.id }
        }
        var children: [UUID: [AgentMessage]] = [:]
        var linked = Set<UUID>()
        for message in sorted where message.role == .assistant {
            if let request = message.requestID?.lowercased(), let parent = parents[request] {
                children[parent, default: []].append(message); linked.insert(message.id)
            }
        }
        var result: [AgentMessage] = []
        for message in sorted where !linked.contains(message.id) {
            result.append(message); result.append(contentsOf: children[message.id] ?? [])
        }
        return result
    }
}
