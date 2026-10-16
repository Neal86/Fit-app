#!/usr/bin/env python3
"""Source-shape regression checks only. These do NOT compile or run Android/WebView/OkHttp.
Pass --capacitor-source PATH to additionally inspect an already-installed Capacitor source tree.
No dependency discovery, download, installation, SDK, network or platform stubs are used.
"""
from pathlib import Path
import re
import sys

android = Path(__file__).resolve().parents[1]
source = android / 'app/src/main/java/com/fitflow/app'
installer = (source / 'accounts/NativeAccountInstaller.java').read_text()
transport = (source / 'accounts/NativeAccountTransport.java').read_text()
policy = (source / 'accounts/NativeAccountPolicy.java').read_text()
activity = (source / 'MainActivity.java').read_text()
locked = (source / 'accounts/PackagedWebView.java').read_text()

def section(text, start, end):
    return text.split(start, 1)[1].split(end, 1)[0]

def check(name, condition):
    if not condition:
        raise AssertionError(name)
    print('PASS source guard: ' + name)

check('dedicated exact-origin channel without account plugin methods or JS fallback',
      '"FitflowNativeAccounts"' in installer and 'Collections.singleton(NativeAccountPolicy.APP_ORIGIN)' in installer
      and 'WebViewFeature.WEB_MESSAGE_LISTENER' in installer and 'call.mainFrame && call.view == intended' in installer
      and not re.search(r'^\s*@PluginMethod', installer, re.M)
      and 'addJavascriptInterface' not in installer and 'evaluateJavaScript' not in installer and 'evaluateJavascript' not in installer)
intercept = section(installer, '@Override public WebResourceResponse shouldInterceptRequest', '@Override public void doUpdateVisitedHistory')
check('special file/content/proxy resources denied in all frames before Capacitor dispatch',
      'NativeAccountPolicy.forbiddenResource(url) || request.isForMainFrame()' in intercept
      and 'documentAuthority.set(false)' in intercept and '403, "Forbidden"' in intercept
      and intercept.index('forbiddenResource(url)') < intercept.index('super.shouldInterceptRequest'))
history = section(installer, '@Override public void doUpdateVisitedHistory', '@Override public boolean shouldOverrideUrlLoading')
commit = section(installer, '@Override public void onPageCommitVisible', '@Override public WebResourceResponse shouldInterceptRequest')
check('history cannot restore poisoned document authority',
      'documentAuthority.set(true)' not in history and installer.count('documentAuthority.set(true)') == 1
      and 'pendingDocument' in commit and 'NativeAccountPolicy.packagedDocument(url)' in commit and 'rootSafe()' in commit)
request = section(installer, 'private void request(', 'private void deliver(')
delivery = section(installer, 'private void deliver(', 'private final Runnable expiry')
worker = request.split('workers.execute(() -> {', 1)[1]
check('large request and response encoding stays on bounded worker path',
      'transport.prepare(ticket)' in worker and 'NativeAccountProtocol.success' in worker
      and 'transport.prepare(ticket)' not in request.split('workers.execute(() -> {', 1)[0]
      and 'NativeAccountProtocol.success' not in delivery and 'StrictJson.stringify' not in delivery
      and 'new ArrayBlockingQueue<>(2)' in installer)
check('bounded local clear priority and final state/frame/root fences remain',
      'if (raw.length() <= 1024)' in installer and 'dispatch(call, prepareWire(raw, 4096))' in installer
      and 'state.accept(ticket, result)' in delivery and 'source(incoming) && account() && state.live(ticket)' in delivery)
check('native policy remains independently empty/default off',
      'PACKAGED_ENDPOINT = ""' in policy and 'ALLOWED_ENDPOINTS = Collections.emptySet()' in policy)
check('packaged root registration precedes bridge creation and root mutators reject',
      activity.index('ServerPath.PathType.ASSET_PATH') < activity.index('super.onCreate(savedInstanceState)')
      and activity.index('registerPlugin(PackagedWebView.class)') < activity.index('super.onCreate(savedInstanceState)')
      and 'extends Plugin' in locked and locked.count('call.reject("unavailable")') == 4)
check('cookie-free no-follow-up transport, native-held headers and normal TLS',
      all(x in transport for x in ['CookieJar.NO_COOKIES', '.cache(null)', '.followRedirects(false)', '.followSslRedirects(false)',
                                  '.retryOnConnectionFailure(false)', '.authenticator(Authenticator.NONE)', '.proxyAuthenticator(Authenticator.NONE)',
                                  'boolean isOneShot() { return true; }', 'attempt.used.compareAndSet(false, true)', '"Accept-Encoding", "identity"'])
      and all(x not in transport for x in ['CookieHandler', 'Proxy.NO_PROXY', 'sslSocketFactory(', 'hostnameVerifier(', 'HttpLoggingInterceptor']))
check('pinned existing-coordinates dependency lives in app Gradle file',
      "implementation 'com.squareup.okhttp3:okhttp:5.5.0'" in (android / 'app/build.gradle').read_text())
print('PASS 9 source-structure guard groups; not Android compilation or device validation')

if len(sys.argv) == 3 and sys.argv[1] == '--capacitor-source':
    cap = Path(sys.argv[2])
    bridge = (cap / 'Bridge.java').read_text()
    cap_activity = (cap / 'BridgeActivity.java').read_text()
    plugin = (cap / 'Plugin.java').read_text()
    client = (cap / 'BridgeWebViewClient.java').read_text()
    config = (cap / 'CapConfig.java').read_text()
    server_path = (cap / 'ServerPath.java').read_text()
    check('installed Capacitor APIs used by installer and activity exist',
          all(x in bridge for x in ['public WebViewLocalServer getLocalServer()', 'public BridgeWebViewClient getWebViewClient()',
                                   'public void setWebViewClient(BridgeWebViewClient client)', 'public PluginHandle getPlugin(String pluginId)',
                                   'public Builder setServerPath(ServerPath serverPath)'])
          and 'public void registerPlugin(Class<? extends Plugin> plugin)' in cap_activity
          and 'protected final Bridge.Builder bridgeBuilder' in cap_activity
          and 'public ServerPath(PathType type, String path)' in server_path
          and all(x in config for x in ['public String getHostname()', 'public String getAndroidScheme()', 'public String[] getAllowNavigation()'])
          and all(x in plugin for x in ['public void load()', 'protected void handleOnResume()', 'protected void handleOnPause()', 'protected void handleOnDestroy()'])
          and all(x in client for x in ['public BridgeWebViewClient(Bridge bridge)', 'public void onPageCommitVisible(WebView view, String url)',
                                       'public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request)']))
    check('installed core-plugin replacement order and explicit asset-path startup order',
          bridge.index('this.registerPlugin(com.getcapacitor.plugin.WebView.class)') < bridge.index('for (Class<? extends Plugin> pluginClass : this.initialPlugins)')
          and bridge.index('localServer.hostAssets(DEFAULT_WEB_ASSET_DIR)') < bridge.index('if (serverPath != null)'))
    print('PASS 2 installed-Capacitor-source checks; not AndroidX/OkHttp bytecode compilation')
elif len(sys.argv) != 1:
    raise SystemExit('Usage: check-source.py [--capacitor-source PATH]')
