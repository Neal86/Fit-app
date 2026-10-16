import { randomUUID } from 'node:crypto'
import { POLICY_VERSION } from './config.mjs'
import { rateLimit, transaction } from './database.mjs'
import { fail, fields } from './errors.mjs'
import { normalizeEmail } from './security.mjs'
import { validateState } from './state.mjs'

export const CHALLENGE_POLICY_VERSION = '2026-10-15'
export const CHALLENGE_METRIC = 'recorded_training_days'
export const CHALLENGE_INVITATION_TTL_MS = 7 * 86400000
export const CHALLENGE_RETENTION_MS = 7 * 86400000
export const CHALLENGE_LIMITS = Object.freeze({ perAccount: 50, pendingPerRecipient: 50, total: 10000, maxWindowDays: 31 })
const DAY = 86400000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const iso = value => value === null ? null : new Date(value).toISOString()
const person = row => ({ id: row.id, email: row.email })
const notFound = () => fail(404, 'not_found', 'This private challenge item is unavailable.')
const unavailable = () => fail(403, 'sharing_unavailable', 'Current permission for this private challenge is unavailable.')
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const windowEnd = row => Date.parse(`${row.end_date}T00:00:00Z`) + DAY
const consentColumns = row => row.inviter_consent && row.invitee_consent && row.inviter_policy === CHALLENGE_POLICY_VERSION && row.invitee_policy === CHALLENGE_POLICY_VERSION
const currentCloudConsent = user => user?.verified && user.consent && user.consent_policy === POLICY_VERSION

// The rule is deliberately independent of editable local analytics. Only completed,
// positive, non-warmup set evidence in a saved cloud log qualifies. Legacy logs,
// timers, calories, completed flags alone and timezone-less timestamps never count.
export function recordedTrainingDays(state, startDate, endDate, now) {
  const days = new Set()
  for (const log of state.logs) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(log.completedAt) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(log.startedAt)) continue
    const completed = Date.parse(log.completedAt), started = Date.parse(log.startedAt)
    if (!Number.isFinite(completed) || !Number.isFinite(started) || started > completed || completed > now) continue
    if (!log.sets?.some(set => set.completed === true && set.warmup === false && (set.reps > 0 || set.seconds > 0))) continue
    const day = new Date(completed).toISOString().slice(0, 10)
    if (day >= startDate && day <= endDate) days.add(day)
  }
  return days.size
}

export function revokeAccountChallengeConsent(db, userId, now) {
  // Same transaction as cloud snapshot removal. Clear BOTH reviewed grants so no
  // combination of re-enabling cloud consent, upload, or stale retry restores access.
  db.prepare(`UPDATE private_challenges SET inviter_consent = 0, invitee_consent = 0,
    inviter_policy = NULL, invitee_policy = NULL, inviter_consent_at = ?, invitee_consent_at = ?,
    version = MIN(version + 1, 9007199254740991)
    WHERE (inviter_id = ? OR invitee_id = ?) AND status = 'active'`).run(now, now, userId, userId)
}

export function createChallenges({ db, now }) {
  const user = id => db.prepare('SELECT id,email,verified,consent,consent_policy FROM users WHERE id = ?').get(id)
  const byId = id => db.prepare('SELECT * FROM private_challenges WHERE id = ?').get(id)
  const blocked = (a, b) => !!db.prepare('SELECT 1 FROM challenge_blocks WHERE (owner_id = ? AND target_id = ?) OR (owner_id = ? AND target_id = ?)').get(a, b, b, a)
  function metadata(row, actorId) {
    const inviter = row.inviter_id === actorId
    return {
      id: row.id, role: inviter ? 'inviter' : 'invitee', startDate: row.start_date, endDate: row.end_date,
      status: row.status, version: row.version, ownConsent: !!row[inviter ? 'inviter_consent' : 'invitee_consent'],
      createdAt: iso(row.created_at), acceptedAt: iso(row.accepted_at), expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at),
    }
  }
  function view(row, actorId) {
    return { ...metadata(row, actorId), counterpart: person(user(row.inviter_id === actorId ? row.invitee_id : row.inviter_id)),
      peerConsent: !!row[row.inviter_id === actorId ? 'invitee_consent' : 'inviter_consent'], policyVersion: CHALLENGE_POLICY_VERSION }
  }
  function owned(id, actorId, invitation = false) {
    if (typeof id !== 'string' || !UUID.test(id)) notFound()
    const row = byId(id)
    if (!row || (invitation ? row.invitee_id !== actorId : row.inviter_id !== actorId && row.invitee_id !== actorId)) notFound()
    // Pending/declined/never-accepted expired items are recipient-only. There is no
    // outgoing receipt, including through guessed item endpoints or account export.
    if (row.accepted_at === null && row.invitee_id !== actorId) notFound()
    return row
  }
  function expected(row, version) {
    if (!Number.isSafeInteger(version) || version < 1) fail(400, 'invalid_request', 'A positive challenge base version is required.')
    if (version !== row.version) fail(409, 'challenge_conflict', 'The challenge changed. Refresh before trying again.', { version: row.version })
  }
  function canAdvance(row) {
    // Keep a final distinct version available for revocation at the safe-integer ceiling.
    if (row.version >= Number.MAX_SAFE_INTEGER - 1) fail(409, 'revision_limit', 'The challenge version limit has been reached. Leave this challenge.')
  }
  function expire() {
    db.prepare(`UPDATE private_challenges SET status = 'expired', inviter_consent = 0, invitee_consent = 0,
      inviter_policy = NULL, invitee_policy = NULL, version = MIN(version + 1, 9007199254740991)
      WHERE status IN ('pending','active') AND expires_at <= ?`).run(now())
  }
  function terminal(id) {
    db.prepare(`UPDATE private_challenges SET status = 'revoked', inviter_consent = 0, invitee_consent = 0,
      inviter_policy = NULL, invitee_policy = NULL, revoked_at = ?, version = MIN(version + 1, 9007199254740991)
      WHERE id = ? AND status IN ('pending','active')`).run(now(), id)
  }
  function accountCapacity(id) {
    const attempts = db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(id)?.attempts || 0
    const accepted = db.prepare('SELECT COUNT(*) AS count FROM private_challenges WHERE invitee_id = ? AND accepted_at IS NOT NULL').get(id).count
    return attempts + accepted < CHALLENGE_LIMITS.perAccount
  }
  function reserveAttempt(actorId) {
    const global = db.prepare('SELECT attempts FROM challenge_global_budget WHERE id = 1').get()
    if (!accountCapacity(actorId) || !global || global.attempts >= CHALLENGE_LIMITS.total) return false
    db.prepare('UPDATE challenge_global_budget SET attempts = attempts + 1 WHERE id = 1').run()
    db.prepare('INSERT INTO challenge_invitation_budgets(user_id,attempts) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET attempts = attempts + 1').run(actorId)
    return true
  }
  function acceptedRows(actorId) {
    return db.prepare('SELECT * FROM private_challenges WHERE (inviter_id = ? OR invitee_id = ?) AND accepted_at IS NOT NULL ORDER BY created_at,id').all(actorId, actorId)
  }
  function overview(actorId) {
    const invitations = db.prepare("SELECT * FROM private_challenges WHERE invitee_id = ? AND status = 'pending' ORDER BY created_at,id").all(actorId)
      .filter(row => user(row.inviter_id)?.verified && !blocked(row.inviter_id, row.invitee_id))
      .map(row => ({ id: row.id, inviter: person(user(row.inviter_id)), startDate: row.start_date, endDate: row.end_date, version: row.version, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }))
    return { policyVersion: CHALLENGE_POLICY_VERSION, metric: CHALLENGE_METRIC, invitations, challenges: acceptedRows(actorId).map(row => view(row, actorId)) }
  }
  function route(method, path, body, actorId) {
    const actor = user(actorId)
    if (!actor?.verified) fail(403, 'email_unverified', 'A verified account is required for private challenges.')
    expire()
    if (method === 'GET' && path === '/challenges') {
      fields(body, [])
      return { status: 200, body: overview(actorId) }
    }
    if (method === 'POST' && path === '/challenges/invitations') {
      fields(body, ['email', 'startDate', 'endDate'])
      const email = normalizeEmail(body.email), { startDate, endDate } = body
      if (!validDay(startDate) || !validDay(endDate) || endDate > '9999-12-23' || endDate < startDate || (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY >= CHALLENGE_LIMITS.maxWindowDays || Date.parse(`${endDate}T00:00:00Z`) + DAY <= now()) fail(400, 'invalid_window', 'Choose an inclusive window of 1–31 real UTC dates that has not ended.')
      const accepted = { status: 202, body: { status: 'accepted' } }
      // Reserve identically BEFORE target lookup; never refund on any outcome.
      if (!reserveAttempt(actorId)) return accepted
      const recipient = db.prepare('SELECT id,verified FROM users WHERE email = ?').get(email)
      if (!recipient?.verified || recipient.id === actorId || blocked(actorId, recipient.id) || !accountCapacity(recipient.id)) return accepted
      if (db.prepare("SELECT COUNT(*) AS count FROM private_challenges WHERE invitee_id = ? AND status = 'pending'").get(recipient.id).count >= CHALLENGE_LIMITS.pendingPerRecipient) return accepted
      if (db.prepare("SELECT 1 FROM private_challenges WHERE ((inviter_id = ? AND invitee_id = ?) OR (inviter_id = ? AND invitee_id = ?)) AND status IN ('pending','active')").get(actorId, recipient.id, recipient.id, actorId)) return accepted
      db.prepare("INSERT INTO private_challenges(id,inviter_id,invitee_id,status,start_date,end_date,created_at,expires_at) VALUES(?,?,?,'pending',?,?,?,?)")
        .run(randomUUID(), actorId, recipient.id, startDate, endDate, now(), Math.min(now() + CHALLENGE_INVITATION_TTL_MS, Date.parse(`${endDate}T00:00:00Z`) + DAY))
      return accepted
    }
    const invitation = /^\/challenges\/invitations\/([^/]+)(\/accept)?$/.exec(path)
    if (invitation && (method === 'POST' && invitation[2] || method === 'DELETE' && !invitation[2])) {
      fields(body, ['baseVersion'])
      const row = owned(invitation[1], actorId, true)
      expected(row, body.baseVersion)
      if (method === 'DELETE') {
        if (!['pending', 'declined'].includes(row.status)) notFound()
        if (row.status === 'pending') db.prepare("UPDATE private_challenges SET status = 'declined', version = MIN(version + 1, 9007199254740991) WHERE id = ?").run(row.id)
        return { status: 204 }
      }
      if (!['pending', 'active'].includes(row.status) || blocked(row.inviter_id, row.invitee_id) || !user(row.inviter_id)?.verified) notFound()
      if (row.status === 'pending') {
        if (!accountCapacity(actorId)) fail(409, 'challenge_limit', 'Your accepted private challenge capacity has been reached.')
        canAdvance(row)
        db.prepare("UPDATE private_challenges SET status = 'active', accepted_at = ?, expires_at = ?, version = version + 1 WHERE id = ?").run(now(), windowEnd(row) + CHALLENGE_RETENTION_MS, row.id)
      }
      return { status: 200, body: { challenge: view(byId(row.id), actorId) } }
    }
    const match = /^\/challenges\/([^/]+)(?:\/(consent|counts|block))?$/.exec(path)
    if (!match) notFound()
    const [, id, action] = match, row = owned(id, actorId)
    if (method === 'POST' && action === 'block') {
      fields(body, ['baseVersion'])
      expected(row, body.baseVersion)
      const counterpartId = row.inviter_id === actorId ? row.invitee_id : row.inviter_id
      // Only a previously known incoming/accepted item authorizes blocking this pair.
      // Each distinct block requires a globally bounded challenge record; at most
      // two directed blocks per admitted record, with no arbitrary identity lookup.
      db.prepare('INSERT OR IGNORE INTO challenge_blocks(owner_id,target_id,created_at) VALUES(?,?,?)').run(actorId, counterpartId, now())
      for (const item of db.prepare("SELECT id FROM private_challenges WHERE ((inviter_id = ? AND invitee_id = ?) OR (inviter_id = ? AND invitee_id = ?)) AND status IN ('pending','active')").all(actorId, counterpartId, counterpartId, actorId)) terminal(item.id)
      return { status: 204 }
    }
    if (row.accepted_at === null) notFound()
    if (method === 'DELETE' && (!action || action === 'consent')) {
      fields(body, ['baseVersion'])
      expected(row, body.baseVersion)
      terminal(id)
      return { status: 200, body: { challenge: view(byId(id), actorId) } }
    }
    if (method === 'PUT' && action === 'consent') {
      fields(body, ['baseVersion', 'policyVersion', 'metric', 'startDate', 'endDate', 'shareTrainingDays', 'recipient'])
      fields(body.recipient, ['id', 'email'])
      expected(row, body.baseVersion)
      const counterpart = user(row.inviter_id === actorId ? row.invitee_id : row.inviter_id)
      if (body.policyVersion !== CHALLENGE_POLICY_VERSION || body.metric !== CHALLENGE_METRIC || body.startDate !== row.start_date || body.endDate !== row.end_date || body.shareTrainingDays !== true || body.recipient.id !== counterpart?.id || body.recipient.email !== counterpart?.email) fail(400, 'invalid_consent', 'Review the exact recipient, dates, metric and current challenge policy before granting.')
      if (row.status !== 'active' || !currentCloudConsent(actor) || !counterpart?.verified || blocked(row.inviter_id, row.invitee_id)) unavailable()
      canAdvance(row)
      const role = row.inviter_id === actorId ? 'inviter' : 'invitee'
      db.prepare(`UPDATE private_challenges SET ${role}_consent = 1, ${role}_policy = ?, ${role}_consent_at = ?, version = version + 1 WHERE id = ?`).run(CHALLENGE_POLICY_VERSION, now(), id)
      return { status: 200, body: { challenge: view(byId(id), actorId) } }
    }
    if (method === 'GET' && action === 'counts') {
      fields(body, [])
      if (row.status !== 'active' || !consentColumns(row) || !currentCloudConsent(user(row.inviter_id)) || !currentCloudConsent(user(row.invitee_id)) || blocked(row.inviter_id, row.invitee_id)) unavailable()
      const count = userId => {
        // Never access the snapshot until every current grant and account check passes.
        const snapshot = db.prepare('SELECT state_json FROM users WHERE id = ?').get(userId)
        return snapshot?.state_json ? recordedTrainingDays(validateState(JSON.parse(snapshot.state_json)), row.start_date, row.end_date, now()) : null
      }
      return { status: 200, body: { challengeId: row.id, challengeVersion: row.version, metric: CHALLENGE_METRIC, selfReported: true,
        ownRecordedDays: count(actorId), peerRecordedDays: count(row.inviter_id === actorId ? row.invitee_id : row.inviter_id) } }
    }
    notFound()
  }
  const handle = (method, path, body, actorId) => {
    rateLimit(db, `challenges:${actorId}`, 90, 60000, now())
    if (method === 'POST' && path === '/challenges/invitations') rateLimit(db, `challenge-invite:${actorId}`, 10, DAY, now())
    // All permission checks, score reads and state changes share a synchronous write
    // transaction; no awaits, provider calls or snapshot upload occur inside this API.
    return transaction(db, () => route(method, path, body, actorId))
  }
  handle.exportAccount = actorId => transaction(db, () => {
    expire()
    // Own accepted metadata only; never expose pending send outcomes, peer identities,
    // peer consent, scores, snapshots or revisions through this export route.
    return { policyVersion: CHALLENGE_POLICY_VERSION, metric: CHALLENGE_METRIC, challenges: acceptedRows(actorId).map(row => metadata(row, actorId)) }
  })
  return handle
}
