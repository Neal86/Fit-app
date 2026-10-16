import { fail } from './errors.mjs'
import { MAX_STATE_BYTES } from './state.mjs'

export const WEB_PREFIX = '/api/v1'
export const NATIVE_PREFIX = '/api/native/v1'
const sensitive = name => ['authorization', 'proxy-authorization', 'origin', 'cookie', 'x-fitflow-client', 'x-csrf-token', 'transfer-encoding', 'trailer'].includes(name) || name.startsWith('content-') || name.startsWith('sec-fetch-')
const invalidHeaders = () => fail(400, 'invalid_request', 'Request headers are invalid or ambiguous.')

// HTTP supplies rawHeaders, before any discarded/joined req.headers values are used.
// Direct app callers get the same case-insensitive duplicate and scalar checks.
export function normalizeHeaders(input) {
  let entries
  if (Array.isArray(input)) {
    if (input.length % 2) invalidHeaders()
    entries = Array.from({ length: input.length / 2 }, (_, i) => [input[i * 2], input[i * 2 + 1]])
  } else {
    if (!input || typeof input !== 'object') invalidHeaders()
    entries = Object.entries(input)
  }
  const result = Object.create(null)
  for (const [name, supplied] of entries) {
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) invalidHeaders()
    const key = name.toLowerCase()
    // Direct integration callers historically use undefined for an omitted web
    // header. Keep its presence so the stricter native browser-header guard still
    // rejects it; raw HTTP pairs must always contain strings.
    if (!Array.isArray(input) && supplied === undefined && !Object.hasOwn(result, key)) {
      result[key] = undefined
      continue
    }
    if (sensitive(key) && (Object.hasOwn(result, key) || typeof supplied !== 'string')) invalidHeaders()
    const value = Array.isArray(supplied) ? supplied.join(', ') : supplied
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) invalidHeaders()
    result[key] = Object.hasOwn(result, key) ? `${result[key]}, ${value}` : value
  }
  // No endpoint consumes trailers. Reject declarations before reading a body.
  if (Object.hasOwn(result, 'trailer')) invalidHeaders()
  return Object.freeze(result)
}

export const requestBodyLimit = (method, path) => method === 'PUT' && [WEB_PREFIX + '/sync', NATIVE_PREFIX + '/sync'].includes(path) ? MAX_STATE_BYTES + 1024 : 8192

const UUID = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}'
const fixedRoutes = new Set([
  'POST /auth/register', 'POST /auth/login', 'POST /auth/verification/request', 'POST /auth/verification/confirm',
  'POST /auth/password-reset/request', 'POST /auth/password-reset/confirm', 'GET /auth/session', 'POST /auth/logout',
  'GET /consent', 'PUT /consent', 'GET /sync', 'PUT /sync', 'POST /account/export', 'DELETE /account',
  'GET /coaching', 'POST /coaching/invitations', 'POST /coaching/invitations/cancel',
  'GET /challenges', 'POST /challenges/invitations',
])
const variableRoutes = [
  `POST /coaching/invitations/${UUID}/accept`, `DELETE /coaching/invitations/${UUID}`,
  `DELETE /coaching/relationships/${UUID}`, `PUT /coaching/relationships/${UUID}/consent`,
  `GET /coaching/relationships/${UUID}/snapshot`, `(?:GET|POST) /coaching/relationships/${UUID}/feedback`,
  `DELETE /coaching/relationships/${UUID}/feedback/${UUID}`,
  `POST /challenges/invitations/${UUID}/accept`, `DELETE /challenges/invitations/${UUID}`,
  `DELETE /challenges/${UUID}`, `(?:PUT|DELETE) /challenges/${UUID}/consent`,
  `GET /challenges/${UUID}/counts`, `POST /challenges/${UUID}/block`,
].map(pattern => new RegExp(`^(?:${pattern})$`))

export function requestContext(method, path, headers, config) {
  if (typeof method !== 'string' || typeof path !== 'string') fail(400, 'invalid_request', 'Request target is invalid.')
  const native = path === '/api/native' || path.startsWith('/api/native/')
  if (native) {
    if (!config.nativeAccountsEnabled) fail(503, 'native_accounts_disabled', 'Native accounts are disabled.')
    if (Object.hasOwn(headers, 'origin') || Object.hasOwn(headers, 'cookie') || Object.keys(headers).some(key => key.startsWith('sec-fetch-')) || headers['x-fitflow-client'] !== 'native-v1') fail(403, 'native_transport_required', 'Use the dedicated native account transport.')
  }
  if (native && (path.includes('?') || path.includes('#'))) fail(400, 'invalid_request', 'API query parameters are not supported. Do not send secrets in URLs.')
  const prefix = native ? NATIVE_PREFIX : WEB_PREFIX
  const logicalPath = path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null
  if (native && (!logicalPath || !fixedRoutes.has(`${method} ${logicalPath}`) && !variableRoutes.some(pattern => pattern.test(`${method} ${logicalPath}`)))) fail(404, 'not_found', 'Endpoint not found.')
  // This captured context never changes across awaits or concurrent requests.
  return Object.freeze({ channel: native ? 'native' : 'web', headers, logicalPath, sessionTable: native ? 'native_sessions' : 'sessions' })
}
