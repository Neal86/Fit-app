import XCTest
@testable import FitFlowNativeAccountCore

final class NativeAccountProtocolTests: XCTestCase {
    private let id = "6ac550ce-3929-4b99-a006-1b523dc99c02"
    private let requestID = "55555555-1111-4222-8333-444444444444"
    private func parse(_ text: String, limit: Int = 16_384) throws -> Any { try NativeAccountJSON.parse(Data(text.utf8), limit: limit) }
    private func command(_ method: String, _ path: String, body: Any? = nil) throws -> NativeAccountCommand {
        var value: [String: Any] = ["version": 1, "contextId": id, "requestId": requestID, "method": method, "path": path]
        if let body = body { value["body"] = body }
        return try NativeAccountCommand(value)
    }
    func testPackagedRecipientIsUnavailableWithoutBothControls() {
        XCTAssertNil(NativeAccountPolicy.endpoint)
        XCTAssertTrue(NativeAccountPolicy.allowedEndpoints.isEmpty)
        XCTAssertNil(NativeAccountPolicy.recipient())
    }
    func testCanonicalRecipient() {
        for value in ["https://example.test/api/native/v1", "https://example.test:8443/api/native/v1"] { XCTAssertTrue(NativeAccountPolicy.canonicalEndpoint(value), value) }
        for value in ["http://localhost/api/native/v1", "https://EXAMPLE.test/api/native/v1", "https://example.test:443/api/native/v1", "https://example.test:08443/api/native/v1", "https://u@example.test/api/native/v1", "https://example.test/api/native/v1/", "https://example.test/api/native/v1?", "https://example.test/api/native/v1#", "https://example.test/api/native/%76%31", "https://example.test/../api/native/v1"] { XCTAssertFalse(NativeAccountPolicy.canonicalEndpoint(value), value) }
    }
    func testUUIDsAndBooleanNumberDistinction() {
        XCTAssertEqual(NativeAccountJSON.uuid(id), id)
        for value in [id.uppercased(), "00000000-0000-0000-0000-000000000000", id + "\n", "6ac550ce-3929-6b99-a006-1b523dc99c02"] { XCTAssertNil(NativeAccountJSON.uuid(value)) }
        XCTAssertNil(NativeAccountJSON.integer(true))
        XCTAssertEqual(NativeAccountJSON.integer(1), 1)
        XCTAssertTrue(NativeAccountJSON.isBoolean(false))
        XCTAssertFalse(NativeAccountJSON.isBoolean(0))
    }
    func testPreflightHandlesEscapesAndDuplicateAliases() throws {
        XCTAssertNoThrow(try parse(#"{"note":"{[}\\\" ]","unicode":"\uD83D\uDE00"}"#))
        for value in [#"{"version":1,"version":2}"#, #"{"version":1,"vers\u0069on":1}"#, #"{"x":"\uD800"}"#, #"{"x":"\uDC00"}"#, #"{"x":"\q"}"#] { XCTAssertThrowsError(try parse(value)) }
    }
    func testPreflightRejectsInvalidUTF8BytesAndSyntax() {
        XCTAssertThrowsError(try NativeAccountJSON.parse(Data([0x22, 0xFF, 0x22]), limit: 16))
        for value in ["{", "[]x", "01", "1.", "1e", "[true,]", "{\"a\":0,}", "NaN", "Infinity", "1e999", "-0", "-0.00e2"] { XCTAssertThrowsError(try parse(value), value) }
        XCTAssertThrowsError(try parse("{\"ok\":true}", limit: 4))
    }
    func testDepthAndNodePreflight() {
        XCTAssertNoThrow(try parse(String(repeating: "[", count: 32) + "0" + String(repeating: "]", count: 32)))
        XCTAssertThrowsError(try parse(String(repeating: "[", count: 33) + "0" + String(repeating: "]", count: 33)))
        let oversized = "[" + Array(repeating: "0", count: 1_000_000).joined(separator: ",") + "]"
        XCTAssertThrowsError(try parse(oversized, limit: 3_000_000))
    }
    func testWireWrapperHasOnlyOneAdditionalDepthAndFourNodes() throws {
        let nested = String(repeating: "[", count: 32) + "0" + String(repeating: "]", count: 32)
        let wire = "{\"version\":1,\"callId\":\"\(id)\",\"operation\":\"request\",\"payload\":" + nested + "}"
        XCTAssertThrowsError(try NativeAccountJSON.parse(Data(wire.utf8), limit: 8192))
        let value = try NativeAccountJSON.parseWire(Data(wire.utf8), limit: 8192)
        XCTAssertNoThrow(try NativeAccountJSON.encodeWire(value, limit: 8192))
        XCTAssertThrowsError(try NativeAccountJSON.encode(value, limit: 8192))
        let excessive = String(repeating: "[", count: 33) + "0" + String(repeating: "]", count: 33)
        let badWire = "{\"payload\":" + excessive + "}"
        XCTAssertThrowsError(try NativeAccountJSON.parseWire(Data(badWire.utf8), limit: 8192))
    }
    func testExactFieldsAndJSONNumbers() throws {
        XCTAssertThrowsError(try NativeAccountJSON.fields(["version": 1, "url": "https://other.test"], ["version"]))
        XCTAssertThrowsError(try NativeAccountJSON.encode(["n": Double.nan], limit: 8192))
        XCTAssertThrowsError(try NativeAccountJSON.encode(["n": -Double.zero], limit: 8192))
        let object = try parse(#"{"flag":false,"number":1}"#) as! [String: Any]
        XCTAssertTrue(NativeAccountJSON.isBoolean(object["flag"]))
        XCTAssertEqual(NativeAccountJSON.integer(object["number"]), 1)
    }
    func testAllReviewedOperationsAndExactStatuses() throws {
        let rows: [(String, String, Set<Int>)] = [
            ("POST", "auth/login", [200]), ("GET", "auth/session", [200]), ("POST", "auth/register", [202]), ("POST", "auth/logout", [204]),
            ("POST", "auth/verification/request", [202]), ("POST", "auth/password-reset/request", [202]), ("POST", "auth/verification/confirm", [200]), ("POST", "auth/password-reset/confirm", [200]),
            ("GET", "consent", [200]), ("PUT", "consent", [200]), ("GET", "sync", [200]), ("PUT", "sync", [200]), ("POST", "account/export", [200]), ("DELETE", "account", [204]),
            ("GET", "coaching", [200]), ("POST", "coaching/invitations", [202]), ("POST", "coaching/invitations/cancel", [202]), ("POST", "coaching/invitations/\(id)/accept", [200]), ("DELETE", "coaching/invitations/\(id)", [204]),
            ("PUT", "coaching/relationships/\(id)/consent", [200]), ("DELETE", "coaching/relationships/\(id)", [200]), ("GET", "coaching/relationships/\(id)/snapshot", [200]), ("GET", "coaching/relationships/\(id)/feedback", [200]), ("POST", "coaching/relationships/\(id)/feedback", [200, 201]), ("DELETE", "coaching/relationships/\(id)/feedback/\(requestID)", [204]),
            ("GET", "challenges", [200]), ("POST", "challenges/invitations", [202]), ("POST", "challenges/invitations/\(id)/accept", [200]), ("DELETE", "challenges/invitations/\(id)", [204]), ("PUT", "challenges/\(id)/consent", [200]), ("DELETE", "challenges/\(id)", [200]), ("DELETE", "challenges/\(id)/consent", [200]), ("POST", "challenges/\(id)/block", [204]), ("GET", "challenges/\(id)/counts", [200])
        ]
        for (method, path, statuses) in rows {
            XCTAssertEqual(try command(method, path, body: method == "GET" ? nil : [String: Any]()).statuses, statuses)
            XCTAssertNil(NativeAccountCommand.operation(method, path + "/"))
        }
    }
    func testNoTransportOverridesAndWriteBounds() throws {
        for path in ["/sync", "sync?x=1", "sync#x", "../sync", "https://example.test", "sync%2f", "sync\n"] { XCTAssertThrowsError(try command("GET", path)) }
        XCTAssertThrowsError(try command("GET", "sync", body: [:]))
        XCTAssertThrowsError(try command("PUT", "sync"))
        XCTAssertThrowsError(try command("POST", "auth/login", body: "token"))
        XCTAssertThrowsError(try command("POST", "auth/login", body: ["password": String(repeating: "x", count: 8192)]))
        XCTAssertNoThrow(try command("PUT", "sync", body: ["note": String(repeating: "x", count: 8192)]))
        let reviewed = try command("PUT", "challenges/\(id)/consent", body: ["recipient": id, "note": ["nativeToken": "ordinary business text"]])
        let body = try NativeAccountJSON.parse(reviewed.body!, limit: 8192) as! [String: Any]
        XCTAssertEqual(body["recipient"] as? String, id)
    }
    func testPositiveTokenAndCSRFBinding() {
        let token = String(repeating: "A", count: 43)
        XCTAssertEqual(NativeAccountSession.token(token), token)
        XCTAssertNil(NativeAccountSession.token(token + "="))
        XCTAssertNil(NativeAccountSession.token(String(repeating: "_", count: 43))) // noncanonical padding bits
        XCTAssertEqual(NativeAccountSession.csrf(for: token).count, 64)
        XCTAssertNotEqual(NativeAccountSession.csrf(for: token), NativeAccountSession.csrf(for: String(repeating: "B", count: 42) + "A"))
    }
    func testSessionShapeAndAbsoluteExpiry() throws {
        let now = NativeAccountSession.date("2026-10-16T01:00:00.000Z")!
        var value: [String: Any] = ["user": ["id": id, "email": "synthetic@example.test", "emailVerified": true, "createdAt": "2026-10-15T00:00:00.000Z"], "csrfToken": String(repeating: "0", count: 64), "sessionExpiresAt": "2026-10-16T02:00:00.000Z"]
        XCTAssertEqual(try NativeAccountSession(value, now: now).account, id)
        XCTAssertThrowsError(try NativeAccountSession(["session": value, "nativeToken": "private"], now: now))
        value["sessionExpiresAt"] = "2026-10-16T10:00:00.000Z"
        XCTAssertThrowsError(try NativeAccountSession(value, now: now))
        value["sessionExpiresAt"] = "2026-10-16T01:00:00.000Z"
        XCTAssertThrowsError(try NativeAccountSession(value, now: now))
        XCTAssertNil(NativeAccountSession.date("2026-02-30T01:00:00.000Z"))
    }
    func testCredentialEnvelopeAndErrorNormalization() throws {
        let invalid: [Any] = ["bare token", [], NSNull(), ["nativeToken": "private"], ["Authorization": "private"], ["password": "private"]]
        for value in invalid { XCTAssertThrowsError(try NativeAccountSession.business(value)) }
        XCTAssertNoThrow(try NativeAccountSession.business(["note": ["password": "legitimate field"]]))
        let normalized = NativeAccountSession.normalizedError(["error": ["code": "private_error", "message": "private", "headers": ["Set-Cookie": "private"]]], status: 500)
        XCTAssertEqual((normalized["error"] as? [String: Any])?.count, 1)
        XCTAssertEqual((normalized["error"] as? [String: Any])?["code"] as? String, "service_error")
        let conflict = NativeAccountSession.normalizedError(["error": ["code": "sync_conflict", "details": ["revision": true]]], status: 409)
        XCTAssertNil((conflict["error"] as? [String: Any])?["details"])
        XCTAssertEqual((NativeAccountSession.normalizedError(["error": ["code": "csrf_failed"]], status: 401)["error"] as? [String: Any])?["code"] as? String, "service_error")
    }
}
