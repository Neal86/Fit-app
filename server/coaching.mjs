import { randomUUID } from 'node:crypto'
import { POLICY_VERSION } from './config.mjs'
import { rateLimit, transaction } from './database.mjs'
import { fail, fields } from './errors.mjs'
import { canonical, digest, normalizeEmail, safeEqual } from './security.mjs'
import { validateState } from './state.mjs'

export const COACHING_POLICY_VERSION = '2026-10-15'
export const INVITATION_TTL_MS = 7 * 86400000
export const COACHING_LIMITS = Object.freeze({ relationshipsPerAccount: 50, pendingInvitationsPerRecipient: 50, relationshipsTotal: 10000, feedbackPerRelationship: 100, feedbackCharacters: 2000, feedbackBytes: 4000 })
const SCOPES = ['training', 'body', 'nutrition']
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const iso = value => value === null ? null : new Date(value).toISOString()
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const scopesFor = row => SCOPES.filter(scope => !!row[scope])
const person = row => ({ id: row.id, email: row.email })
const feedbackView = row => ({ id: row.id, text: row.text, format: 'plain_text', createdAt: iso(row.created_at) })
const unavailable = () => fail(403, 'sharing_unavailable', 'Current permission to share this data is unavailable.')
const notFound = () => fail(404, 'not_found', 'This collaboration item is unavailable.')

// Positive, nested allowlists intentionally do not follow future AppState schema additions.
// Never return the full state or profile, even when every category is selected.
function workoutView(workout) {
  return { ...pick(workout, ['id', 'title', 'day', 'duration', 'calories', 'difficulty', 'description']), exercises: workout.exercises.map(exercise => pick(exercise, ['id', 'name', 'sets', 'reps', 'restSeconds', 'category', 'notes'])) }
}
function logView(log) {
  return {
    ...pick(log, ['id', 'workoutId', 'title', 'startedAt', 'completedAt', 'duration', 'durationSeconds', 'calories', 'completedExerciseIds', 'notes']),
    ...(log.sets ? { sets: log.sets.map(set => pick(set, ['id', 'exerciseId', 'setNumber', 'reps', 'weightKg', 'seconds', 'rpe', 'warmup', 'completed'])) } : {}),
    ...(log.exerciseSnapshots ? { exerciseSnapshots: log.exerciseSnapshots.map(exercise => pick(exercise, ['id', 'name', 'category'])) } : {}),
  }
}
export function projectSnapshot(state, scopes) {
  const categories = {}
  if (scopes.includes('training')) categories.training = {
    workouts: state.workouts.map(workoutView), logs: state.logs.map(logView),
    planHistory: state.planHistory.map(plan => ({ ...pick(plan, ['id', 'savedAt', 'label']), workouts: plan.workouts.map(workoutView) })),
  }
  if (scopes.includes('body')) categories.body = {
    measurements: pick(state.profile, ['weightKg', 'heightCm']),
    weightHistory: state.weightHistory.map(entry => pick(entry, ['id', 'date', 'weightKg'])),
  }
  if (scopes.includes('nutrition')) categories.nutrition = {
    version: 1,
    meals: state.nutrition.meals.map(entry => pick(entry, ['id', 'date', 'mealType', 'foodName', 'serving', 'calories', 'protein', 'carbs', 'fat'])),
    hydration: state.nutrition.hydration.map(entry => pick(entry, ['id', 'date', 'milliliters', 'note'])),
    targets: state.nutrition.targets.map(entry => pick(entry, ['date', 'calories', 'protein', 'carbs', 'fat', 'milliliters'])),
  }
  return categories
}

export function revokeAthleteCoachingConsent(db, athleteId, now) {
  // Called inside the same transaction that deletes the cloud snapshot. A later opt-in
  // cannot resurrect any grant or make an in-flight stale consent/feedback mutation valid.
  db.prepare(`UPDATE coaching_relationships SET training = 0, body = 0, nutrition = 0,
    consent_policy = NULL, consent_at = ?, version = MIN(version + 1, 9007199254740991)
    WHERE athlete_id = ? AND status = 'active'`).run(now, athleteId)
}

export function createCoaching({ db, now }) {
  const user = id => db.prepare('SELECT id,email,verified,consent,consent_policy FROM users WHERE id = ?').get(id)
  const rowById = id => db.prepare('SELECT * FROM coaching_relationships WHERE id = ?').get(id)
  function relationshipView(row, actorId) {
    const athlete = row.athlete_id === actorId
    return {
      id: row.id, role: athlete ? 'athlete' : 'coach', counterpart: person(user(athlete ? row.coach_id : row.athlete_id)),
      status: row.status, version: row.version, scopes: scopesFor(row), policyVersion: row.consent_policy,
      consentUpdatedAt: iso(row.consent_at), createdAt: iso(row.created_at), acceptedAt: iso(row.accepted_at), revokedAt: iso(row.revoked_at),
    }
  }
  function owned(id, actorId, role) {
    if (!UUID.test(id)) notFound()
    const row = rowById(id)
    if (!row || (role === 'athlete' ? row.athlete_id !== actorId : role === 'coach' ? row.coach_id !== actorId : row.athlete_id !== actorId && row.coach_id !== actorId)) notFound()
    return row
  }
  function expected(row, version) {
    if (!Number.isSafeInteger(version) || version < 1) fail(400, 'invalid_request', 'A positive relationship base version is required.')
    if (version !== row.version) fail(409, 'coaching_conflict', 'The relationship changed. Refresh it before trying again.', { version: row.version })
  }
  function sharingAthlete(row, training = false) {
    const athlete = user(row.athlete_id), coach = user(row.coach_id)
    if (row.status !== 'active' || !athlete?.verified || !coach?.verified || !athlete.consent || athlete.consent_policy !== POLICY_VERSION || row.consent_policy !== COACHING_POLICY_VERSION || !scopesFor(row).length || training && !row.training) return null
    return athlete
  }
  const requireSharing = (row, training = false) => sharingAthlete(row, training) || unavailable()
  function expire() {
    db.prepare("UPDATE coaching_relationships SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(now())
  }
  function relationshipCapacity(id) {
    // Outgoing attempts cost equally regardless of recipient eligibility. Incoming capacity
    // is charged only for deliberately accepted relationships, never unsolicited invites.
    // A recipient must not be permanently locked out by other people's unsolicited invites.
    const outgoing = db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(id)?.attempts || 0
    const accepted = db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships WHERE coach_id = ? AND accepted_at IS NOT NULL').get(id).count
    return outgoing + accepted < COACHING_LIMITS.relationshipsPerAccount
  }
  function reserveInvitationBudget(actorId) {
    const global = db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get()
    if (!relationshipCapacity(actorId) || !global || global.attempts >= COACHING_LIMITS.relationshipsTotal) return false
    // This reservation and any eligible row insert share one immediate transaction.
    // No target identity is stored. Never refund on cancellation, expiry or deletion:
    // capacity observed through a controlled inbox must not reveal target eligibility.
    db.prepare('UPDATE coaching_global_budget SET attempts = attempts + 1 WHERE id = 1').run()
    db.prepare('INSERT INTO coaching_invitation_budgets(athlete_id,attempts) VALUES(?,1) ON CONFLICT(athlete_id) DO UPDATE SET attempts = attempts + 1').run(actorId)
    return true
  }
  const pendingCapacity = id => db.prepare("SELECT COUNT(*) AS count FROM coaching_relationships WHERE coach_id = ? AND status = 'pending'").get(id).count < COACHING_LIMITS.pendingInvitationsPerRecipient
  function overview(actorId) {
    const invitations = db.prepare("SELECT * FROM coaching_relationships WHERE coach_id = ? AND status = 'pending' ORDER BY created_at,id").all(actorId)
      .filter(row => user(row.athlete_id)?.verified)
      .map(row => ({ id: row.id, athlete: person(user(row.athlete_id)), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }))
    const relationships = db.prepare("SELECT * FROM coaching_relationships WHERE (athlete_id = ? OR coach_id = ?) AND status IN ('active','revoked') ORDER BY created_at,id").all(actorId, actorId).map(row => relationshipView(row, actorId))
    return { policyVersion: COACHING_POLICY_VERSION, coachQualificationsVerified: false, invitations, relationships }
  }
  function feedbackText(text) {
    // These literal control ranges intentionally reject unsafe text, rather than match content to execute.
    // eslint-disable-next-line no-control-regex
    if (typeof text !== 'string' || !text.trim() || text.length > COACHING_LIMITS.feedbackCharacters || Buffer.byteLength(text) > COACHING_LIMITS.feedbackBytes || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text) || /\b(?:https?|ftp|file|data|javascript|mailto|tel):|www\.|\[[^\]]*\]\s*\(/i.test(text)) fail(400, 'invalid_feedback', 'Use bounded plain training text without HTML, links, or control characters.')
    return text
  }
  function route(method, path, body, actorId) {
    // One immediate transaction serializes every permission check with mutation/revocation,
    // including reads. No await, mail, provider call, or client callback occurs inside it.
    const actor = user(actorId)
    if (!actor?.verified) fail(403, 'email_unverified', 'A verified account is required for collaboration.')
    expire()
    if (method === 'GET' && path === '/coaching') {
      fields(body, [])
      return { status: 200, body: overview(actorId) }
    }
    if (method === 'POST' && ['/coaching/invitations', '/coaching/invitations/cancel'].includes(path)) {
      fields(body, ['email'])
      const email = normalizeEmail(body.email)
      if (!path.endsWith('/cancel') && !reserveInvitationBudget(actorId)) return { status: 202, body: { status: 'accepted' } }
      const recipient = db.prepare('SELECT id,verified FROM users WHERE email = ?').get(email)
      if (path.endsWith('/cancel')) {
        if (recipient) db.prepare("UPDATE coaching_relationships SET status = 'cancelled' WHERE athlete_id = ? AND coach_id = ? AND status = 'pending'").run(actorId, recipient.id)
      } else if (recipient?.verified && recipient.id !== actorId && relationshipCapacity(recipient.id) && pendingCapacity(recipient.id)) {
        const exists = db.prepare("SELECT id FROM coaching_relationships WHERE athlete_id = ? AND coach_id = ? AND status IN ('pending','active')").get(actorId, recipient.id)
        if (!exists) db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)").run(randomUUID(), actorId, recipient.id, now(), now() + INVITATION_TTL_MS)
      }
      // No outgoing pending view, recipient lookup result, receipt ID, or mail side effect.
      return { status: 202, body: { status: 'accepted' } }
    }
    const invite = /^\/coaching\/invitations\/([^/]+)(\/accept)?$/.exec(path)
    if (invite && (method === 'POST' && invite[2] || method === 'DELETE' && !invite[2])) {
      fields(body, [])
      const row = owned(invite[1], actorId, 'coach')
      if (method === 'DELETE') {
        if (!['pending', 'declined'].includes(row.status)) notFound()
        db.prepare("UPDATE coaching_relationships SET status = 'declined' WHERE id = ?").run(row.id)
        return { status: 204 }
      }
      if (!['pending', 'active'].includes(row.status) || !user(row.athlete_id)?.verified) notFound()
      if (row.status === 'pending') {
        if (!relationshipCapacity(actorId)) fail(409, 'relationship_limit', 'Your accepted collaboration capacity has been reached.')
        db.prepare("UPDATE coaching_relationships SET status = 'active', accepted_at = ? WHERE id = ?").run(now(), row.id)
      }
      return { status: 200, body: { relationship: relationshipView(rowById(row.id), actorId) } }
    }
    const match = /^\/coaching\/relationships\/([^/]+)(?:\/(consent|snapshot|feedback)(?:\/([^/]+))?)?$/.exec(path)
    if (!match) notFound()
    const [, id, action, feedbackId] = match
    const row = owned(id, actorId)
    if (!['active', 'revoked'].includes(row.status)) notFound()
    if (method === 'DELETE' && !action) {
      fields(body, ['baseVersion'])
      expected(row, body.baseVersion)
      if (row.status !== 'revoked') db.prepare("UPDATE coaching_relationships SET status = 'revoked', training = 0, body = 0, nutrition = 0, consent_policy = NULL, consent_at = ?, revoked_at = ?, version = MIN(version + 1, 9007199254740991) WHERE id = ?").run(now(), now(), id)
      return { status: 200, body: { relationship: relationshipView(rowById(id), actorId) } }
    }
    if (method === 'PUT' && action === 'consent' && !feedbackId) {
      fields(body, ['baseVersion', 'policyVersion', 'scopes'])
      if (row.athlete_id !== actorId) notFound()
      expected(row, body.baseVersion)
      if (row.status !== 'active') unavailable()
      if (body.policyVersion !== COACHING_POLICY_VERSION || !Array.isArray(body.scopes) || body.scopes.length > 3 || body.scopes.some(scope => !SCOPES.includes(scope)) || new Set(body.scopes).size !== body.scopes.length) fail(400, 'invalid_consent', 'Choose explicit categories and the current collaboration policy version.')
      if (body.scopes.length && (!actor.consent || actor.consent_policy !== POLICY_VERSION || !user(row.coach_id)?.verified)) unavailable()
      if (row.version >= Number.MAX_SAFE_INTEGER - 1) fail(409, 'revision_limit', 'The relationship version limit has been reached. Revoke this relationship.')
      db.prepare('UPDATE coaching_relationships SET training = ?, body = ?, nutrition = ?, consent_policy = ?, consent_at = ?, version = version + 1 WHERE id = ?').run(...SCOPES.map(scope => Number(body.scopes.includes(scope))), COACHING_POLICY_VERSION, now(), id)
      return { status: 200, body: { relationship: relationshipView(rowById(id), actorId) } }
    }
    if (method === 'GET' && action === 'snapshot' && !feedbackId) {
      fields(body, [])
      if (row.coach_id !== actorId) notFound()
      const athlete = requireSharing(row)
      // Load health data only after the full access check, never for identity/list/export views.
      const snapshot = db.prepare('SELECT state_json,state_at,revision FROM users WHERE id = ?').get(athlete.id)
      if (!snapshot.state_json) fail(404, 'snapshot_unavailable', 'No saved cloud snapshot is available.')
      const state = validateState(JSON.parse(snapshot.state_json))
      return { status: 200, body: { relationshipId: id, relationshipVersion: row.version, revision: snapshot.revision, updatedAt: iso(snapshot.state_at), categories: projectSnapshot(state, scopesFor(row)) } }
    }
    if (action === 'feedback') {
      if (method === 'GET' && !feedbackId) {
        fields(body, [])
        if (row.coach_id === actorId) requireSharing(row, true)
        const feedback = db.prepare('SELECT * FROM coaching_feedback WHERE relationship_id = ? AND removed_at IS NULL ORDER BY created_at,id').all(id).map(feedbackView)
        return { status: 200, body: { relationshipId: id, relationshipVersion: row.version, feedback } }
      }
      if (method === 'POST' && !feedbackId) {
        fields(body, ['baseVersion', 'operationId', 'text'])
        if (row.coach_id !== actorId) notFound()
        requireSharing(row, true)
        expected(row, body.baseVersion)
        if (typeof body.operationId !== 'string' || !UUID.test(body.operationId)) fail(400, 'invalid_request', 'A UUID operation ID is required.')
        const text = feedbackText(body.text), requestHash = digest(canonical(body))
        const prior = db.prepare('SELECT * FROM coaching_feedback WHERE relationship_id = ? AND operation_id = ?').get(id, body.operationId)
        if (prior) {
          if (!safeEqual(prior.request_hash, requestHash)) fail(409, 'idempotency_conflict', 'This operation ID was already used for a different request.')
          if (prior.removed_at !== null) fail(409, 'feedback_removed', 'This feedback was removed and cannot be restored by retrying.')
          return { status: 200, body: { relationshipVersion: row.version, feedback: feedbackView(prior), replayed: true } }
        }
        if (db.prepare('SELECT COUNT(*) AS count FROM coaching_feedback WHERE relationship_id = ?').get(id).count >= COACHING_LIMITS.feedbackPerRelationship) fail(409, 'feedback_limit', 'This relationship has reached its feedback limit.')
        const feedback = { id: randomUUID(), text, created_at: now() }
        db.prepare('INSERT INTO coaching_feedback(id,relationship_id,operation_id,request_hash,text,created_at) VALUES(?,?,?,?,?,?)').run(feedback.id, id, body.operationId, requestHash, text, feedback.created_at)
        return { status: 201, body: { relationshipVersion: row.version, feedback: feedbackView(feedback), replayed: false } }
      }
      if (method === 'DELETE' && feedbackId) {
        fields(body, ['baseVersion'])
        if (row.athlete_id !== actorId || !UUID.test(feedbackId)) notFound()
        expected(row, body.baseVersion)
        const item = db.prepare('SELECT id FROM coaching_feedback WHERE id = ? AND relationship_id = ?').get(feedbackId, id)
        if (!item) notFound()
        db.prepare('UPDATE coaching_feedback SET text = NULL, removed_at = COALESCE(removed_at, ?) WHERE id = ?').run(now(), feedbackId)
        return { status: 204 }
      }
    }
    notFound()
  }
  const handle = (method, path, body, actorId) => {
    // Persist abuse counters outside the permission transaction, including rejected requests.
    rateLimit(db, `coaching:${actorId}`, 90, 60000, now())
    if (method === 'POST' && path === '/coaching/invitations') rateLimit(db, `coaching-invite:${actorId}`, 10, 86400000, now())
    if (method === 'POST' && path.endsWith('/feedback')) rateLimit(db, `coaching-feedback:${actorId}`, 20, 3600000, now())
    return transaction(db, () => route(method, path, body, actorId))
  }
  // Account export remains available when coaching is disabled. It never includes another
  // athlete's snapshot or gives a coach a revocation bypass for previously authored feedback.
  handle.exportAccount = actorId => transaction(db, () => {
    expire()
    const result = overview(actorId)
    return { ...result, feedback: result.relationships.flatMap(relationship => {
      const row = rowById(relationship.id)
      if (row.athlete_id !== actorId && !sharingAthlete(row, true)) return []
      return [{ relationshipId: row.id, items: db.prepare('SELECT * FROM coaching_feedback WHERE relationship_id = ? AND removed_at IS NULL ORDER BY created_at,id').all(row.id).map(feedbackView) }]
    }) }
  })
  return handle
}
