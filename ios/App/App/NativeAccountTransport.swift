import Foundation

// A separate ephemeral session per operation never enters Capacitor's cookie/HTTP
// helpers. Delegates run on the main owner queue; every callback is fenced first.
final class NativeAccountTransport: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    typealias Completion = (Result<(Int, Data), NativeAccountFailure>) -> Void
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var completion: Completion?
    private var isCurrent: (() -> Bool)?
    private var data = Data()
    private var status: Int?
    private var cap: Int
    private let recipient: URL
    private var finished = false
    private var uploadBody: Data?
    private var uploadStream: InputStream?
    private var bodyStreamCount = 0

    init(recipient: URL, responseLimit: Int, isCurrent: @escaping () -> Bool, completion: @escaping Completion) {
        self.recipient = recipient; cap = responseLimit; self.isCurrent = isCurrent; self.completion = completion
        super.init()
    }

    func start(command: NativeAccountCommand, bearer: String?, csrf: String?) {
        precondition(Thread.isMainThread)
        guard valid() else { finish(.failure(.cancelled)); return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = NativeAccountPolicy.timeout
        configuration.timeoutIntervalForResource = NativeAccountPolicy.timeout
        configuration.httpMaximumConnectionsPerHost = 2
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: recipient, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: NativeAccountPolicy.timeout)
        request.httpMethod = command.method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("native-v1", forHTTPHeaderField: "X-FitFlow-Client")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let bearer = bearer, let csrf = csrf {
            request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        if let body = command.body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
            // One-shot stream; no replacement stream or application retry is supplied.
            uploadBody = body
            task = session.uploadTask(withStreamedRequest: request)
        } else { task = session.dataTask(with: request) }
        guard valid() else { cancel(); return }
        task?.resume()
    }

    func cancel() {
        precondition(Thread.isMainThread)
        finished = true; completion = nil; isCurrent = nil
        data.removeAll(keepingCapacity: false)
        uploadBody = nil; uploadStream?.close(); uploadStream = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
    }
    private func valid() -> Bool { !finished && Thread.isMainThread && (isCurrent?() ?? false) }
    private func finish(_ result: Result<(Int, Data), NativeAccountFailure>) {
        guard !finished else { return }
        let callback = completion
        finished = true; completion = nil; isCurrent = nil
        data.removeAll(keepingCapacity: false)
        uploadBody = nil; uploadStream?.close(); uploadStream = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        callback?(result)
    }
    private func check() -> Bool {
        if valid() { return true }; finish(.failure(.cancelled)); return false
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard check() else { completionHandler(.cancel); return }
        guard let response = response as? HTTPURLResponse,
              response.url?.absoluteString == recipient.absoluteString,
              dataTask.currentRequest?.url?.absoluteString == recipient.absoluteString,
              response.statusCode >= 200, !(300...399).contains(response.statusCode), response.statusCode <= 599 else {
            completionHandler(.cancel); finish(.failure(.invalid_response)); return
        }
        if response.statusCode == 401 {
            // No private upstream body is needed to normalize unauthenticated.
            // Revoke through the owner immediately, without waiting for body I/O.
            completionHandler(.cancel); finish(.success((401, Data()))); return
        }
        let encoding = response.value(forHTTPHeaderField: "Content-Encoding")?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard encoding == nil || encoding == "identity" else { completionHandler(.cancel); finish(.failure(.invalid_response)); return }
        if response.statusCode >= 400 { cap = NativeAccountPolicy.errorBytes }
        if response.statusCode == 204 { cap = 0 }
        guard response.expectedContentLength < 0 || response.expectedContentLength <= Int64(cap) else {
            completionHandler(.cancel); finish(.failure(.invalid_response)); return
        }
        if response.statusCode != 204 && response.statusCode < 400 {
            guard response.mimeType?.lowercased() == "application/json",
                  response.textEncodingName == nil || ["utf-8", "utf8"].contains(response.textEncodingName!.lowercased()) else {
                completionHandler(.cancel); finish(.failure(.invalid_response)); return
            }
        }
        status = response.statusCode
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard check() else { return }
        // Enforce the wire cap before any accumulation or parsing, including chunked responses.
        guard chunk.count <= cap - data.count else { finish(.failure(.invalid_response)); return }
        data.append(chunk)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard check() else { return }
        guard error == nil else { finish(.failure(.network_error)); return }
        guard let status = status, task.currentRequest?.url?.absoluteString == recipient.absoluteString else { finish(.failure(.invalid_response)); return }
        finish(.success((status, data)))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        if check() { finish(.failure(.invalid_response)) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, willCacheResponse proposedResponse: CachedURLResponse, completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil); _ = check()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
        guard check(), bodyStreamCount == 0, let body = uploadBody else {
            completionHandler(nil)
            if !finished { finish(.failure(.network_error)) }
            return
        }
        // uploadTask(withStreamedRequest:) asks here for the FIRST stream too.
        // Supply it once; a retry/replay requiring another stream is refused.
        bodyStreamCount += 1; uploadBody = nil
        let stream = InputStream(data: body); uploadStream = stream
        completionHandler(stream)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler)
    }
    private func authenticate(_ challenge: URLAuthenticationChallenge, _ completion: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard check(), challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == recipient.host,
              challenge.protectionSpace.port == (recipient.port ?? 443) else {
            completion(.cancelAuthenticationChallenge, nil); return
        }
        // Normal platform trust validation: no trust bypass, custom certificates or credentials.
        completion(.performDefaultHandling, nil)
    }
}
