import { createServer } from 'node:http'
import { normalizeHeaders, requestBodyLimit } from './transport.mjs'

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
    const limit = requestBodyLimit(req.method, path)
    const send = response => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(response.status, response.headers)
      res.end(response.body === undefined ? undefined : JSON.stringify(response.body))
    }
    const rejectBody = () => {
      send({ status: 413, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }, body: { error: { code: 'body_too_large', message: 'Request body is too large.' } } })
    }
    let headers
    try { headers = normalizeHeaders(req.rawHeaders) } catch {
      send({ status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }, body: { error: { code: 'invalid_request', message: 'Request headers are invalid or ambiguous.' } } })
      return
    }
    if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
      send({ status: 415, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }, body: { error: { code: 'unsupported_encoding', message: 'Compressed request bodies are not supported.' } } })
      return
    }
    if (Number(headers['content-length'] || 0) > limit) { rejectBody(); return }
    let size = 0
    const chunks = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) { rejectBody(); return }
        chunks.push(chunk)
      }
      // Trailers can arrive without a Trailer declaration. They must never carry
      // a second credential/browser context past the initial raw-header guard.
      if (req.rawTrailers.length) throw new Error('Request trailers are not supported')
      const response = await app.handle({ method: req.method, path, headers, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), ip: req.socket.remoteAddress || 'unknown' })
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
