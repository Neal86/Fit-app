import { CloudClient, CloudError } from './cloud'
import { parseState } from './stateValidation'
import { parseNutritionState, type NutritionState } from './nutrition'
import type { PlanRevision, WeightEntry, Workout, WorkoutLog } from './types'

export const COACHING_POLICY = '2026-10-15'
export const COACHING_SCOPES = ['training', 'body', 'nutrition'] as const
export type CoachingScope = typeof COACHING_SCOPES[number]
export const SCOPE_LABELS: Record<CoachingScope, string> = {
  training: 'Training plans, saved plan versions, workout history and private workout/exercise notes',
  body: 'Body measurements (height and weight) and weight diary',
  nutrition: 'Food and water entries, notes and manually entered nutrition targets',
}
export type CoachingIdentity = { id: string; email: string }
export type CoachingInvitation = { id: string; athlete: CoachingIdentity; createdAt: string; expiresAt: string }
export type CoachingRelationship = {
  id: string; role: 'athlete' | 'coach'; counterpart: CoachingIdentity; status: 'active' | 'revoked'; version: number;
  scopes: CoachingScope[]; policyVersion: typeof COACHING_POLICY | null; consentUpdatedAt: string | null;
  createdAt: string; acceptedAt: string; revokedAt: string | null;
}
export type CoachingOverview = { policyVersion: typeof COACHING_POLICY; coachQualificationsVerified: false; invitations: CoachingInvitation[]; relationships: CoachingRelationship[] }
export type CoachingSnapshot = {
  relationshipId: string; relationshipVersion: number; revision: number; updatedAt: string;
  categories: {
    training?: { workouts: Workout[]; logs: WorkoutLog[]; planHistory: PlanRevision[] };
    body?: { measurements: { weightKg: number; heightCm: number }; weightHistory: WeightEntry[] };
    nutrition?: NutritionState;
  };
}
export type CoachingFeedback = { id: string; text: string; format: 'plain_text'; createdAt: string }
export type CoachingFeedbackList = { relationshipId: string; relationshipVersion: number; feedback: CoachingFeedback[] }
export type CoachingAccountExport = CoachingOverview & { feedback: { relationshipId: string; items: CoachingFeedback[] }[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const list = (value: unknown, max = 500): value is unknown[] => Array.isArray(value) && value.length <= max
const invalid = () => new CloudError('invalid_response', 'Collaboration data could not be validated. Refresh and review before trying again.')
const conflict = () => new CloudError('coaching_conflict', 'Collaboration access changed. Refresh and review the recipient and categories again.', 409)
function confirm(confirmed: boolean) { if (!confirmed) throw new CloudError('confirmation_required', 'Review and confirm this collaboration action first.') }
export function coachingEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CloudError('invalid_email', 'Enter the known account email of the person you intend to contact.')
  return email
}
function identity(value: unknown): CoachingIdentity {
  if (!exact(value, ['id', 'email']) || !id(value.id) || typeof value.email !== 'string') throw invalid()
  try { if (coachingEmail(value.email) !== value.email) throw invalid() } catch { throw invalid() }
  return { id: value.id, email: value.email }
}
function scopes(value: unknown): CoachingScope[] {
  if (!list(value, 3) || value.some(scope => !COACHING_SCOPES.includes(scope as CoachingScope)) || new Set(value).size !== value.length) throw invalid()
  return [...value] as CoachingScope[]
}
export function readRelationship(value: unknown): CoachingRelationship {
  if (!exact(value, ['id', 'role', 'counterpart', 'status', 'version', 'scopes', 'policyVersion', 'consentUpdatedAt', 'createdAt', 'acceptedAt', 'revokedAt']) || !id(value.id) || !['athlete', 'coach'].includes(value.role as string) || !['active', 'revoked'].includes(value.status as string) || !version(value.version) || !(value.policyVersion === null || value.policyVersion === COACHING_POLICY) || !(value.consentUpdatedAt === null || date(value.consentUpdatedAt)) || !date(value.createdAt) || !date(value.acceptedAt) || !(value.revokedAt === null || date(value.revokedAt))) throw invalid()
  const granted = scopes(value.scopes)
  if (value.status === 'revoked' && (granted.length || value.revokedAt === null) || value.status === 'active' && value.revokedAt !== null || granted.length && (value.policyVersion !== COACHING_POLICY || !value.consentUpdatedAt)) throw invalid()
  return { ...value, counterpart: identity(value.counterpart), scopes: granted } as CoachingRelationship
}
export function readOverview(value: unknown, selfId: string): CoachingOverview {
  if (!exact(value, ['policyVersion', 'coachQualificationsVerified', 'invitations', 'relationships']) || value.policyVersion !== COACHING_POLICY || value.coachQualificationsVerified !== false || !list(value.invitations, 50) || !list(value.relationships, 50)) throw invalid()
  const invitations = value.invitations.map(entry => {
    if (!exact(entry, ['id', 'athlete', 'createdAt', 'expiresAt']) || !id(entry.id) || !date(entry.createdAt) || !date(entry.expiresAt) || Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt)) throw invalid()
    return { id: entry.id, athlete: identity(entry.athlete), createdAt: entry.createdAt, expiresAt: entry.expiresAt }
  })
  const relationships = value.relationships.map(readRelationship)
  if (new Set(invitations.map(entry => entry.id)).size !== invitations.length || new Set(relationships.map(entry => entry.id)).size !== relationships.length || invitations.some(entry => entry.athlete.id === selfId) || relationships.some(entry => entry.counterpart.id === selfId)) throw invalid()
  return { policyVersion: COACHING_POLICY, coachQualificationsVerified: false, invitations, relationships }
}
function requireRelationship(relationship: CoachingRelationship, role?: 'athlete' | 'coach', active = true) {
  readRelationship(relationship)
  if (role && relationship.role !== role || active && relationship.status !== 'active') throw conflict()
}
function matching(value: Record<string, unknown>, relationship: CoachingRelationship) {
  if (value.relationshipId !== relationship.id || value.relationshipVersion !== relationship.version) throw conflict()
}
// Validate category fragments with the same validators used for saved cloud data, using
// static synthetic defaults for unrelated fields. Never read the current device dataset.
const validationBase = () => ({
  version: 4, profile: { name: 'Validation', goal: 'Stay active', level: 'Beginner', weeklyTarget: 1, weightKg: 70, heightCm: 170, birthYear: 2000, unit: 'metric', onboardingComplete: false },
  preferences: { reducedMotion: false, soundEnabled: false, remindersEnabled: false },
  workouts: [{ id: 'validation', title: 'Validation', day: 'Monday', duration: 1, calories: 0, difficulty: 'Beginner', description: '', exercises: [{ id: 'validation', name: 'Validation', sets: 1, reps: '1', restSeconds: 0, category: '' }] }],
  logs: [], weightHistory: [], activeSession: null, planHistory: [], nutrition: { version: 1, meals: [], hydration: [], targets: [] },
})
export function readCoachingSnapshot(value: unknown, relationship: CoachingRelationship): CoachingSnapshot {
  requireRelationship(relationship, 'coach')
  if (!exact(value, ['relationshipId', 'relationshipVersion', 'revision', 'updatedAt', 'categories']) || !version(value.revision) || !date(value.updatedAt) || !object(value.categories) || !relationship.scopes.length) throw invalid()
  matching(value, relationship)
  if (!exact(value.categories, [...relationship.scopes])) throw invalid()
  const categories: CoachingSnapshot['categories'] = {}
  try {
    if (Object.hasOwn(value.categories, 'training')) {
      const training = value.categories.training
      if (!exact(training, ['workouts', 'logs', 'planHistory'])) throw invalid()
      const parsed = parseState({ ...validationBase(), ...training })
      // The saved-state schema is broader than the separately consented coach projection.
      // Equipment and planned/executed grouping stay in private copies, never coach responses.
      if ([...parsed.workouts, ...parsed.planHistory.flatMap(revision => revision.workouts)].some(workout => Object.hasOwn(workout, 'plannedGrouping') || workout.exercises.some(exercise => Object.hasOwn(exercise, 'equipment'))) || parsed.logs.some(log => Object.hasOwn(log, 'grouping'))) throw invalid()
      categories.training = { workouts: parsed.workouts, logs: parsed.logs, planHistory: parsed.planHistory }
    }
    if (Object.hasOwn(value.categories, 'body')) {
      const body = value.categories.body
      if (!exact(body, ['measurements', 'weightHistory']) || !exact(body.measurements, ['weightKg', 'heightCm'])) throw invalid()
      const base = validationBase()
      const parsed = parseState({ ...base, profile: { ...base.profile, ...body.measurements }, weightHistory: body.weightHistory })
      categories.body = { measurements: { weightKg: parsed.profile.weightKg, heightCm: parsed.profile.heightCm }, weightHistory: parsed.weightHistory }
    }
    if (Object.hasOwn(value.categories, 'nutrition')) categories.nutrition = parseNutritionState(value.categories.nutrition)
  } catch { throw invalid() }
  return { relationshipId: relationship.id, relationshipVersion: relationship.version, revision: value.revision, updatedAt: value.updatedAt, categories }
}
export function coachingFeedbackText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 2000 || new TextEncoder().encode(trimmed).length > 4000 || /[<>]|\b(?:https?|ftp|file|data|javascript|mailto|tel):|www\.|\[[^\]]*\]\s*\(/i.test(trimmed) || [...trimmed].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 })) throw new CloudError('invalid_feedback', 'Use plain text only, up to 2,000 characters and 4,000 bytes, with no HTML or links.')
  return trimmed
}
function readFeedback(value: unknown): CoachingFeedback {
  if (!exact(value, ['id', 'text', 'format', 'createdAt']) || !id(value.id) || typeof value.text !== 'string' || value.format !== 'plain_text' || !date(value.createdAt)) throw invalid()
  // Never interpret text as HTML/Markdown. Validate bounds even if another server version sends markup.
  if (!value.text.trim() || value.text.length > 2000 || new TextEncoder().encode(value.text).length > 4000) throw invalid()
  return { id: value.id, text: value.text, format: 'plain_text', createdAt: value.createdAt }
}

/** Account exports include only authorized collaboration metadata/feedback, never counterpart snapshots. */
export function readCoachingAccountExport(value: unknown, selfId: string): CoachingAccountExport {
  if (!exact(value, ['policyVersion', 'coachQualificationsVerified', 'invitations', 'relationships', 'feedback']) || !list(value.feedback, 50)) throw invalid()
  const overview = readOverview({ policyVersion: value.policyVersion, coachQualificationsVerified: value.coachQualificationsVerified, invitations: value.invitations, relationships: value.relationships }, selfId)
  if (overview.relationships.length > 50) throw invalid()
  const feedback = value.feedback.map(group => {
    if (!exact(group, ['relationshipId', 'items']) || !id(group.relationshipId) || !list(group.items, 100)) throw invalid()
    const relationship = overview.relationships.find(entry => entry.id === group.relationshipId)
    if (!relationship || relationship.role === 'coach' && (relationship.status !== 'active' || !relationship.scopes.includes('training'))) throw invalid()
    const items = group.items.map(readFeedback)
    if (new Set(items.map(item => item.id)).size !== items.length) throw invalid()
    return { relationshipId: group.relationshipId, items }
  })
  if (new Set(feedback.map(group => group.relationshipId)).size !== feedback.length) throw invalid()
  return { ...overview, feedback }
}

/** Stateless collaboration adapter; health records live only in the mounted view. */
export class CoachingClient {
  constructor(private cloud: CloudClient) {}
  private assertSession(generation: number): void {
    if (generation !== this.cloud.sessionRevision) throw new CloudError('cancelled', 'This collaboration action was cancelled.')
    const session = this.cloud.session
    if (!session || Date.parse(session.sessionExpiresAt) <= Date.now()) {
      this.cloud.clear()
      throw new CloudError('session_expired', 'Sign in before accessing collaboration data.')
    }
  }
  async overview(): Promise<CoachingOverview> {
    const selfId = this.cloud.session?.user.id
    if (!selfId) throw new CloudError('session_expired', 'Sign in before checking collaboration.')
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest('coaching')
    this.assertSession(generation)
    return readOverview(value, selfId)
  }
  private async accepted(path: string, email: string, confirmed: boolean): Promise<void> {
    confirm(confirmed)
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(path, 'POST', { email: coachingEmail(email) }, 202)
    this.assertSession(generation)
    if (!exact(value, ['status']) || value.status !== 'accepted') throw invalid()
  }
  invite(email: string, confirmed: boolean) { return this.accepted('coaching/invitations', email, confirmed) }
  cancelInvite(email: string, confirmed: boolean) { return this.accepted('coaching/invitations/cancel', email, confirmed) }
  async accept(invitation: CoachingInvitation, confirmed: boolean): Promise<CoachingRelationship> {
    confirm(confirmed); if (!id(invitation.id)) throw invalid()
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/invitations/${invitation.id}/accept`, 'POST', {})
    this.assertSession(generation)
    if (!exact(value, ['relationship'])) throw invalid()
    const relationship = readRelationship(value.relationship)
    if (relationship.role !== 'coach' || relationship.counterpart.id !== invitation.athlete.id || relationship.counterpart.email !== invitation.athlete.email || relationship.status !== 'active') throw invalid()
    return relationship
  }
  async decline(invitation: CoachingInvitation, confirmed: boolean): Promise<void> {
    confirm(confirmed); if (!id(invitation.id)) throw invalid()
    const generation = this.cloud.sessionRevision
    await this.cloud.coachingRequest(`coaching/invitations/${invitation.id}`, 'DELETE', {}, 204)
    this.assertSession(generation)
  }
  async consent(relationship: CoachingRelationship, selected: CoachingScope[], confirmed: boolean): Promise<CoachingRelationship> {
    confirm(confirmed); requireRelationship(relationship, 'athlete')
    const requested = scopes(selected)
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}/consent`, 'PUT', { baseVersion: relationship.version, policyVersion: COACHING_POLICY, scopes: requested })
    this.assertSession(generation)
    const result = this.changedRelationship(value, relationship)
    if (result.status !== 'active' || result.scopes.length !== requested.length || requested.some(scope => !result.scopes.includes(scope))) throw invalid()
    return result
  }
  private changedRelationship(value: unknown, previous: CoachingRelationship): CoachingRelationship {
    if (!exact(value, ['relationship'])) throw invalid()
    const result = readRelationship(value.relationship)
    if (result.id !== previous.id || result.role !== previous.role || result.counterpart.id !== previous.counterpart.id || result.counterpart.email !== previous.counterpart.email || result.version <= previous.version) throw invalid()
    return result
  }
  async revoke(relationship: CoachingRelationship, confirmed: boolean): Promise<void> {
    confirm(confirmed); requireRelationship(relationship)
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}`, 'DELETE', { baseVersion: relationship.version })
    this.assertSession(generation)
    const result = this.changedRelationship(value, relationship)
    if (result.status !== 'revoked' || result.scopes.length) throw invalid()
  }
  async snapshot(relationship: CoachingRelationship): Promise<CoachingSnapshot> {
    requireRelationship(relationship, 'coach')
    if (!relationship.scopes.length) throw conflict()
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}/snapshot`)
    this.assertSession(generation)
    return readCoachingSnapshot(value, relationship)
  }
  async feedback(relationship: CoachingRelationship): Promise<CoachingFeedbackList> {
    requireRelationship(relationship, undefined, false)
    if (relationship.role === 'coach' && (relationship.status !== 'active' || !relationship.scopes.includes('training'))) throw conflict()
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}/feedback`)
    this.assertSession(generation)
    if (!exact(value, ['relationshipId', 'relationshipVersion', 'feedback']) || !list(value.feedback, 100)) throw invalid()
    matching(value, relationship)
    const feedback = value.feedback.map(readFeedback)
    if (new Set(feedback.map(entry => entry.id)).size !== feedback.length) throw invalid()
    return { relationshipId: relationship.id, relationshipVersion: relationship.version, feedback }
  }
  async sendFeedback(relationship: CoachingRelationship, text: string, confirmed: boolean): Promise<void> {
    confirm(confirmed); requireRelationship(relationship, 'coach')
    if (!relationship.scopes.includes('training')) throw conflict()
    if (!globalThis.crypto?.randomUUID) throw new CloudError('secure_context_required', 'Feedback requires a browser with secure UUID support.')
    const generation = this.cloud.sessionRevision
    const value = await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}/feedback`, 'POST', { baseVersion: relationship.version, operationId: crypto.randomUUID(), text: coachingFeedbackText(text) }, 201)
    this.assertSession(generation)
    if (!exact(value, ['relationshipVersion', 'feedback', 'replayed']) || value.relationshipVersion !== relationship.version || value.replayed !== false) throw invalid()
    if (readFeedback(value.feedback).text !== coachingFeedbackText(text)) throw invalid()
  }
  async removeFeedback(relationship: CoachingRelationship, feedback: CoachingFeedback, confirmed: boolean): Promise<void> {
    confirm(confirmed); requireRelationship(relationship, 'athlete', false)
    if (!id(feedback.id)) throw invalid()
    const generation = this.cloud.sessionRevision
    await this.cloud.coachingRequest(`coaching/relationships/${relationship.id}/feedback/${feedback.id}`, 'DELETE', { baseVersion: relationship.version }, 204)
    this.assertSession(generation)
  }
}
