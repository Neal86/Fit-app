import Foundation
import CoreFoundation
import CryptoKit

// Native-owned policy. Both independent recipient controls are intentionally empty.
// Activating accounts requires reviewed source changes and physical-device acceptance.
enum NativeAccountPolicy {
    static let endpoint: String? = nil
    static let allowedEndpoints: Set<String> = []
    static let channel = "FitflowNativeAccounts"
    static let origin = "capacitor://localhost"
    static let requestBytes = 8 * 1024
    static let snapshotBytes = 10 * 1024 * 1024 + 1024
    static let responseBytes = 10 * 1024 * 1024 + 64 * 1024
    static let challengeBytes = 256 * 1024
    static let exportBytes = 64 * 1024 * 1024
    static let errorBytes = 1024
    static let timeout: TimeInterval = 20
    static let absoluteLifetime: TimeInterval = 8 * 60 * 60
    static let idleLifetime: TimeInterval = 30 * 60
    static let ledgerLimit = 4096

    static func recipient() -> URL? {
        guard let value = endpoint, allowedEndpoints.contains(value), canonicalEndpoint(value) else { return nil }
        return URL(string: value)
    }

    static func canonicalEndpoint(_ value: String) -> Bool {
        guard value.utf8.count <= 2048, value.hasPrefix("https://"),
              !value.contains(where: { $0.isWhitespace || "\\%?#".contains($0) }),
              let parts = URLComponents(string: value), let host = parts.host,
              !host.isEmpty, host == host.lowercased(), parts.scheme == "https",
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path == "/api/native/v1", parts.port != 443,
              parts.port.map({ $0 > 0 && $0 <= 65535 }) ?? true,
              let url = parts.url, url.absoluteString == value else { return false }
        // Round-trip the authority too: URLComponents may preserve noncanonical port text.
        let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let canonical = "https://" + authority + (parts.port.map { ":\($0)" } ?? "") + "/api/native/v1"
        return canonical == value
    }
}

enum NativeAccountFailure: String, Error {
    case unavailable, invalid_request, invalid_response, cancelled, expired, network_error, busy, context_exhausted
}

// Main owns cancellation writes; codecs only read this lock-protected fence.
final class NativeAccountCodecFence {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

// Preflight is token-aware: braces in escaped strings do not count as nesting.
// It rejects oversized, invalid UTF-8, deeply nested, huge-node and negative-zero
// documents BEFORE Foundation builds an object graph. No diagnostics contain input.
enum NativeAccountJSON {
    static func parse(_ data: Data, limit: Int, isCancelled: @escaping () -> Bool = { false }) throws -> Any {
        try decode(data, limit: limit, wire: false, isCancelled: isCancelled)
    }
    // Exactly one dedicated-channel wrapper adds one depth and four value nodes.
    // Its nested port is separately checked with the unchanged ordinary budget.
    static func parseWire(_ data: Data, limit: Int, isCancelled: @escaping () -> Bool = { false }) throws -> Any {
        try decode(data, limit: limit, wire: true, isCancelled: isCancelled)
    }
    private static func decode(_ data: Data, limit: Int, wire: Bool, isCancelled: @escaping () -> Bool) throws -> Any {
        guard data.count <= limit, String(data: data, encoding: .utf8) != nil else { throw NativeAccountFailure.invalid_request }
        guard !isCancelled() else { throw NativeAccountFailure.cancelled }
        var scanner = Scanner(bytes: Array(data), maxDepth: wire ? 33 : 32, maxNodes: wire ? 1_000_004 : 1_000_000, isCancelled: isCancelled)
        try scanner.run()
        guard !isCancelled() else { throw NativeAccountFailure.cancelled }
        let value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        guard !isCancelled() else { throw NativeAccountFailure.cancelled }
        try validate(value, depth: 0, maxDepth: wire ? 33 : 32)
        guard !isCancelled() else { throw NativeAccountFailure.cancelled }
        return value
    }

    static func encode(_ value: Any, limit: Int) throws -> Data { try serialize(value, limit: limit, wire: false) }
    static func encodeWire(_ value: Any, limit: Int) throws -> Data { try serialize(value, limit: limit, wire: true) }
    private static func serialize(_ value: Any, limit: Int, wire: Bool) throws -> Data {
        try validate(value, depth: 0, maxDepth: wire ? 33 : 32)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes])
        guard data.count <= limit else { throw NativeAccountFailure.invalid_request }
        var scanner = Scanner(bytes: Array(data), maxDepth: wire ? 33 : 32, maxNodes: wire ? 1_000_004 : 1_000_000)
        try scanner.run()
        return data
    }

    static func isBoolean(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }
    static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, !isBoolean(n), n.doubleValue.isFinite,
              n.doubleValue.rounded() == n.doubleValue, abs(n.doubleValue) <= 9_007_199_254_740_991,
              !(n.doubleValue == 0 && n.doubleValue.sign == .minus) else { return nil }
        return n.intValue
    }
    static func fields(_ value: Any, _ required: Set<String>, optional: Set<String> = []) throws -> [String: Any] {
        guard let object = value as? [String: Any], required.isSubset(of: Set(object.keys)),
              Set(object.keys).isSubset(of: required.union(optional)) else { throw NativeAccountFailure.invalid_request }
        return object
    }
    static func uuid(_ value: Any?) -> String? {
        guard let value = value as? String,
              value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
              value.utf8.count == 36 else { return nil }
        return value
    }
    private static func validate(_ value: Any, depth: Int, maxDepth: Int) throws {
        guard depth <= maxDepth else { throw NativeAccountFailure.invalid_request }
        if value is NSNull || value is String { return }
        if let n = value as? NSNumber {
            guard isBoolean(n) || (n.doubleValue.isFinite && !(n.doubleValue == 0 && n.doubleValue.sign == .minus)) else { throw NativeAccountFailure.invalid_request }
        } else if let array = value as? [Any] {
            for child in array { try validate(child, depth: depth + 1, maxDepth: maxDepth) }
        } else if let object = value as? [String: Any] {
            for child in object.values { try validate(child, depth: depth + 1, maxDepth: maxDepth) }
        } else { throw NativeAccountFailure.invalid_request }
    }

    private struct Scanner {
        let bytes: [UInt8]
        var offset = 0
        var nodes = 0
        var maxDepth = 32
        var maxNodes = 1_000_000
        var isCancelled: () -> Bool = { false }
        mutating func run() throws {
            try value(0); whitespace()
            guard offset == bytes.count else { throw NativeAccountFailure.invalid_request }
        }
        mutating func whitespace() { while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 } }
        mutating func take(_ byte: UInt8) -> Bool {
            guard offset < bytes.count && bytes[offset] == byte else { return false }; offset += 1; return true
        }
        mutating func value(_ depth: Int) throws {
            nodes += 1; whitespace()
            if nodes % 1024 == 0 && isCancelled() { throw NativeAccountFailure.cancelled }
            guard depth <= maxDepth, nodes <= maxNodes, offset < bytes.count else { throw NativeAccountFailure.invalid_request }
            switch bytes[offset] {
            case 123:
                offset += 1; whitespace(); if take(125) { return }
                // Reject duplicate keys, including unicode-escaped aliases.
                var keys = Set<String>()
                repeat {
                    whitespace(); let key = try string()
                    guard keys.insert(key).inserted else { throw NativeAccountFailure.invalid_request }
                    whitespace(); guard take(58) else { throw NativeAccountFailure.invalid_request }
                    try value(depth + 1); whitespace()
                    if take(125) { return }
                    guard take(44) else { throw NativeAccountFailure.invalid_request }
                } while true
            case 91:
                offset += 1; whitespace(); if take(93) { return }
                repeat {
                    try value(depth + 1); whitespace(); if take(93) { return }
                    guard take(44) else { throw NativeAccountFailure.invalid_request }
                } while true
            case 34: _ = try string(materialize: false)
            case 116: try literal("true")
            case 102: try literal("false")
            case 110: try literal("null")
            default: try number()
            }
        }
        mutating func literal(_ text: String) throws {
            for byte in text.utf8 { guard take(byte) else { throw NativeAccountFailure.invalid_request } }
        }
        mutating func hexUnit() throws -> UInt32 {
            var value: UInt32 = 0
            for _ in 0..<4 {
                guard offset < bytes.count else { throw NativeAccountFailure.invalid_request }
                let b = bytes[offset]; offset += 1
                let digit: UInt32
                switch b { case 48...57: digit = UInt32(b - 48); case 65...70: digit = UInt32(b - 55); case 97...102: digit = UInt32(b - 87); default: throw NativeAccountFailure.invalid_request }
                value = value * 16 + digit
            }
            return value
        }
        mutating func string(materialize: Bool = true) throws -> String {
            guard take(34) else { throw NativeAccountFailure.invalid_request }
            var output: [UInt8] = []
            while offset < bytes.count {
                if offset % 4096 == 0 && isCancelled() { throw NativeAccountFailure.cancelled }
                let b = bytes[offset]; offset += 1
                if b == 34 {
                    if !materialize { return "" }
                    guard let result = String(bytes: output, encoding: .utf8) else { throw NativeAccountFailure.invalid_request }; return result
                }
                guard b >= 32 else { throw NativeAccountFailure.invalid_request }
                if b != 92 { if materialize { output.append(b) }; continue }
                guard offset < bytes.count else { throw NativeAccountFailure.invalid_request }
                let escaped = bytes[offset]; offset += 1
                switch escaped {
                case 34, 47, 92: if materialize { output.append(escaped) }
                case 98: if materialize { output.append(8) }
                case 102: if materialize { output.append(12) }
                case 110: if materialize { output.append(10) }
                case 114: if materialize { output.append(13) }
                case 116: if materialize { output.append(9) }
                case 117:
                    var unit = try hexUnit()
                    if (0xD800...0xDBFF).contains(unit) {
                        guard take(92), take(117) else { throw NativeAccountFailure.invalid_request }
                        let low = try hexUnit()
                        guard (0xDC00...0xDFFF).contains(low) else { throw NativeAccountFailure.invalid_request }
                        unit = 0x10000 + (unit - 0xD800) * 1024 + low - 0xDC00
                    }
                    guard let scalar = UnicodeScalar(unit), !(0xD800...0xDFFF).contains(unit) else { throw NativeAccountFailure.invalid_request }
                    if materialize { output.append(contentsOf: String(scalar).utf8) }
                default: throw NativeAccountFailure.invalid_request
                }
            }
            throw NativeAccountFailure.invalid_request
        }
        mutating func number() throws {
            let start = offset; _ = take(45)
            if !take(48) {
                guard offset < bytes.count && (49...57).contains(bytes[offset]) else { throw NativeAccountFailure.invalid_request }
                offset += 1; while offset < bytes.count && (48...57).contains(bytes[offset]) { offset += 1 }
            }
            if take(46) { try digits() }
            if take(101) || take(69) { if !take(43) { _ = take(45) }; try digits() }
            let text = String(decoding: bytes[start..<offset], as: UTF8.self)
            guard let number = Double(text), number.isFinite, !(number == 0 && text.hasPrefix("-")) else { throw NativeAccountFailure.invalid_request }
        }
        mutating func digits() throws {
            let start = offset; while offset < bytes.count && (48...57).contains(bytes[offset]) { offset += 1 }
            guard start != offset else { throw NativeAccountFailure.invalid_request }
        }
    }
}

struct NativeAccountCommand {
    let contextID: String
    let requestID: String
    let method: String
    let path: String
    let body: Data?
    let statuses: Set<Int>
    var responseLimit: Int {
        path == "account/export" ? NativeAccountPolicy.exportBytes : path.hasPrefix("challenges") ? NativeAccountPolicy.challengeBytes : NativeAccountPolicy.responseBytes
    }
    var login: Bool { method == "POST" && path == "auth/login" }
    var session: Bool { method == "GET" && path == "auth/session" }
    var barrier: Bool { login || (method != "GET" && ["auth/register", "auth/logout", "account", "auth/password-reset/confirm", "auth/verification/confirm"].contains(path)) }

    init(_ value: Any) throws {
        _ = try NativeAccountJSON.encode(value, limit: NativeAccountPolicy.snapshotBytes + 1024)
        let object = try NativeAccountJSON.fields(value, ["version", "contextId", "requestId", "method", "path"], optional: ["body"])
        guard NativeAccountJSON.integer(object["version"]) == 1,
              let context = NativeAccountJSON.uuid(object["contextId"]), let request = NativeAccountJSON.uuid(object["requestId"]),
              let method = object["method"] as? String, let path = object["path"] as? String,
              path.utf8.count <= 512, let statuses = Self.operation(method, path) else { throw NativeAccountFailure.invalid_request }
        contextID = context; requestID = request; self.method = method; self.path = path; self.statuses = statuses
        if method == "GET" {
            guard object["body"] == nil else { throw NativeAccountFailure.invalid_request }; body = nil
        } else {
            guard let value = object["body"] as? [String: Any] else { throw NativeAccountFailure.invalid_request }
            body = try NativeAccountJSON.encode(value, limit: method == "PUT" && path == "sync" ? NativeAccountPolicy.snapshotBytes : NativeAccountPolicy.requestBytes)
        }
    }
    static func operation(_ method: String, _ path: String) -> Set<Int>? {
        let id = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        let rows: [(String, String, Set<Int>)] = [
            ("POST", "auth/(login|verification/confirm|password-reset/confirm)", [200]),
            ("POST", "auth/(register|verification/request|password-reset/request)", [202]),
            ("GET", "auth/session", [200]), ("POST", "auth/logout", [204]),
            ("GET", "(consent|sync)", [200]), ("PUT", "(consent|sync)", [200]),
            ("POST", "account/export", [200]), ("DELETE", "account", [204]),
            ("GET", "coaching(/relationships/\(id)/(snapshot|feedback))?", [200]),
            ("POST", "coaching/invitations(/cancel)?", [202]),
            ("POST", "coaching/invitations/\(id)/accept", [200]),
            ("POST", "coaching/relationships/\(id)/feedback", [200, 201]),
            ("PUT", "coaching/relationships/\(id)/consent", [200]),
            ("DELETE", "coaching/(invitations/\(id)|relationships/\(id)/feedback/\(id))", [204]),
            ("DELETE", "coaching/relationships/\(id)", [200]),
            ("GET", "challenges(/\(id)/counts)?", [200]),
            ("POST", "challenges/invitations", [202]), ("POST", "challenges/invitations/\(id)/accept", [200]),
            ("POST", "challenges/\(id)/block", [204]), ("PUT", "challenges/\(id)/consent", [200]),
            ("DELETE", "challenges/invitations/\(id)", [204]), ("DELETE", "challenges/\(id)(/consent)?", [200])
        ]
        guard !path.isEmpty, path.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [47, 95, 45].contains($0) }) else { return nil }
        return rows.first { $0.0 == method && path.range(of: "^" + $0.1 + "$", options: .regularExpression) != nil }?.2
    }
}

struct NativeAccountSession {
    let value: [String: Any]
    let account: String
    let csrf: String
    let expiry: Date

    init(_ raw: Any, now: Date) throws {
        let object = try NativeAccountJSON.fields(raw, ["user", "csrfToken", "sessionExpiresAt"])
        guard let rawUser = object["user"] else { throw NativeAccountFailure.invalid_response }
        let user = try NativeAccountJSON.fields(rawUser, ["id", "email", "emailVerified", "createdAt"])
        guard let account = Self.text(user["id"]), let email = Self.text(user["email"]), email.contains("@"),
              NativeAccountJSON.isBoolean(user["emailVerified"]), Self.date(user["createdAt"]) != nil,
              let csrf = Self.text(object["csrfToken"]), let expiry = Self.date(object["sessionExpiresAt"]),
              expiry > now, expiry.timeIntervalSince(now) <= NativeAccountPolicy.absoluteLifetime else { throw NativeAccountFailure.invalid_response }
        _ = try NativeAccountJSON.encode(object, limit: NativeAccountPolicy.requestBytes)
        value = object; self.account = account; self.csrf = csrf; self.expiry = expiry
    }
    static func text(_ raw: Any?) -> String? {
        guard let text = raw as? String, !text.isEmpty, text.utf16.count <= 512,
              !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }; return text
    }
    static func date(_ raw: Any?) -> Date? {
        guard let text = raw as? String, text.utf8.count == 24,
              text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil else { return nil }
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = format.date(from: text), format.string(from: date) == text else { return nil }; return date
    }
    static func csrf(for token: String) -> String {
        SHA256.hash(data: Data(("fitflow-csrf-v1:" + token).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func token(_ value: Any?) -> String? {
        guard let token = value as? String, token.utf8.count == 43,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let data = Data(base64Encoded: token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="),
              data.count == 32, data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == token else { return nil }; return token
    }
    static func business(_ value: Any) throws -> [String: Any] {
        let forbidden: Set<String> = ["nativetoken", "token", "accesstoken", "refreshtoken", "bearer", "authorization", "cookie", "cookies", "set-cookie", "headers", "credential", "credentials", "password"]
        guard let object = value as? [String: Any], !object.keys.contains(where: { forbidden.contains($0.lowercased()) }) else { throw NativeAccountFailure.invalid_response }; return object
    }
    static func normalizedError(_ value: Any?, status: Int) -> [String: Any] {
        var error: [String: Any] = ["code": "service_error"]
        if let object = value as? [String: Any], let remote = object["error"] as? [String: Any] {
            if status == 403 && remote["code"] as? String == "csrf_failed" { error = ["code": "csrf_failed"] }
            if status == 409 && remote["code"] as? String == "sync_conflict" {
                error = ["code": "sync_conflict"]
                if let details = remote["details"] as? [String: Any], let revision = NativeAccountJSON.integer(details["revision"]), revision >= 0 { error["details"] = ["revision": revision] }
            }
        }
        return ["error": error]
    }
}
