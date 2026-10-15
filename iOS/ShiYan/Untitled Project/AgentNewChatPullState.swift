import Foundation

 
struct AgentNewChatPullState {
    static let armDistance = 108.0
    static let disarmDistance = 84.0
    private(set) var distance = 0.0
    private(set) var isArmed = false
    private var didGiveReadyFeedback = false

    var progress: Double { isArmed ? 1 : min(distance / Self.armDistance, 1) }
    var reveal: Double { min(distance / 34, 1) }
    var resistedDistance: Double { 132 * (1 - exp(-distance / 180)) }

     
    mutating func update(distance: Double) -> Bool {
        self.distance = distance.isFinite ? max(0, distance) : 0
        if self.distance >= Self.armDistance { isArmed = true }
        else if self.distance < Self.disarmDistance { isArmed = false }
        guard isArmed, !didGiveReadyFeedback else { return false }
        didGiveReadyFeedback = true
        return true
    }

    mutating func finish(cancelled: Bool) -> Bool {
        let commit = isArmed && !cancelled
        self = Self()
        return commit
    }
}
