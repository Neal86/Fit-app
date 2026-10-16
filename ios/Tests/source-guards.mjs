// Linux-runnable source/wiring checks, NOT Swift compilation or device acceptance.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const protocol = read('App/App/NativeAccountProtocol.swift')
const bridge = read('App/App/NativeAccountBridge.swift')
const transport = read('App/App/NativeAccountTransport.swift')
const shell = read('App/App/FitFlowBridgeViewController.swift')
const scene = read('App/App/SceneDelegate.swift')
const storyboard = read('App/App/Base.lproj/Main.storyboard')
const project = read('App/App.xcodeproj/project.pbxproj')
const sources = { protocol, bridge, transport, shell }
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
check(protocol.includes('static let endpoint: String? = nil') && protocol.includes('static let allowedEndpoints: Set<String> = []'), 'Independent recipient controls remain empty')
check(protocol.includes('FitflowNativeAccounts') && bridge.includes('WKScriptMessageHandlerWithReply'), 'Dedicated reply channel')
for (const source of Object.values(sources)) {
  check(!/\b(?:print|NSLog|os_log|evaluateJavaScript|CAPPluginCall|CAPPluginMethod)\s*\(/.test(source), 'No account diagnostics/general bridge eval')
  check(!/URLSession\.shared|HTTPCookieStorage\.shared|UserDefaults|Keychain|UIPasteboard/.test(source), 'No shared credential/storage path')
}
for (const required of ['httpCookieStorage = nil', 'httpShouldSetCookies = false', 'httpCookieAcceptPolicy = .never', 'urlCredentialStorage = nil', 'urlCache = nil', 'waitsForConnectivity = false', 'URLSessionConfiguration.ephemeral', 'delegateQueue: .main', 'chunk.count <= cap - data.count', 'data.append(chunk)', 'completionHandler(nil)', 'bodyStreamCount == 0', 'bodyStreamCount += 1', 'uploadTask(withStreamedRequest:', 'setValue("identity"', '.performDefaultHandling', 'Content-Encoding']) check(transport.includes(required), `Transport guard ${required}`)
check(transport.indexOf('chunk.count <= cap - data.count') < transport.indexOf('data.append(chunk)'), 'Streaming bound precedes accumulation')
check(protocol.indexOf('try scanner.run()') < protocol.indexOf('JSONSerialization.jsonObject'), 'Token-aware preflight precedes JSON parser')
for (const required of ['var maxNodes = 1_000_000', 'var maxDepth = 32', 'keys.insert(key).inserted', 'CFBooleanGetTypeID()', 'number.isFinite', 'text.hasPrefix("-")', 'fitflow-csrf-v1:', 'case unavailable, invalid_request, invalid_response, cancelled, expired, network_error, busy, context_exhausted']) check(protocol.includes(required), `Protocol guard ${required}`)
for (const required of ['frame.webView === webView', 'message.webView === webView', 'frame.isMainFrame', 'frame.securityOrigin.protocol == "capacitor"', 'frame.securityOrigin.host == "localhost"', 'frame.securityOrigin.port == 0', 'Self.trustedURL(frame.request.url', 'Self.trustedURL(webView.url', 'parts.path == "/account"', 'rootIsTrusted()', 'activationState == .foregroundActive', 'pending.count + decodes.count < 2', 'usedRequests.contains(command.requestID)', 'usedContexts.contains(context)', 'session.csrf == NativeAccountSession.csrf(for: token)', 'session.account == account', 'session.expiry == wallExpiry', 'codecInFlight < 2', 'private func deliver', 'guard current(call)', 'ProcessInfo.processInfo.systemUptime < call.deadline']) check(bridge.includes(required), `Owner guard ${required}`)
check(bridge.indexOf('generation = UUID(); contextID = nil') < bridge.indexOf('for call in calls { dispose(call, error: reason) }'), 'Invalidation advances generation before cancellation')
check(shell.includes('if initialized || expected == nil') && shell.includes('poisoned = true') && !shell.includes('poisoned = false\n            '), 'Root mutation permanently fails closed')
check(shell.includes('bridge.config.appLocation.path == root.path') && shell.includes('bridge.config.serverURL.absoluteString == NativeAccountPolicy.origin'), 'Original bundled root/config is rechecked')
check(!shell.includes('super.instanceDescriptor()'), 'No persisted root restore')
check(shell.includes('final class FitFlowAssetGuard: NSObject, WKURLSchemeHandler') && shell.includes('guardedConfiguration.setURLSchemeHandler(guardHandler') && shell.includes('urlSchemeHandler(forURLScheme: "capacitor") === guardedAssets'), 'Scheme subresources cannot bypass sealed Router')
check(!shell.includes('setURLSchemeHandler(nil') && shell.includes('let guardedConfiguration = WKWebViewConfiguration()') && shell.includes('guardedConfiguration.userContentController = configuration.userContentController'), 'One-time scheme registration preserves Capacitor content controller')
check(shell.includes('guard action.targetFrame?.isMainFrame != false') && shell.includes('!url.path.hasPrefix("/_capacitor_")'), 'Subframes and special documents are blocked before forwarding')
check(shell.includes('override func capacitorDidLoad()') && shell.includes('addScriptMessageHandler(owner, contentWorld: .page'), 'Install before initial Capacitor web load')
for (const required of ['webView.observe(\\.url', 'webView.observe(\\.isLoading', 'UIApplication.willResignActiveNotification', 'UIScene.didDisconnectNotification', 'webViewWebContentProcessDidTerminate']) check(shell.includes(required), `Native lifecycle observer ${required}`)
check(scene.includes('rootViewController = FitFlowBridgeViewController()'), 'SceneDelegate uses guarded shell')
check(storyboard.includes('customClass="FitFlowBridgeViewController" customModule="App"'), 'Storyboard uses guarded shell')
for (const filename of ['NativeAccountProtocol.swift', 'NativeAccountTransport.swift', 'NativeAccountBridge.swift', 'FitFlowBridgeViewController.swift']) {
  check(existsSync(resolve(root, 'App/App', filename)), `Source exists ${filename}`)
  check(project.split(`${filename} in Sources`).length === 3, `Build reference and Sources phase ${filename}`)
  check(project.includes(`path = ${filename};`), `File reference ${filename}`)
}
console.log(`${checks} iOS source/wiring assertions passed. Swift/Xcode/device tests were not run.`)
