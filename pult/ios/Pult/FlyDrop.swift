import CryptoKit
import Foundation
import PultProtocol
import Security

enum FlyDropUpload {
    static func send(host: String, port: Int, code: String, hostId: String, fingerprint: String, filename: String, data: Data, progress: @escaping (Int) -> Void) async throws {
        let session = FlyDropSession(fingerprint: fingerprint)
        let origin = "https://\(host):\(port)"
        let started = try await session.post(path: "/api/connect", origin: origin, json: ["code": code, "name": "iPhone", "type": "phone"])
        guard started.status == 202, let requestId = started.json["requestId"] as? String, let token = started.json["token"] as? String else {
            throw PultProtocolError.message("FlyDrop не принял код")
        }
        var cookie = ""
        for _ in 0..<24 {
            let status = try await session.post(path: "/api/pair-status", origin: origin, json: ["requestId": requestId, "token": token])
            if status.status == 200, let header = status.cookie, !header.isEmpty {
                cookie = header
                break
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        if cookie.isEmpty { throw PultProtocolError.message("Компьютер не подтвердил FlyDrop") }
        try await session.upload(origin: origin, cookie: cookie, hostId: hostId, filename: filename, data: data, progress: progress)
    }
}

private struct FlyDropResult {
    var status: Int
    var json: [String: Any]
    var cookie: String?
}

private final class FlyDropSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let fingerprint: String
    private var progress: ((Int) -> Void)?
    private lazy var session: URLSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    init(fingerprint: String) {
        self.fingerprint = fingerprint.replacingOccurrences(of: ":", with: "").lowercased()
    }

    func post(path: String, origin: String, json: [String: String]) async throws -> FlyDropResult {
        var request = URLRequest(url: URL(string: origin + path)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let status = http?.statusCode, status >= 400, let message = object["error"] as? String {
            throw PultProtocolError.message(message)
        }
        return FlyDropResult(status: http?.statusCode ?? 0, json: object, cookie: http?.value(forHTTPHeaderField: "Set-Cookie"))
    }

    func upload(origin: String, cookie: String, hostId: String, filename: String, data: Data, progress: @escaping (Int) -> Void) async throws {
        self.progress = progress
        var request = URLRequest(url: URL(string: origin + "/api/upload")!)
        request.httpMethod = "POST"
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(hostId, forHTTPHeaderField: "X-Recipient")
        request.setValue(filename.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filename, forHTTPHeaderField: "X-Filename")
        request.setValue(cookie.split(separator: ";").first.map(String.init) ?? cookie, forHTTPHeaderField: "Cookie")
        let (body, response) = try await session.upload(for: request, from: data)
        let http = response as? HTTPURLResponse
        if let status = http?.statusCode, status >= 400 {
            let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            throw PultProtocolError.message(object?["error"] as? String ?? "Файл не отправлен")
        }
        progress(100)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        progress?(Int(totalBytesSent * 100 / totalBytesExpectedToSend))
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        if !fingerprint.isEmpty && digest != fingerprint {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
