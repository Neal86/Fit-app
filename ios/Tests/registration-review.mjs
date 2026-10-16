// Independent source-order regression. This does NOT construct a WKWebView or
// establish Swift compilation/runtime behavior. Requires the reviewed installed
// Capacitor source; re-review the setting transfer when the dependency changes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const dependency = JSON.parse(read('node_modules/@capacitor/ios/package.json'))
assert.equal(dependency.version, '8.5.3', 'Re-review Capacitor hook order before changing the version-bound regression')
const capacitor = read('node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift')
const shell = read('ios/App/App/FitFlowBridgeViewController.swift')
const prepare = capacitor.slice(capacitor.indexOf('private func prepareWebView('), capacitor.indexOf('private func updateBinaryVersion('))
const order = [
  'let webConfig = webViewConfiguration(for:',
  'webConfig.setURLSchemeHandler(assetHandler,',
  'webConfig.userContentController = delegationHandler.contentController',
  'let aWebView = webView(with:',
].map(fragment => prepare.indexOf(fragment))
assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), 'Hook must run after handler/content-controller setup and before WKWebView construction')

const hook = shell.slice(shell.indexOf('override func webView(with'), shell.indexOf('override func capacitorDidLoad()'))
const fresh = hook.indexOf('let guardedConfiguration = WKWebViewConfiguration()')
const register = hook.indexOf('guardedConfiguration.setURLSchemeHandler(guardHandler, forURLScheme: "capacitor")')
const construct = hook.indexOf('return super.webView(with: frame, configuration: guardedConfiguration)')
assert.ok(fresh >= 0 && register > fresh && construct > register, 'Fresh configuration gets exactly one guarded registration before construction')
assert.equal((hook.match(/\.setURLSchemeHandler\(/g) ?? []).length, 1, 'Do not clear/re-register an existing custom scheme')
assert.ok(!/\.copy\s*\(|setURLSchemeHandler\s*\(\s*nil/.test(hook), 'A configuration copy retains registrations, and nil does not remove an existing scheme')
assert.ok(hook.includes('configuration.urlSchemeHandler(forURLScheme: "capacitor")'), 'Wrap the actual Capacitor asset handler')
assert.ok(shell.includes('webView.configuration.urlSchemeHandler(forURLScheme: "capacitor") === guardedAssets'), 'Verify the handler from the constructed view, not only its original configuration')

// Every public configuration object touched by the inspected superclass must
// survive transfer, including nested preferences and the cookie-observed store.
const defaults = capacitor.slice(capacitor.indexOf('open func webViewConfiguration('), capacitor.indexOf('open func webView(with'))
const touched = new Set([...defaults.matchAll(/webViewConfiguration\.([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]))
touched.add('userContentController')
for (const property of touched) {
  assert.ok(hook.includes(`guardedConfiguration.${property} = configuration.${property}`), `Preserve superclass configuration property ${property}`)
}
console.log(`${7 + touched.size} independent iOS registration source assertions passed. Swift/WebKit construction and device tests were not run.`)
