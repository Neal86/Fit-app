import { randomUUID } from 'node:crypto'
import { ApiError, fail, fields } from './errors.mjs'
import { NATIVE_SESSION_TTL_MS, POLICY_VERSION, RESET_TTL_MS, SESSION_IDLE_MS, SESSION_TTL_MS, VERIFY_TTL_MS, validateConfig } from './config.mjs'
import { canonical, csrfFor, digest, hashPassword, normalizeEmail, nativeCredentialBinding, safeEqual, token, validatePassword, verifyPassword } from './security.mjs'
import { pruneExpired, rateLimit, transaction } from './database.mjs'
import { disabledMailAdapter } from './mail.mjs'
import { validateState } from './state.mjs'
import { normalizeHeaders, requestBodyLimit, requestContext } from './transport.mjs'
import { createCoaching, revokeAthleteCoachingConsent } from './coaching.mjs'
import { createChallenges, revokeAccountChallengeConsent } from './challenges.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const iso = time => time === null ? null : new Date(time).toISOString()
const userView = user => ({ id: user.id, email: user.email, emailVerified: !!user.verified, createdAt: iso(user.created_at) })
const consentView = user => ({ healthSync: !!user.consent, policyVersion: POLICY_VERSION, updatedAt: iso(user.consent_at) })
const syncView = user => ({ revision: user.revision, state: user.state_json ? JSON.parse(user.state_json) : null, updatedAt: iso(user.state_at) })

export function createApp({ db, config, mail = disabledMailAdapter, now = Date.now }) {
  config = validateConfig(config)
  const coaching = createCoaching({ db, now })
  const challenges = createChallenges({ db, now })
  const cookieName = config.secureCookies ? '__Host-fitflow_session' : 'fitflow_session'
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secureCookies ? '; Secure' : ''}`
  let lastPrune = -Infinity
  const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  const userByEmail = email => db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  function requireMail() { if (!mail.enabled) fail(503, 'email_unavailable', 'Email delivery is not configured. Account registration and recovery are unavailable.') }
  async function sendToken(userId, purpose, registrationGeneration) {
    requireMail()
    const raw = token(), hashed = digest(raw), expiresAt = now() + (purpose === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS)
    const column = purpose === 'verify' ? 'verify_generation' : 'reset_generation'
    const delivery = transaction(db, () => {
      const current = userById(userId)
      if (!current || (purpose === 'verify' ? current.verified : !current.verified)) return null
      if (registrationGeneration && current.verify_generation !== registrationGeneration) return null
      // A registration reserves its generation before hashing. Resend must not fall back to an
      // obsolete credential while the newest requested password is still being derived.
      if (purpose === 'verify' && !current.pending_password_hash) fail(503, 'auth_busy', 'Registration is still being prepared. Try again shortly.')
      const generation = registrationGeneration || randomUUID()
      db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(generation, userId)
      // Supersede at request time, not mail-completion time. A late delivery can never win.
      db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose)
      db.prepare('INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at,password_hash,generation) VALUES(?,?,?,?,?,?)').run(hashed, userId, purpose, expiresAt, purpose === 'verify' ? current.pending_password_hash : null, generation)
      return { email: current.email, generation }
    })
    if (!delivery) return
    let timer
    try {
      await Promise.race([
        mail.send({ kind: purpose, to: delivery.email, token: raw, expiresAt: iso(expiresAt) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Email adapter timeout')), 5000) }),
      ])
      transaction(db, () => {
        const current = userById(userId)
        if (!current || current[column] !== delivery.generation || (purpose === 'verify' ? current.verified : !current.verified)) {
          db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(hashed)
          return
        }
        // Confirmation, deletion, pruning, or a newer request may already have removed this row.
        db.prepare('UPDATE email_tokens SET ready = 1 WHERE token_hash = ? AND generation = ? AND expires_at > ?').run(hashed, delivery.generation, now())
      })
    } catch {
      db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(hashed)
      fail(503, 'email_unavailable', 'Email delivery failed. Try again later.')
    } finally { clearTimeout(timer) }
  }
  function rawCookie(headers) {
    if ((headers.cookie || '').length > 4096) return null
    const matching = (headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
    if (matching.length !== 1) return null
    const raw = matching[0].slice(cookieName.length + 1)
    return TOKEN.test(raw) ? raw : null
  }
  function auth(context, touch = true) {
    const { headers, channel, sessionTable } = context
    const raw = channel === 'native' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.authorization || '')?.[1] : rawCookie(headers)
    const row = raw && db.prepare(`SELECT * FROM ${sessionTable} WHERE token_hash = ?`).get(digest(raw))
    if (!row || row.expires_at <= now() || row.last_seen <= now() - SESSION_IDLE_MS) fail(401, 'unauthenticated', 'Sign in again to continue.')
    const user = userById(row.user_id)
    if (!user || channel === 'native' && !safeEqual(row.credential_binding, nativeCredentialBinding(user.password_hash))) fail(401, 'unauthenticated', 'Sign in again to continue.')
    const authenticated = Object.freeze({ user: Object.freeze(user), session: Object.freeze(row), raw })
    // Native CSRF binds the caller's current account context, not an independent factor.
    if (channel === 'native') csrf(headers, authenticated)
    if (touch) db.prepare(`UPDATE ${sessionTable} SET last_seen = ? WHERE token_hash = ?`).run(now(), row.token_hash)
    return authenticated
  }
  function csrf(headers, session) {
    if (!safeEqual(headers['x-csrf-token'], csrfFor(session.raw))) fail(403, 'csrf_failed', 'Refresh your session before trying again.')
  }
  async function reauth(context, password, user) {
    validatePassword(password)
    rateLimit(db, `reauth:${user.id}`, 5, 15 * 60 * 1000, now())
    if (!await verifyPassword(password, user.password_hash)) fail(401, 'invalid_credentials', 'Email or password is incorrect.')
    const current = auth(context, false)
    if (current.user.id !== user.id || current.user.password_hash !== user.password_hash) fail(401, 'unauthenticated', 'Sign in again to continue.')
    return current.user
  }
  function tokenRow(raw, purpose) {
    if (typeof raw !== 'string' || !TOKEN.test(raw)) fail(400, 'invalid_token', 'This link is invalid or has expired.')
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND ready = 1 AND expires_at > ?').get(digest(raw), purpose, now())
    const user = row && userById(row.user_id)
    if (!row || !user || row.generation !== user[purpose === 'verify' ? 'verify_generation' : 'reset_generation'] || (purpose === 'verify' ? user.verified || !safeEqual(row.password_hash, user.pending_password_hash) : !user.verified)) fail(400, 'invalid_token', 'This link is invalid or has expired.')
    return row
  }
  const accepted = { status: 'accepted' }
  async function route(method, path, context, body, ip) {
    const { headers, channel, logicalPath: authPath, sessionTable } = context
    if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok' } }
    if (!authPath) fail(404, 'not_found', 'Endpoint not found.')
    rateLimit(db, `all:${ip}`, 180, 60000, now())
    if (method === 'POST' && ['/auth/register', '/auth/login', '/auth/verification/request', '/auth/password-reset/request'].includes(authPath)) {
      fields(body, authPath === '/auth/register' || authPath === '/auth/login' ? ['email', 'password'] : ['email'])
      const email = normalizeEmail(body.email)
      rateLimit(db, `auth-ip:${ip}`, 30, 15 * 60000, now())
      rateLimit(db, `auth-email:${digest(email)}`, 10, 15 * 60000, now())
      if (authPath === '/auth/register') {
        requireMail()
        validatePassword(body.password)
        const registration = transaction(db, () => {
          let user = userByEmail(email)
          if (user?.verified) return null
          if (!user) {
            const id = randomUUID()
            // No usable password exists until the requested credential is derived and verified.
            db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id, email, '', now())
            user = userById(id)
          }
          const generation = randomUUID()
          db.prepare('UPDATE users SET verify_generation = ?, pending_password_hash = NULL WHERE id = ?').run(generation, user.id)
          db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'").run(user.id)
          return { userId: user.id, generation }
        })
        const passwordHash = await hashPassword(body.password)
        if (registration) {
          const changed = db.prepare('UPDATE users SET pending_password_hash = ? WHERE id = ? AND verify_generation = ? AND verified = 0').run(passwordHash, registration.userId, registration.generation).changes
          if (changed) await sendToken(registration.userId, 'verify', registration.generation)
        }
        return { status: 202, body: { status: 'verification_required' } }
      }
      if (authPath === '/auth/login') {
        const user = userByEmail(email)
        const loginHash = user?.verified ? user.password_hash : user?.pending_password_hash
        if (!await verifyPassword(body.password, loginHash)) fail(401, 'invalid_credentials', 'Email or password is incorrect.')
        const raw = token(), lifetime = channel === 'native' ? NATIVE_SESSION_TTL_MS : SESSION_TTL_MS
        const expires = now() + lifetime
        const current = transaction(db, () => {
          // Re-read under the issuance lock after async hashing. Reset/deletion cannot
          // authorize a stale login or race between credential binding and insertion.
          const current = userById(user.id)
          if (!current || (current.verified ? current.password_hash : current.pending_password_hash) !== loginHash) fail(401, 'invalid_credentials', 'Email or password is incorrect.')
          if (!current.verified) fail(403, 'email_unverified', 'Verify your email before signing in.')
          const previous = channel === 'web' ? rawCookie(headers) : null
          if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(previous))
          for (const table of ['sessions', 'native_sessions']) db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND (expires_at <= ? OR last_seen <= ?)`).run(current.id, now(), now() - SESSION_IDLE_MS)
          // A single atomic cap across both channels, with deterministic tie-breaking.
          const overflow = db.prepare(`SELECT 'sessions' AS source, token_hash, last_seen, expires_at FROM sessions WHERE user_id = ?
            UNION ALL SELECT 'native_sessions' AS source, token_hash, last_seen, expires_at FROM native_sessions WHERE user_id = ?
            ORDER BY last_seen DESC, expires_at DESC, source, token_hash LIMIT -1 OFFSET 9`).all(current.id, current.id)
          for (const row of overflow) db.prepare(`DELETE FROM ${row.source} WHERE token_hash = ?`).run(row.token_hash)
          if (channel === 'native') db.prepare('INSERT INTO native_sessions(token_hash,user_id,expires_at,last_seen,credential_binding) VALUES(?,?,?,?,?)').run(digest(raw), current.id, expires, now(), nativeCredentialBinding(current.password_hash))
          else db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES(?,?,?,?)').run(digest(raw), current.id, expires, now())
          return current
        })
        const session = { user: userView(current), csrfToken: csrfFor(raw), sessionExpiresAt: iso(expires) }
        return channel === 'native'
          ? { status: 200, body: { session, nativeToken: raw } }
          : { status: 200, headers: { 'set-cookie': cookie(raw, lifetime / 1000) }, body: session }
      }
      requireMail()
      const user = userByEmail(email)
      if (authPath === '/auth/verification/request' && user && !user.verified) await sendToken(user.id, 'verify')
      if (authPath === '/auth/password-reset/request' && user?.verified) await sendToken(user.id, 'reset')
      return { status: 202, body: accepted }
    }
    if (method === 'POST' && ['/auth/verification/confirm', '/auth/password-reset/confirm'].includes(authPath)) {
      const resetting = authPath.includes('password-reset')
      fields(body, resetting ? ['token', 'password'] : ['token'])
      rateLimit(db, `token-ip:${ip}`, 15, 15 * 60000, now())
      tokenRow(body.token, resetting ? 'reset' : 'verify')
      const passwordHash = resetting ? await hashPassword(body.password) : null
      transaction(db, () => {
        const row = tokenRow(body.token, resetting ? 'reset' : 'verify')
        db.prepare('UPDATE users SET verified = 1, password_hash = ?, pending_password_hash = NULL, verify_generation = ?, reset_generation = ? WHERE id = ?').run(resetting ? passwordHash : row.password_hash, randomUUID(), randomUUID(), row.user_id)
        db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(row.user_id)
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id)
        db.prepare('DELETE FROM native_sessions WHERE user_id = ?').run(row.user_id)
      })
      return { status: 200, body: { status: resetting ? 'password_reset' : 'verified' } }
    }
    const session = auth(context)
    let user = session.user
    if (!(method === 'GET' && authPath === '/auth/session')) csrf(headers, session)
    if (method === 'GET' && authPath === '/auth/session') return { status: 200, body: { user: userView(user), csrfToken: csrfFor(session.raw), sessionExpiresAt: iso(session.session.expires_at) } }
    if (authPath === '/challenges' || authPath.startsWith('/challenges/')) return challenges(method, authPath, body, user.id)
    if (authPath === '/coaching' || authPath.startsWith('/coaching/')) return coaching(method, authPath, body, user.id)
    if (method === 'POST' && authPath === '/auth/logout') {
      fields(body, [])
      db.prepare(`DELETE FROM ${sessionTable} WHERE token_hash = ?`).run(session.session.token_hash)
      return { status: 204, ...(channel === 'web' ? { headers: { 'set-cookie': cookie('', 0) } } : {}) }
    }
    if (method === 'GET' && authPath === '/consent') return { status: 200, body: consentView(user) }
    if (method === 'PUT' && authPath === '/consent') {
      fields(body, ['healthSync', 'policyVersion'])
      if (typeof body.healthSync !== 'boolean' || body.policyVersion !== POLICY_VERSION) fail(400, 'invalid_consent', 'Explicit health-sync consent and the current policy version are required.')
      transaction(db, () => {
        db.prepare('UPDATE users SET consent = ?, consent_policy = ?, consent_at = ? WHERE id = ?').run(Number(body.healthSync), POLICY_VERSION, now(), user.id)
        if (!body.healthSync) {
          // A revision tombstone prevents any offline write from restoring a revoked snapshot.
          db.prepare('UPDATE users SET state_json = NULL, state_at = ?, revision = revision + 1 WHERE id = ?').run(now(), user.id)
          db.prepare('DELETE FROM sync_operations WHERE user_id = ?').run(user.id)
          revokeAthleteCoachingConsent(db, user.id, now())
          revokeAccountChallengeConsent(db, user.id, now())
        }
      })
      return { status: 200, body: consentView(userById(user.id)) }
    }
    if (authPath === '/sync' && ['GET', 'PUT'].includes(method)) {
      if (!user.verified || !user.consent || user.consent_policy !== POLICY_VERSION) fail(403, 'consent_required', 'Opt in to health-data sync before reading or uploading fitness data.')
      if (method === 'GET') return { status: 200, body: syncView(user) }
      fields(body, ['baseRevision', 'operationId', 'state'])
      if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || typeof body.operationId !== 'string' || !UUID.test(body.operationId)) fail(400, 'invalid_request', 'A nonnegative base revision and UUID operation ID are required.')
      body.state = validateState(body.state)
      const requestHash = digest(canonical(body))
      const result = transaction(db, () => {
        const prior = db.prepare('SELECT * FROM sync_operations WHERE user_id = ? AND operation_id = ?').get(user.id, body.operationId)
        if (prior) {
          if (!safeEqual(prior.request_hash, requestHash)) fail(409, 'idempotency_conflict', 'This operation ID was already used for a different request.')
          return { revision: prior.revision, updatedAt: iso(prior.updated_at), replayed: true }
        }
        user = userById(user.id)
        if (body.baseRevision !== user.revision) fail(409, 'sync_conflict', 'Cloud data changed. Fetch it and choose how to resolve the conflict.', { revision: user.revision })
        if (user.revision >= Number.MAX_SAFE_INTEGER) fail(409, 'revision_limit', 'The account revision limit has been reached.')
        // Keep exact idempotency guarantees; never silently evict old operation IDs.
        if (db.prepare('SELECT COUNT(*) AS count FROM sync_operations WHERE user_id = ?').get(user.id).count >= 100000) fail(409, 'operation_limit', 'The account sync operation limit has been reached. Export your data and contact the operator.')
        const updated = now(), revision = user.revision + 1
        db.prepare('UPDATE users SET state_json = ?, revision = ?, state_at = ? WHERE id = ?').run(JSON.stringify(body.state), revision, updated, user.id)
        db.prepare('INSERT INTO sync_operations(user_id,operation_id,request_hash,revision,updated_at) VALUES(?,?,?,?,?)').run(user.id, body.operationId, requestHash, revision, updated)
        return { revision, updatedAt: iso(updated), replayed: false }
      })
      return { status: 200, body: result }
    }
    if (method === 'POST' && authPath === '/account/export') {
      fields(body, ['password'])
      await reauth(context, body.password, user)
      user = auth(context, false).user
      return { status: 200, body: { format: 'fitflow-account-export', version: 1, exportedAt: iso(now()), user: userView(user), consent: consentView(user), sync: syncView(user), coaching: coaching.exportAccount(user.id), challenges: challenges.exportAccount(user.id) } }
    }
    if (method === 'DELETE' && authPath === '/account') {
      fields(body, ['password', 'confirmation'])
      if (body.confirmation !== 'DELETE') fail(400, 'confirmation_required', 'Explicit DELETE confirmation is required.')
      await reauth(context, body.password, user)
      user = auth(context, false).user
      transaction(db, () => { db.prepare('DELETE FROM users WHERE id = ?').run(user.id) })
      return { status: 204, ...(channel === 'web' ? { headers: { 'set-cookie': cookie('', 0) } } : {}) }
    }
    fail(404, 'not_found', 'Endpoint not found.')
  }
  return {
    cookieName,
    async handle({ method = 'GET', path = '/', headers = {}, body = '', ip = 'unknown' }) {
      const responseHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", vary: 'Origin' }
      if (config.secureCookies) responseHeaders['strict-transport-security'] = 'max-age=31536000'
      try {
        headers = normalizeHeaders(headers)
        const context = requestContext(method, path, headers, config)
        if (now() - lastPrune >= 60000) { pruneExpired(db, now()); lastPrune = now() }
        if (context.channel === 'web') {
          if (headers.origin && headers.origin !== config.origin || headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_forbidden', 'This request origin is not allowed.')
          if (headers.origin === config.origin) Object.assign(responseHeaders, { 'access-control-allow-origin': config.origin, 'access-control-allow-credentials': 'true' })
        }
        const logicalPath = context.logicalPath || ''
        if ((logicalPath === '/challenges' || logicalPath.startsWith('/challenges/')) && !config.challengesEnabled) fail(503, 'challenges_disabled', 'Private challenges are disabled.')
        if ((logicalPath === '/coaching' || logicalPath.startsWith('/coaching/')) && !config.coachingEnabled) fail(503, 'coaching_disabled', 'Coach collaboration is disabled.')
        if (method === 'OPTIONS') {
          if (headers.origin !== config.origin || !['GET', 'POST', 'PUT', 'DELETE'].includes(headers['access-control-request-method'])) fail(403, 'origin_forbidden', 'This request origin is not allowed.')
          return { status: 204, headers: { ...responseHeaders, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': 'Content-Type, X-Fitflow-Client, X-CSRF-Token' } }
        }
        if (path.includes('?') || path.includes('#')) fail(400, 'invalid_request', 'API query parameters are not supported. Do not send secrets in URLs.')
        const mutating = !['GET', 'HEAD'].includes(method)
        if (context.channel === 'web' && mutating && (headers.origin !== config.origin || headers['x-fitflow-client'] !== 'web')) fail(403, 'origin_forbidden', 'An allowed origin and X-Fitflow-Client header are required.')
        if (mutating && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')) fail(415, 'unsupported_media_type', 'Use application/json.')
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') fail(415, 'unsupported_encoding', 'Compressed request bodies are not supported.')
        const limit = requestBodyLimit(method, path)
        const raw = typeof body === 'string' ? body : JSON.stringify(body)
        if (Buffer.byteLength(raw) > limit) fail(413, 'body_too_large', 'Request body is too large.')
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { fail(400, 'invalid_json', 'Request body is not valid JSON.') }
        const result = await route(method, path, context, parsed, ip)
        return { ...result, headers: { ...responseHeaders, ...result.headers } }
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 429) responseHeaders['retry-after'] = String(error.details.retryAfterSeconds)
          return { status: error.status, headers: responseHeaders, body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } }
        }
        // Never leak database, password, mail adapter, request body, or token details.
        return { status: 500, headers: responseHeaders, body: { error: { code: 'internal_error', message: 'The request could not be completed.' } } }
      }
    },
  }
}
