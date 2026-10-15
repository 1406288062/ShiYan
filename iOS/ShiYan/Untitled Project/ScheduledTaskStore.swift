import Foundation
import Combine

@MainActor
final class ScheduledTaskStore: ObservableObject {
    static let shared = ScheduledTaskStore()
    @Published private(set) var tasks: [ScheduledTask] = []
    @Published private(set) var isLoading = false
    @Published var lastError: String?
    @Published private(set) var host: ScheduledTaskHost?
    @Published private(set) var pending: ScheduledTaskPending?
    private var refreshing = false
    private var mutating = false
    private var defaults: UserDefaults { .standard }
    private let cacheKey = "shiyan.desktop-schedules.cache.v1"
    private let pendingKey = "shiyan.desktop-schedules.pending.v1"

    private init() {
        if let data = defaults.data(forKey: cacheKey) { tasks = (try? JSONDecoder().decode([ScheduledTask].self, from: data)) ?? [] }
        if let data = defaults.data(forKey: pendingKey) { pending = try? JSONDecoder().decode(ScheduledTaskPending.self, from: data) }
    }
    private func persist() {
        if let bytes = try? JSONEncoder().encode(tasks) { defaults.set(bytes, forKey: cacheKey) }
        if let pending, let bytes = try? JSONEncoder().encode(pending) { defaults.set(bytes, forKey: pendingKey) }
        else { defaults.removeObject(forKey: pendingKey) }
    }
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true; isLoading = tasks.isEmpty
        defer { refreshing = false; isLoading = false }
        do {
            if pending != nil && !mutating { try await retryPending() }
            let response = try await CodexClient.shared.scheduledTaskListing()
            tasks = response.tasks.sorted {
                if $0.nextRun != $1.nextRun { return ($0.nextRun ?? .distantFuture) < ($1.nextRun ?? .distantFuture) }
                return $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
            host = response.host; lastError = nil; persist()
        } catch { lastError = error.localizedDescription }
    }
    func save(_ task: ScheduledTask) async throws {
        guard !mutating && pending == nil else { throw AgentClientError.message("上一项修改等待确认，请刷新后继续") }
        var value = task
        if task.revision == 0, let host {
            let choices = task.runLocally ? host.local : host.cloud
            if let model = choices.first(where: { $0.id == host.defaultModel }) ?? choices.first {
                value.model = model.id; value.reasoning = model.defaultReasoning
            }
        }
        pending = ScheduledTaskPending(requestId: UUID().uuidString.lowercased(), id: value.id, revision: value.revision,
            method: value.revision == 0 ? "POST" : "PATCH", route: value.revision == 0 ? "sync/schedules" : "sync/schedules/" + value.id, task: value)
        persist(); try await retryPending(); await refresh()
    }
    func setPaused(taskId: String, paused: Bool) async throws {
        guard var task = tasks.first(where: { $0.id == taskId }) else { throw AgentClientError.message("任务不存在，请刷新") }
        task.enabled = !paused; try await save(task)
    }
    func delete(taskId: String) async throws {
        guard !mutating && pending == nil else { throw AgentClientError.message("上一项修改等待确认，请刷新后继续") }
        guard let task = tasks.first(where: { $0.id == taskId }) else { return }
        pending = ScheduledTaskPending(requestId: UUID().uuidString.lowercased(), id: taskId, revision: task.revision,
            method: "DELETE", route: "sync/schedules/" + taskId, task: nil)
        persist(); try await retryPending(); await refresh()
    }
    func retryPending() async throws {
        guard let operation = pending, !mutating else { return }
        mutating = true; defer { mutating = false }
        do {
            let result = try await CodexClient.shared.scheduledTaskMutate(operation)
            if let task = result.task {
                if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task } else { tasks.append(task) }
            } else if result.deleted == true { tasks.removeAll { $0.id == operation.id } }
            pending = nil; lastError = nil; persist()
        } catch let rejected as ScheduledTaskRejected {
             
            pending = nil; lastError = rejected.message; persist(); throw rejected
        } catch {
            lastError = "修改等待服务器确认，刷新将使用同一请求重试。"; persist(); throw error
        }
    }
}
