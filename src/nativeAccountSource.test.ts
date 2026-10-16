// These are source/build-wiring regressions, not Android/iOS compilation or device tests.
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const android = 'android/app/src/main/java/com/fitflow/app/'
const ios = 'ios/App/App/'
const stripped = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const java = (name: string) => stripped(read(`${android}accounts/${name}.java`))
const swift = (name: string) => stripped(read(`${ios}${name}.swift`))
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])

describe('native account source and build-wiring gates (not platform execution)', () => {
  it('ships both native recipient policies empty and independent', () => {
    expect(java('NativeAccountPolicy')).toMatch(/PACKAGED_ENDPOINT\s*=\s*""/)
    expect(java('NativeAccountPolicy')).toMatch(/ALLOWED_ENDPOINTS\s*=\s*Collections\.emptySet\(\)/)
    expect(swift('NativeAccountProtocol')).toMatch(/endpoint:\s*String\?\s*=\s*nil/)
    expect(swift('NativeAccountProtocol')).toMatch(/allowedEndpoints:\s*Set<String>\s*=\s*\[\]/)
  })

  it('keeps the native Web client disabled and the channel absent from production UI imports', () => {
    const cloud = read('src/cloud.ts')
    expect(cloud).toContain('this.nativeUnsupported = Capacitor.isNativePlatform()')
    expect(cloud).toContain('this.endpoint = this.nativeUnsupported ? null : cloudEndpoint(config)')
    const consumers = files(resolve(root, 'src')).filter(path => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('nativeAccountChannel.ts'))
    for (const path of consumers) expect(readFileSync(path, 'utf8')).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*nativeAccountChannel['"]/)
  })

  it('adds no device permissions, cleartext setting or generic HTTP patch', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml')
    expect([...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map(match => match[1])).toEqual(['android.permission.INTERNET'])
    expect(manifest).toContain('android:usesCleartextTraffic="false"')
    expect(manifest).toContain('android:allowBackup="false"')
    const plist = read(`${ios}Info.plist`)
    expect(plist).not.toMatch(/NSAllowsArbitraryLoads|NSCameraUsageDescription|NSMicrophoneUsageDescription|NSHealth(?:Share|Update)UsageDescription/)
    const config = read('capacitor.config.ts')
    expect(config).not.toMatch(/CapacitorHttp|CapacitorCookies|allowNavigation|server\s*:/)
  })

  it('pins the reviewed Android client without adding a package repository', () => {
    expect(read('android/app/build.gradle')).toMatch(/implementation\s+["']com\.squareup\.okhttp3:okhttp:5\.5\.0["']/)
    expect(read('android/build.gradle')).toContain('mavenCentral()')
    expect(stripped(read('android/app/build.gradle'))).not.toMatch(/https?:\/\//)
  })

  it('registers the sealed Android shell before bridge creation and connects the production state core', () => {
    const activity = read(`${android}MainActivity.java`)
    const start = activity.indexOf('super.onCreate(')
    expect(start).toBeGreaterThan(0)
    for (const marker of ['ServerPath.PathType.ASSET_PATH', 'registerPlugin(PackagedWebView.class)', 'registerPlugin(NativeAccountInstaller.class)']) {
      expect(activity.indexOf(marker)).toBeGreaterThanOrEqual(0)
      expect(activity.indexOf(marker)).toBeLessThan(start)
    }
    const installer = java('NativeAccountInstaller')
    expect(installer).toContain('new NativeAccountState(')
    expect(installer).toContain('NativeAccountProtocol.')
    expect(installer).toContain('StrictJson.')
    expect(installer).not.toMatch(/@PluginMethod|addJavascriptInterface|evaluateJavascript|CookieHandler\.setDefault/)
  })

  it('keeps the Android channel on the explicit frame-aware message API', () => {
    const source = java('NativeAccountInstaller')
    for (const marker of ['WebViewFeature.WEB_MESSAGE_LISTENER', 'WebViewCompat.addWebMessageListener', 'sourceOrigin', 'isMainFrame', 'replyProxy']) expect(source).toContain(marker)
    expect(java('NativeAccountPolicy')).toContain('"https://localhost"')
    const sealed = java('PackagedWebView')
    for (const method of ['setServerAssetPath', 'setServerBasePath', 'persistServerBasePath']) expect(sealed).toMatch(new RegExp(`${method}\\(PluginCall call\\)\\s*\\{\\s*call\\.reject\\("unavailable"\\)`))
  })

  it('retains Android cookie/cache/redirect/credential and one-shot exchange guards', () => {
    const source = java('NativeAccountTransport')
    for (const marker of ['CookieJar.NO_COOKIES', '.cache(null)', '.followRedirects(false)', '.followSslRedirects(false)', '.retryOnConnectionFailure(false)', '.authenticator(Authenticator.NONE)', '.proxyAuthenticator(Authenticator.NONE)', 'isOneShot()', '.addNetworkInterceptor(']) expect(source).toContain(marker)
    expect(source).not.toMatch(/HttpURLConnection|CookieHandler|JavaNetCookieJar|\.proxy\(Proxy\.NO_PROXY\)|\.sslSocketFactory\(|\.hostnameVerifier\(|LoggingInterceptor|System\.out|Log\./)
  })

  it('parses the Xcode project and includes every new app Swift file in the App sources phase', () => {
    const project = createRequire(import.meta.url)('xcode').project(resolve(root, 'ios/App/App.xcodeproj/project.pbxproj'))
    project.parseSync()
    const objects = project.hash.project.objects
    const targetKey = Object.keys(objects.PBXNativeTarget).find(key => !key.endsWith('_comment') && objects.PBXNativeTarget[key].name === 'App')
    expect(targetKey).toBeTruthy()
    const target = objects.PBXNativeTarget[targetKey!]
    const phases = target.buildPhases.map((entry: { value: string }) => objects.PBXSourcesBuildPhase[entry.value]).filter(Boolean)
    expect(phases).toHaveLength(1)
    const buildIds = phases[0].files.map((entry: { value: string }) => entry.value)
    const compiled = buildIds.map((id: string) => objects.PBXFileReference[objects.PBXBuildFile[id].fileRef].path.replace(/^"|"$/g, ''))
    for (const name of ['FitFlowBridgeViewController.swift', 'NativeAccountBridge.swift', 'NativeAccountProtocol.swift', 'NativeAccountTransport.swift']) {
      expect(compiled.filter((file: string) => file === name)).toHaveLength(1)
      expect(read(`${ios}${name}`).length).toBeGreaterThan(0)
    }
  })

  it('routes both iOS entry points through the guarded bridge controller', () => {
    expect(read(`${ios}SceneDelegate.swift`)).toContain('FitFlowBridgeViewController()')
    expect(read(`${ios}Base.lproj/Main.storyboard`)).toContain('customClass="FitFlowBridgeViewController"')
    expect(read(`${ios}SceneDelegate.swift`)).not.toMatch(/=\s*CAPBridgeViewController\(\)/)
    const controller = swift('FitFlowBridgeViewController')
    expect(controller).toContain('override func instanceDescriptor()')
    expect(controller).toContain('override func router()')
    expect(controller).toContain('override func capacitorDidLoad()')
    expect(controller).toContain('addScriptMessageHandler(')
    expect(controller).toContain('bridge.config.appLocation')
  })

  it('uses a dedicated iOS reply handler without generic plugin result logging', () => {
    const source = swift('NativeAccountBridge')
    for (const marker of ['WKScriptMessageHandlerWithReply', 'frameInfo', 'isMainFrame', 'securityOrigin', 'replyHandler']) expect(source).toContain(marker)
    expect(source).not.toMatch(/CAPPluginCall|CAPPluginMethod|evaluateJavaScript|UserDefaults|print\(|NSLog\(|os_log\(/)
    expect(swift('NativeAccountProtocol')).toContain('"capacitor://localhost"')
  })

  it('disables iOS ephemeral stores explicitly and retains streaming transport', () => {
    const source = swift('NativeAccountTransport')
    for (const marker of ['URLSessionDataDelegate', 'URLSessionConfiguration.ephemeral', 'httpCookieStorage = nil', 'httpShouldSetCookies = false', 'httpCookieAcceptPolicy = .never', 'urlCredentialStorage = nil', 'urlCache = nil', 'reloadIgnoringLocalCacheData', 'waitsForConnectivity = false', 'needNewBodyStream', 'willPerformHTTPRedirection']) expect(source).toContain(marker)
    expect(source).not.toMatch(/URLSession\.shared|CapacitorCookie|downloadTask|UserDefaults|print\(|NSLog\(|os_log\(/)
  })

  it('keeps available-check evidence separate from platform release acceptance', () => {
    const doc = read('docs/NATIVE_ACCOUNT_TRANSPORT.md')
    expect(doc).toContain('Android SDK')
    expect(doc).toContain('Swift/Xcode')
    expect(doc).toContain('source/build-wiring')
    expect(doc).toContain('does not configure a recipient or activate native account UI')
    expect(doc).toContain('automatic idempotent retry')
  })
})
