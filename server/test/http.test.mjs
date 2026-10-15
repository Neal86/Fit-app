import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHttpServer } from '../http.mjs'
import { ORIGIN, PASSWORD, setup } from './fixtures.mjs'

async function start(t) {
  const f = setup(), server = createHttpServer(f.app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close() })
  return { ...f, url: `http://127.0.0.1:${server.address().port}`, server }
}
const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Fitflow-Client': 'web' }

test('actual loopback HTTP login/session/logout uses cookies, JSON, security headers and CORS', async t => {
  const f = await start(t), user = f.seed()
  const login = await fetch(`${f.url}/api/v1/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: user.email, password: PASSWORD }) })
  assert.equal(login.status, 200)
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal(login.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(login.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(login.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(!login.headers.get('x-powered-by'))
  const current = await fetch(`${f.url}/api/v1/auth/session`, { headers: { Origin: ORIGIN, Cookie: cookie } })
  assert.equal(current.status, 200)
  assert.equal((await current.json()).user.id, user.id)
  const logout = await fetch(`${f.url}/api/v1/auth/logout`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': session.csrfToken }, body: '{}' })
  assert.equal(logout.status, 204)
  assert.equal(await logout.text(), '')
  assert.equal((await fetch(`${f.url}/api/v1/auth/session`, { headers: { Cookie: cookie } })).status, 401)
})

test('HTTP rejects oversized fixed and streaming bodies, encodings, and invalid UTF-8', async t => {
  const f = await start(t)
  const oversized = await fetch(`${f.url}/api/v1/auth/login`, { method: 'POST', headers, body: 'x'.repeat(8193) })
  assert.equal(oversized.status, 413)
  const encoded = await fetch(`${f.url}/api/v1/auth/login`, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' }, body: '{}' })
  assert.equal(encoded.status, 415)
  const invalidUtf8 = await fetch(`${f.url}/api/v1/auth/login`, { method: 'POST', headers, body: new Uint8Array([0xff, 0xfe]) })
  assert.equal(invalidUtf8.status, 400)
  const streamed = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.url}/api/v1/auth/login`, { method: 'POST', headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
    req.on('error', reject)
    req.write('x'.repeat(4096)); req.write('x'.repeat(4096)); req.end('xx')
  })
  assert.equal(streamed, 413)
})

test('HTTP concurrency is bounded and internal failures expose no stack or data', async t => {
  const pending = []
  const app = { handle: () => new Promise(resolve => pending.push(resolve)) }
  const server = createHttpServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/health`
  const requests = Array.from({ length: 4 }, () => fetch(url))
  // Wait for an established condition, not a fixed sleep that races on slower hosts.
  while (pending.length < 4) await new Promise(resolve => setImmediate(resolve))
  const busy = await fetch(url)
  assert.equal(busy.status, 503)
  assert.equal((await busy.json()).error.code, 'server_busy')
  for (const resolve of pending) resolve({ status: 200, body: { status: 'ok' } })
  assert.deepEqual((await Promise.all(requests)).map(response => response.status), [200, 200, 200, 200])
})
