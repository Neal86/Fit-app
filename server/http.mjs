import { createServer } from 'node:http'
import { MAX_STATE_BYTES } from './state.mjs'

export function createHttpServer(app) {
  let inFlight = 0
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    if (inFlight >= 4) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', 'retry-after': '1' })
      res.end(JSON.stringify({ error: { code: 'server_busy', message: 'Service is busy. Try again shortly.' } }))
      return
    }
    inFlight++
    let released = false
    const release = () => { if (!released) { released = true; inFlight-- } }
    res.once('close', release)
    res.once('finish', release)
    const path = req.url || '/'
    const limit = req.method === 'PUT' && path === '/api/v1/sync' ? MAX_STATE_BYTES + 1024 : 8192
    const send = response => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(response.status, response.headers)
      res.end(response.body === undefined ? undefined : JSON.stringify(response.body))
    }
    const rejectBody = () => {
      send({ status: 413, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }, body: { error: { code: 'body_too_large', message: 'Request body is too large.' } } })
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      send({ status: 415, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }, body: { error: { code: 'unsupported_encoding', message: 'Compressed request bodies are not supported.' } } })
      return
    }
    if (Number(req.headers['content-length'] || 0) > limit) { rejectBody(); return }
    let size = 0
    const chunks = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) { rejectBody(); return }
        chunks.push(chunk)
      }
      const response = await app.handle({ method: req.method, path, headers: req.headers, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), ip: req.socket.remoteAddress || 'unknown' })
      send(response)
    } catch {
      send({ status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { error: { code: 'invalid_request', message: 'The request could not be read.' } } })
    }
  })
  server.maxConnections = 64
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })
  return server
}
