import { AI_PLAN_LIMITS, canonicalAiPlanRequest, parseAiPlanOutput, parseAiPlanRequest } from '../.server-build/aiPlanContract.js'
import { SESSION_IDLE_MS } from './config.mjs'
import { rateLimit, transaction } from './database.mjs'
import { fail, fields } from './errors.mjs'
import { canonical, digest, safeEqual, token } from './security.mjs'

export const AI_PLAN_POLICY_LIMITS = Object.freeze({ requestBytes: AI_PLAN_LIMITS.requestBytes, outputBytes: AI_PLAN_LIMITS.outputBytes, timeoutMs: 15000, intentTtlMs: 300000, resultTtlMs: 600000 })
const MAX_RECORDS = 128, MAX_ACCOUNT_ACTIVE = 2, TOMBSTONE_MS = 60000
const HEX = /^[a-f0-9]{64}$/
// A cancelled/timed-out adapter still owns this process-wide slot until its actual settlement.
let providerInFlight = 0
const unavailable = () => fail(503, 'ai_unavailable', 'AI composition is not configured and available.')
const invalid = () => fail(400, 'invalid_ai_request', 'AI composition request fields are invalid.')
const fixedErrors = Object.freeze({
  ai_failed: Object.freeze({ code: 'ai_failed', message: 'AI composition could not be completed.' }),
  ai_timeout: Object.freeze({ code: 'ai_timeout', message: 'AI composition timed out. A provider charge may still apply.' }),
  ai_invalid_output: Object.freeze({ code: 'ai_invalid_output', message: 'AI composition returned an invalid result.' }),
})
function text(value, maximum = 1024) {
  if (typeof value !== 'string' || !value.length || value !== value.trim() || Buffer.byteLength(value) > maximum || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid()
  return value
}
function policyFields(value, required) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid()
  fields(value, required)
}
export function validateAiPlanPolicy(value) {
  policyFields(value, ['version', 'revision', 'backendOperator', 'provider', 'model', 'processingDestination', 'processingRegion', 'retention', 'training', 'cost', 'cancellationMayCharge', 'limits'])
  policyFields(value.cost, ['currency', 'maxChargeMinorUnits'])
  policyFields(value.limits, Object.keys(AI_PLAN_POLICY_LIMITS))
  if (value.version !== 1 || value.cancellationMayCharge !== true || typeof value.cost.currency !== 'string' || !/^[A-Z]{3}$/.test(value.cost.currency) || !Number.isSafeInteger(value.cost.maxChargeMinorUnits) || value.cost.maxChargeMinorUnits < 0 || value.cost.maxChargeMinorUnits > 100000 || Object.entries(AI_PLAN_POLICY_LIMITS).some(([key, limit]) => value.limits[key] !== limit)) invalid()
  return Object.freeze({ version: 1, revision: text(value.revision, 80), backendOperator: text(value.backendOperator), provider: text(value.provider), model: text(value.model), processingDestination: text(value.processingDestination), processingRegion: text(value.processingRegion), retention: text(value.retention), training: text(value.training), cost: Object.freeze({ currency: value.cost.currency, maxChargeMinorUnits: value.cost.maxChargeMinorUnits }), cancellationMayCharge: true, limits: AI_PLAN_POLICY_LIMITS })
}
export const aiPlanPolicyDigest = policy => digest(canonical(validateAiPlanPolicy(policy)))

export function createAiPlans({ db, config, adapter, now = Date.now }) {
  let policy, policyDigest, ready = false
  try {
    policy = validateAiPlanPolicy(config.aiPlanPolicy)
    policyDigest = digest(canonical(policy))
    ready = config.aiPlansEnabled === true && adapter?.enabled === true && typeof adapter.generate === 'function' && safeEqual(adapter.policyDigest, policyDigest)
  } catch { /* Incomplete or invalid disclosures never enable transmission. */ }
  const generateWithAdapter = ready ? adapter.generate.bind(adapter) : undefined
  const adapterMatchesPolicy = () => ready && adapter.enabled === true && safeEqual(adapter.policyDigest, policyDigest)
  const records = new Map()
  let closed = false
  function view(record) {
    if (record.expiresAt <= now() && record.status !== 'expired') expire(record)
    return { intentId: record.id, status: record.status, policyDigest: record.policyDigest, expiresAt: new Date(record.expiresAt).toISOString(), ...(record.status === 'complete' ? { result: record.result } : {}), ...(record.status === 'failed' ? { error: record.error } : {}) }
  }
  function stopWork(record) {
    clearTimeout(record.timeoutTimer)
    clearInterval(record.authTimer)
    if (record.controller && !record.controller.signal.aborted) record.controller.abort()
    record.finish?.()
  }
  function terminate(record, status, code) {
    if (record.status === 'expired') return
    record.status = status
    record.result = undefined
    record.error = status === 'failed' ? fixedErrors[code] : undefined
    stopWork(record)
  }
  function expire(record) {
    terminate(record, 'expired')
    clearTimeout(record.expiryTimer)
    record.purgeAt = record.expiresAt + TOMBSTONE_MS
    record.expiryTimer = setTimeout(() => { records.delete(record.id) }, Math.max(1, record.purgeAt - now()))
    record.expiryTimer.unref?.()
  }
  function armExpiry(record) {
    clearTimeout(record.expiryTimer)
    record.expiryTimer = setTimeout(() => expire(record), Math.max(1, record.expiresAt - now()))
    record.expiryTimer.unref?.()
  }
  function authorized(record) {
    try {
      const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(record.sessionHash)
      const user = session && db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id)
      return !!session && session.user_id === record.accountId && session.expires_at === record.sessionExpiresAt && session.expires_at > now() && session.last_seen > now() - SESSION_IDLE_MS && !!user?.verified && safeEqual(digest(user.password_hash), record.passwordBinding) && user.reset_generation === record.resetGeneration && user.verify_generation === record.verifyGeneration && record.policyDigest === policyDigest && adapterMatchesPolicy()
    } catch { return false }
  }
  function sweep() {
    for (const record of records.values()) {
      if (record.purgeAt && record.purgeAt <= now()) { clearTimeout(record.expiryTimer); records.delete(record.id); continue }
      if (record.expiresAt <= now() && record.status !== 'expired') { expire(record); continue }
      if (record.status === 'running' && record.dispatchDeadline <= now()) terminate(record, 'failed', 'ai_timeout')
      if (['prepared', 'running', 'complete'].includes(record.status) && !authorized(record)) terminate(record, 'cancelled')
    }
  }
  function requireBinding(record) {
    if (!authorized(record)) { terminate(record, 'cancelled'); fail(401, 'unauthenticated', 'Sign in again to continue.') }
  }
  function validateBinding(body, record) {
    if (body.policyRevision !== policy.revision || !safeEqual(body.policyDigest, policyDigest) || !HEX.test(body.payloadDigest) || !Number.isSafeInteger(body.payloadBytes) || body.payloadBytes < 1 || body.payloadBytes > AI_PLAN_LIMITS.requestBytes) invalid()
    if (record && (!safeEqual(body.payloadDigest, record.payloadDigest) || body.payloadBytes !== record.payloadBytes || !safeEqual(body.policyDigest, record.policyDigest))) fail(409, 'ai_intent_conflict', 'This intent does not match the reviewed request.')
  }
  async function generate(record, body, signal) {
    fields(body, ['request', 'consent'])
    fields(body.consent, ['accepted', 'policyRevision', 'policyDigest', 'payloadDigest', 'payloadBytes'])
    if (body.consent.accepted !== true) fail(403, 'ai_consent_required', 'Explicit consent to this payload and recipient policy is required.')
    validateBinding(body.consent, record)
    let request, serialized
    try { request = parseAiPlanRequest(body.request); serialized = canonicalAiPlanRequest(request) } catch { invalid() }
    if (Buffer.byteLength(serialized) !== record.payloadBytes || !safeEqual(digest(serialized), record.payloadDigest)) fail(409, 'ai_intent_conflict', 'This intent does not match the reviewed request.')
    requireBinding(record)
    if (record.expiresAt <= now() && record.status !== 'expired') expire(record)
    if (record.status !== 'prepared') return { status: record.status === 'running' ? 202 : 200, body: view(record) }
    if (signal?.aborted) { terminate(record, 'cancelled'); return { status: 200, body: view(record) } }
    if (providerInFlight >= 1) fail(503, 'ai_busy', 'AI composition is busy. Try again later.')
    transaction(db, () => {
      requireBinding(record)
      rateLimit(db, `ai-dispatch:hour:${record.accountId}`, 3, 60 * 60 * 1000, now())
      rateLimit(db, `ai-dispatch:day:${record.accountId}`, 10, 24 * 60 * 60 * 1000, now())
      rateLimit(db, 'ai-dispatch:global-day', 30, 24 * 60 * 60 * 1000, now())
    })
    // The state transition is synchronous and happens before the only adapter call.
    record.status = 'running'
    record.expiresAt = Math.min(record.sessionExpiresAt, now() + AI_PLAN_POLICY_LIMITS.resultTtlMs)
    record.dispatchDeadline = now() + AI_PLAN_POLICY_LIMITS.timeoutMs
    record.controller = new AbortController()
    const finished = new Promise(resolve => { record.finish = resolve })
    const disconnected = () => terminate(record, 'cancelled')
    signal?.addEventListener('abort', disconnected, { once: true })
    record.timeoutTimer = setTimeout(() => terminate(record, 'failed', 'ai_timeout'), AI_PLAN_POLICY_LIMITS.timeoutMs)
    record.timeoutTimer.unref?.()
    record.authTimer = setInterval(() => { if (!authorized(record)) terminate(record, 'cancelled') }, 250)
    record.authTimer.unref?.()
    armExpiry(record)
    providerInFlight++
    // No retry, fallback, URL selection, or model override exists at this boundary.
    const dispatch = Promise.resolve().then(() => {
      requireBinding(record)
      if (record.status !== 'running' || record.controller.signal.aborted) return undefined
      if (record.dispatchDeadline <= now()) { terminate(record, 'failed', 'ai_timeout'); return undefined }
      return generateWithAdapter({ request, policy, policyDigest, signal: record.controller.signal, maxOutputBytes: AI_PLAN_LIMITS.outputBytes })
    }).then(raw => {
      if (record.status !== 'running') return
      if (record.dispatchDeadline <= now()) { terminate(record, 'failed', 'ai_timeout'); return }
      if (!authorized(record)) { terminate(record, 'cancelled'); return }
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > AI_PLAN_LIMITS.outputBytes) { terminate(record, 'failed', 'ai_invalid_output'); return }
      let result
      try { result = parseAiPlanOutput(JSON.parse(raw), request) } catch { terminate(record, 'failed', 'ai_invalid_output'); return }
      if (!authorized(record)) { terminate(record, 'cancelled'); return }
      if (record.dispatchDeadline <= now()) { terminate(record, 'failed', 'ai_timeout'); return }
      record.result = result
      record.status = 'complete'
      clearTimeout(record.timeoutTimer)
      clearInterval(record.authTimer)
      record.finish()
    }, () => { if (record.status === 'running') terminate(record, 'failed', 'ai_failed') }).finally(() => { providerInFlight--; clearInterval(record.authTimer) })
    // Observe all adapter outcomes, including a rejection after a timeout or cancellation.
    dispatch.catch(() => { if (record.status === 'running') terminate(record, 'failed', 'ai_failed') })
    try {
      await finished
      requireBinding(record)
      return { status: 200, body: view(record) }
    } finally {
      signal?.removeEventListener('abort', disconnected)
      record.finish = undefined
    }
  }
  async function handle(method, path, body, session, signal) {
    if (!adapterMatchesPolicy() || closed) unavailable()
    if (!session.user.verified) fail(403, 'email_unverified', 'Verify your email before using AI composition.')
    sweep()
    if (method === 'GET' && path === '/ai-plans/policy') { fields(body, []); return { status: 200, body: { policy, policyDigest } } }
    if (method === 'POST' && path === '/ai-plans/prepare') {
      fields(body, ['policyRevision', 'policyDigest', 'payloadDigest', 'payloadBytes'])
      validateBinding(body)
      if (signal?.aborted) fail(409, 'ai_cancelled', 'AI composition was cancelled.')
      if (records.size >= MAX_RECORDS || [...records.values()].filter(record => record.accountId === session.user.id && ['prepared', 'running', 'complete'].includes(record.status)).length >= MAX_ACCOUNT_ACTIVE) fail(503, 'ai_capacity', 'AI composition capacity is temporarily full.')
      const record = { id: token(), status: 'prepared', accountId: session.user.id, sessionHash: session.session.token_hash, sessionExpiresAt: session.session.expires_at, passwordBinding: digest(session.user.password_hash), resetGeneration: session.user.reset_generation, verifyGeneration: session.user.verify_generation, policyDigest, payloadDigest: body.payloadDigest, payloadBytes: body.payloadBytes, expiresAt: Math.min(session.session.expires_at, now() + AI_PLAN_POLICY_LIMITS.intentTtlMs) }
      requireBinding(record)
      transaction(db, () => {
        rateLimit(db, `ai-prepare:hour:${record.accountId}`, 6, 60 * 60 * 1000, now())
        rateLimit(db, `ai-prepare:day:${record.accountId}`, 12, 24 * 60 * 60 * 1000, now())
        rateLimit(db, 'ai-prepare:global-hour', 120, 60 * 60 * 1000, now())
        rateLimit(db, 'ai-prepare:global-day', 240, 24 * 60 * 60 * 1000, now())
      })
      records.set(record.id, record)
      armExpiry(record)
      return { status: 201, body: view(record) }
    }
    const match = /^\/ai-plans\/([A-Za-z0-9_-]{43})(?:\/(generate|cancel))?$/.exec(path)
    if (!match || !((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) fail(404, 'not_found', 'Endpoint not found.')
    const record = records.get(match[1])
    if (!record || record.accountId !== session.user.id || record.sessionHash !== session.session.token_hash) fail(404, 'ai_intent_not_found', 'This AI composition intent is unavailable. Review and consent again to prepare a new intent.')
    requireBinding(record)
    if (match[2] === 'generate') return generate(record, body, signal)
    fields(body, [])
    if (match[2] === 'cancel') terminate(record, 'cancelled')
    return { status: 200, body: view(record) }
  }
  return {
    handle,
    revokeAccount(accountId) { for (const record of records.values()) if (record.accountId === accountId) terminate(record, 'cancelled') },
    revokeSession(sessionHash) { for (const record of records.values()) if (record.sessionHash === sessionHash) terminate(record, 'cancelled') },
    close() { closed = true; for (const record of records.values()) { terminate(record, 'cancelled'); clearTimeout(record.expiryTimer) }; records.clear() },
  }
}
