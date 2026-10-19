import Foundation

nonisolated struct ShiyanAuthHTTPFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

nonisolated enum ShiyanAuthRecovery {
    static let maximumAttempts = 2
    static func canRetry(_ error: Error) -> Bool {
        if error is CancellationError { return false }
        if let failure = error as? ShiyanAuthHTTPFailure { return (500...599).contains(failure.status) }
        guard let network = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
                .dnsLookupFailed, .notConnectedToInternet].contains(network.code)
    }
}
