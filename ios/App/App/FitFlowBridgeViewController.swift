import UIKit
import WebKit
import Capacitor

// Root identity is proven independently of the WebView origin. Capacitor 8.5.3
// allows WebView.setServerBasePath to serve alternate bytes at the same origin.
// This Router refuses ALL post-initial setters (even switch-away-and-back), never
// changes its route root, and permanently revokes account capability on an attempt.
final class FitFlowPackagedRouter: Router {
    let packagedRoot: URL?
    private let lock = NSLock()
    private var initialized = false
    private var poisoned = false
    var onInvalidation: (() -> Void)?
    init(root: URL?) { packagedRoot = root?.standardizedFileURL.resolvingSymlinksInPath() }
    var intact: Bool {
        lock.lock(); defer { lock.unlock() }
        return initialized && !poisoned && packagedRoot != nil
    }
    var basePath: String {
        get { packagedRoot?.path ?? "" }
        set {
            lock.lock()
            let expected = packagedRoot?.path
            let candidate = URL(fileURLWithPath: newValue, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath().path
            if initialized || expected == nil || newValue != expected || candidate != expected { poisoned = true }
            initialized = true
            let invalid = poisoned
            lock.unlock()
            if invalid {
                if Thread.isMainThread { onInvalidation?() }
                else { DispatchQueue.main.async { [weak self] in self?.onInvalidation?() } }
            }
        }
    }
    func route(for path: String) -> String {
        guard intact, let root = packagedRoot else { return "/dev/null" }
        if URL(fileURLWithPath: path).pathExtension.isEmpty { return root.appendingPathComponent("index.html").path }
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let target = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard target.path.hasPrefix(root.path + "/") else { return "/dev/null" }
        return target.path
    }
}

// Protect all scheme loads, including script subresources which never call the
// navigation delegate. Capacitor's built-in file/proxy handlers bypass Router.
final class FitFlowAssetGuard: NSObject, WKURLSchemeHandler {
    private let original: WKURLSchemeHandler
    private let router: FitFlowPackagedRouter
    init(original: WKURLSchemeHandler, router: FitFlowPackagedRouter) { self.original = original; self.router = router; super.init() }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard router.intact, NativeAccountBridge.trustedURL(urlSchemeTask.request.url, accountRoute: false) else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return
        }
        original.webView(webView, start: urlSchemeTask)
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { original.webView(webView, stop: urlSchemeTask) }
}

final class FitFlowBridgeViewController: CAPBridgeViewController {
    private lazy var packagedRouter = FitFlowPackagedRouter(root: Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true))
    private var accountBridge: NativeAccountBridge?
    private var guardedNavigation: FitFlowNavigationGuard?
    private var guardedAssets: FitFlowAssetGuard?
    private var observations: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []

    override func instanceDescriptor() -> InstanceDescriptor {
        // Do NOT call super: it restores mutable persisted serverBasePath snapshots.
        // Initial descriptor still reads reviewed packaged defaults; mismatches below
        // fail account support closed instead of changing server/security settings.
        let descriptor = InstanceDescriptor()
        if let root = packagedRouter.packagedRoot { descriptor.appLocation = root }
        return descriptor
    }
    override func router() -> Router { packagedRouter }
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // The inspected Capacitor8.5.3 hook runs after its original scheme handler
        // and content controller are configured, before WKWebView construction.
        // WebKit forbids registering the same scheme twice, even with nil. Do not
        // copy() the configuration: that would copy the existing registration too.
        guard let original = configuration.urlSchemeHandler(forURLScheme: "capacitor") else {
            return super.webView(with: frame, configuration: configuration) // accounts fail closed
        }
        let guardedConfiguration = WKWebViewConfiguration()
        // Preserve all public settings touched by the reviewed superclass and its
        // prepareWebView path, plus other normal rendering/media configuration.
        guardedConfiguration.processPool = configuration.processPool
        guardedConfiguration.preferences = configuration.preferences
        guardedConfiguration.userContentController = configuration.userContentController
        guardedConfiguration.websiteDataStore = configuration.websiteDataStore
        guardedConfiguration.defaultWebpagePreferences = configuration.defaultWebpagePreferences
        guardedConfiguration.applicationNameForUserAgent = configuration.applicationNameForUserAgent
        guardedConfiguration.allowsInlineMediaPlayback = configuration.allowsInlineMediaPlayback
        guardedConfiguration.suppressesIncrementalRendering = configuration.suppressesIncrementalRendering
        guardedConfiguration.allowsAirPlayForMediaPlayback = configuration.allowsAirPlayForMediaPlayback
        guardedConfiguration.allowsPictureInPictureMediaPlayback = configuration.allowsPictureInPictureMediaPlayback
        guardedConfiguration.mediaTypesRequiringUserActionForPlayback = configuration.mediaTypesRequiringUserActionForPlayback
        guardedConfiguration.limitsNavigationsToAppBoundDomains = configuration.limitsNavigationsToAppBoundDomains
        guardedConfiguration.ignoresViewportScaleLimits = configuration.ignoresViewportScaleLimits
        guardedConfiguration.selectionGranularity = configuration.selectionGranularity
        guardedConfiguration.dataDetectorTypes = configuration.dataDetectorTypes
        let guardHandler = FitFlowAssetGuard(original: original, router: packagedRouter)
        guardedConfiguration.setURLSchemeHandler(guardHandler, forURLScheme: "capacitor")
        guardedAssets = guardHandler
        return super.webView(with: frame, configuration: guardedConfiguration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView else { return }
        let owner = NativeAccountBridge(webView: webView, rootIsTrusted: { [weak self] in self?.trustedShell() ?? false })
        accountBridge = owner
        packagedRouter.onInvalidation = { [weak owner] in owner?.invalidate() }
        let guardDelegate = FitFlowNavigationGuard(original: webView.navigationDelegate, owner: owner)
        guardedNavigation = guardDelegate
        webView.navigationDelegate = guardDelegate
        // capacitorDidLoad runs inside loadView, before viewDidLoad/loadWebView.
        // No CAPPluginCall/CAPPluginMethod path is registered for account operations.
        webView.configuration.userContentController.addScriptMessageHandler(owner, contentWorld: .page, name: NativeAccountPolicy.channel)
        observations = [
            webView.observe(\.url, options: [.new]) { [weak owner] view, _ in
                // WKWebView URL KVO observes native History API/BrowserRouter changes.
                // Every entry and delivery also rechecks route, so cleanup is not JS-owned.
                guard Thread.isMainThread else { DispatchQueue.main.async { owner?.invalidate() }; return }
                if !NativeAccountBridge.trustedURL(view.url, accountRoute: true) { owner?.invalidate() }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak owner] view, _ in
                if view.isLoading {
                    if Thread.isMainThread { owner?.invalidate() }
                    else { DispatchQueue.main.async { owner?.invalidate() } }
                }
            }
        ]
        let notifications: [Notification.Name] = [
            UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
            UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification, UIScene.didDisconnectNotification
        ]
        notificationTokens = notifications.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak owner] _ in owner?.invalidate() }
        }
    }
    private func trustedShell() -> Bool {
        guard Thread.isMainThread, packagedRouter.intact, let root = packagedRouter.packagedRoot,
              let bridge = bridge, let webView = webView,
              bridge.webView === webView, webView.navigationDelegate === guardedNavigation,
              let guardedAssets = guardedAssets,
              webView.configuration.urlSchemeHandler(forURLScheme: "capacitor") === guardedAssets,
              bridge.config.appLocation.path == root.path,
              bridge.config.appLocation.standardizedFileURL.resolvingSymlinksInPath() == root,
              bridge.config.allowedNavigationHostnames.isEmpty,
              bridge.config.localURL.absoluteString == NativeAccountPolicy.origin,
              bridge.config.serverURL.absoluteString == NativeAccountPolicy.origin else { return false }
        return true
    }
    func invalidateNativeAccountContext() { accountBridge?.invalidate() }
    deinit {
        accountBridge?.invalidate()
        observations.forEach { $0.invalidate() }
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: NativeAccountPolicy.channel, contentWorld: .page)
    }
}

// Preserve Capacitor's navigation behavior through forwarding, but intercept all
// document navigation/reload/renderer loss before its handler. No evaluation of JS.
final class FitFlowNavigationGuard: NSObject, WKNavigationDelegate {
    private let original: WKNavigationDelegate?
    private weak var owner: NativeAccountBridge?
    init(original: WKNavigationDelegate?, owner: NativeAccountBridge) { self.original = original; self.owner = owner; super.init() }
    override func responds(to selector: Selector!) -> Bool { super.responds(to: selector) || (original?.responds(to: selector) ?? false) }
    override func forwardingTarget(for selector: Selector!) -> Any? { original?.responds(to: selector) == true ? original : super.forwardingTarget(for: selector) }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // No subframe documents are needed by this app. A same-origin untrusted
        // child could otherwise call parent.eval and appear to be the main frame.
        // Special file/content/proxy documents are rejected in EVERY frame too.
        guard action.targetFrame?.isMainFrame != false,
              let url = action.request.url, !url.path.hasPrefix("/_capacitor_") else {
            owner?.invalidate(); decisionHandler(.cancel); return
        }
        if action.targetFrame?.isMainFrame != false {
            owner?.invalidate()
            guard NativeAccountBridge.trustedURL(action.request.url, accountRoute: false) else { decisionHandler(.cancel); return }
        }
        if let original = original,
           let _ = original.webView?(webView, decidePolicyFor: action, decisionHandler: decisionHandler) { return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        owner?.invalidate(); original?.webView?(webView, didStartProvisionalNavigation: navigation)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        owner?.invalidate(); original?.webView?(webView, didCommit: navigation)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        owner?.invalidate(); original?.webViewWebContentProcessDidTerminate?(webView)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        owner?.invalidate(); original?.webView?(webView, didFail: navigation, withError: error)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        owner?.invalidate(); original?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }
}
