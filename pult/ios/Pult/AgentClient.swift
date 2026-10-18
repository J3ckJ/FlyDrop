import CryptoKit
import Foundation
import Network
import PultProtocol
import Security

final class AgentClient: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
    let host: String
    let port: Int
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pinned: String?
    private var opened: CheckedContinuation<Void, Error>?
    private var waiters: [String: CheckedContinuation<[String: JSON], Error>] = [:]
    private var events: ((String, [String: JSON]) -> Void)?
    private let lock = NSLock()

    init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    func pin(_ fingerprint: String) {
        pinned = Self.normalize(fingerprint)
    }

    func onEvent(_ handler: @escaping (String, [String: JSON]) -> Void) {
        events = handler
    }

    func connect() async throws {
        if let stored = UserDefaults.standard.string(forKey: "pult-fp-\(host)") {
            pinned = Self.normalize(stored)
        }
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        self.session = session
        var components = URLComponents()
        components.scheme = "wss"
        components.host = host
        components.port = port
        components.path = PultCodec.webSocketPath
        guard let url = components.url else { throw PultProtocolError.message("Некорректный адрес") }
        let task = session.webSocketTask(with: url)
        self.task = task
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            opened = continuation
            task.resume()
        }
        receive()
    }

    func request(_ type: ClientType, _ payload: [String: JSON]) async throws -> [String: JSON] {
        let id = UUID().uuidString
        let text = try PultCodec.encode(id: id, type: type, payload: payload)
        try await task?.send(.string(text))
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            waiters[id] = continuation
            lock.unlock()
            Task {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                self.fail(id: id, error: PultProtocolError.message("Нет ответа компьютера"))
            }
        }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text): self.consume(text)
                case .data(let data): _ = try? FrameCodec.decode(data)
                @unknown default: break
                }
                self.receive()
            case .failure:
                self.failAll(PultProtocolError.message("Нет связи с компьютером"))
            }
        }
    }

    private func consume(_ text: String) {
        guard let data = text.data(using: .utf8), let json = try? JSONDecoder().decode(JSON.self, from: data), let object = json.object else { return }
        if let id = object["id"]?.string {
            lock.lock()
            let waiter = waiters.removeValue(forKey: id)
            lock.unlock()
            if object["ok"]?.bool == true {
                waiter?.resume(returning: object["payload"]?.object ?? [:])
            } else {
                waiter?.resume(throwing: PultProtocolError.message(object["error"]?.string ?? "Ошибка"))
            }
            return
        }
        if let type = object["type"]?.string {
            events?(type, object["payload"]?.object ?? [:])
        }
    }

    private func fail(id: String, error: Error) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: id)
        lock.unlock()
        waiter?.resume(throwing: error)
    }

    private func failAll(_ error: Error) {
        lock.lock()
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending.values { waiter.resume(throwing: error) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        opened?.resume()
        opened = nil
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        opened?.resume(throwing: PultProtocolError.message("Нет связи с компьютером"))
        opened = nil
        failAll(PultProtocolError.message("Нет связи с компьютером"))
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = leaf.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        if let pinned, pinned != digest {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private static func normalize(_ fingerprint: String) -> String {
        fingerprint.replacingOccurrences(of: ":", with: "").lowercased()
    }
}

final class FinishGate: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        return true
    }
}

struct DiscoveredHost: Identifiable, Equatable {
    var id: String { "\(name)@\(host):\(port)" }
    var name: String
    var host: String
    var port: Int
}

final class Discovery {
    private var browser: NWBrowser?

    func start(onChange: @escaping ([DiscoveredHost]) -> Void) {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "\(PultCodec.serviceType).", domain: "local."), using: parameters)
        browser.browseResultsChangedHandler = { results, _ in
            var hosts: [DiscoveredHost] = []
            let group = DispatchGroup()
            for result in results {
                group.enter()
                let connection = NWConnection(to: result.endpoint, using: .tcp)
                let gate = FinishGate()
                connection.stateUpdateHandler = { state in
                    let done: Bool
                    switch state {
                    case .ready, .failed, .cancelled: done = gate.finish()
                    case .setup, .preparing, .waiting: done = false
                    @unknown default: done = gate.finish()
                    }
                    guard done else { return }
                    if case .ready = state, case .hostPort(let endpointHost, let port) = connection.currentPath?.remoteEndpoint {
                        let address: String
                        switch endpointHost {
                        case .ipv4(let value): address = "\(value)"
                        case .ipv6(let value): address = "\(value)"
                        case .name(let value, _): address = value
                        @unknown default: address = ""
                        }
                        let serviceName: String
                        if case .service(let name, _, _, _) = result.endpoint { serviceName = name } else { serviceName = address }
                        if !address.isEmpty { hosts.append(DiscoveredHost(name: serviceName, host: address, port: Int(port.rawValue))) }
                    }
                    connection.cancel()
                    group.leave()
                }
                connection.start(queue: .global())
            }
            group.notify(queue: .main) { onChange(hosts) }
        }
        browser.start(queue: .main)
        self.browser = browser
    }
}
