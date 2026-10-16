import { CloudClient, CloudError } from './cloud'

export const CHALLENGE_POLICY = '2026-10-15'
export const CHALLENGE_METRIC = 'recorded_training_days'
export type ChallengeIdentity = { id: string; email: string }
export type ChallengeWindow = { startDate: string; endDate: string }
export type ChallengeInvitation = ChallengeWindow & { id: string; inviter: ChallengeIdentity; version: number; createdAt: string; expiresAt: string }
export type PrivateChallenge = ChallengeWindow & {
  id: string; role: 'inviter' | 'invitee'; counterpart: ChallengeIdentity; status: 'active' | 'revoked' | 'expired'; version: number;
  ownConsent: boolean; peerConsent: boolean; policyVersion: typeof CHALLENGE_POLICY;
  createdAt: string; acceptedAt: string; expiresAt: string; revokedAt: string | null;
}
export type ChallengeOverview = { policyVersion: typeof CHALLENGE_POLICY; metric: typeof CHALLENGE_METRIC; invitations: ChallengeInvitation[]; challenges: PrivateChallenge[] }
export type ChallengeCounts = { challengeId: string; challengeVersion: number; metric: typeof CHALLENGE_METRIC; selfReported: true; ownRecordedDays: number | null; peerRecordedDays: number | null }
export type ChallengeExportItem = Omit<PrivateChallenge, 'counterpart' | 'peerConsent' | 'policyVersion'>
export type ChallengeAccountExport = { policyVersion: typeof CHALLENGE_POLICY; metric: typeof CHALLENGE_METRIC; challenges: ChallengeExportItem[] }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
const list = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= 50
const invalid = () => new CloudError('invalid_response', 'Private challenge data could not be validated. Refresh and review before trying again.')
const conflict = () => new CloudError('challenge_conflict', 'Private challenge access changed. Refresh and review the person and UTC window again.', 409)
function confirm(confirmed: boolean) { if (confirmed !== true) throw new CloudError('confirmation_required', 'Review and confirm this private challenge action first.') }
export function challengeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CloudError('invalid_email', 'Enter the known account email of the person you intend to invite.')
  return email
}
function identity(value: unknown, selfId?: string): ChallengeIdentity {
  if (!exact(value, ['id', 'email']) || !id(value.id) || value.id === selfId || typeof value.email !== 'string') throw invalid()
  try { if (challengeEmail(value.email) !== value.email) throw invalid() } catch { throw invalid() }
  return { id: value.id, email: value.email }
}
export function challengeWindow(startDate: unknown, endDate: unknown): ChallengeWindow {
  if (!day(startDate) || !day(endDate)) throw new CloudError('invalid_window', 'Choose valid UTC start and end dates.')
  const days = (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000 + 1
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new CloudError('invalid_window', 'Choose an inclusive UTC window of 1 to 31 dates.')
  return { startDate, endDate }
}
export function challengeWindowDays(window: ChallengeWindow): number {
  challengeWindow(window.startDate, window.endDate)
  return (Date.parse(`${window.endDate}T00:00:00.000Z`) - Date.parse(`${window.startDate}T00:00:00.000Z`)) / 86_400_000 + 1
}
export function invitationWindow(startDate: string, endDate: string): ChallengeWindow {
  const window = challengeWindow(startDate, endDate)
  if (endDate > '9999-12-23') throw new CloudError('invalid_window', 'Choose a UTC end date no later than 9999-12-23.')
  if (endDate < new Date().toISOString().slice(0, 10)) throw new CloudError('invalid_window', 'The UTC end date cannot be in the past.')
  return window
}
function readWindow(value: Record<string, unknown>): ChallengeWindow {
  try { return challengeWindow(value.startDate, value.endDate) } catch { throw invalid() }
}
export function readChallengeInvitation(value: unknown, selfId?: string): ChallengeInvitation {
  if (!exact(value, ['id', 'inviter', 'startDate', 'endDate', 'version', 'createdAt', 'expiresAt']) || !id(value.id) || !version(value.version) || !timestamp(value.createdAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.createdAt) throw invalid()
  return { id: value.id, inviter: identity(value.inviter, selfId), ...readWindow(value), version: value.version, createdAt: value.createdAt, expiresAt: value.expiresAt }
}
const historicalKeys = ['id', 'role', 'startDate', 'endDate', 'status', 'version', 'ownConsent', 'createdAt', 'acceptedAt', 'expiresAt', 'revokedAt']
function readHistorical(value: Record<string, unknown>): ChallengeExportItem {
  if (!id(value.id) || !['inviter', 'invitee'].includes(value.role as string) || !['active', 'revoked', 'expired'].includes(value.status as string) || !version(value.version) || typeof value.ownConsent !== 'boolean' || !timestamp(value.createdAt) || !timestamp(value.acceptedAt) || !timestamp(value.expiresAt) || value.acceptedAt < value.createdAt || value.expiresAt <= value.acceptedAt || !(value.revokedAt === null || timestamp(value.revokedAt))) throw invalid()
  if (value.status === 'revoked' && (value.revokedAt === null || value.ownConsent) || value.status !== 'revoked' && value.revokedAt !== null || value.status === 'expired' && value.ownConsent) throw invalid()
  if (value.revokedAt !== null && (value.revokedAt as string) < value.acceptedAt) throw invalid()
  const window = readWindow(value)
  return { id: value.id, role: value.role, ...window, status: value.status, version: value.version, ownConsent: value.ownConsent, createdAt: value.createdAt, acceptedAt: value.acceptedAt, expiresAt: value.expiresAt, revokedAt: value.revokedAt } as ChallengeExportItem
}
export function readPrivateChallenge(value: unknown, selfId?: string): PrivateChallenge {
  if (!exact(value, [...historicalKeys, 'counterpart', 'peerConsent', 'policyVersion']) || typeof value.peerConsent !== 'boolean' || value.policyVersion !== CHALLENGE_POLICY) throw invalid()
  const historical = readHistorical(value)
  if (historical.status !== 'active' && value.peerConsent) throw invalid()
  return { ...historical, counterpart: identity(value.counterpart, selfId), peerConsent: value.peerConsent, policyVersion: CHALLENGE_POLICY }
}
export function readChallengeOverview(value: unknown, selfId: string): ChallengeOverview {
  if (!exact(value, ['policyVersion', 'metric', 'invitations', 'challenges']) || value.policyVersion !== CHALLENGE_POLICY || value.metric !== CHALLENGE_METRIC || !list(value.invitations) || !list(value.challenges)) throw invalid()
  const invitations = value.invitations.map(entry => readChallengeInvitation(entry, selfId))
  const challenges = value.challenges.map(entry => readPrivateChallenge(entry, selfId))
  const ids = [...invitations, ...challenges].map(entry => entry.id)
  if (new Set(ids).size !== ids.length) throw invalid()
  return { policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, invitations, challenges }
}
export function readChallengeAccountExport(value: unknown): ChallengeAccountExport {
  if (!exact(value, ['policyVersion', 'metric', 'challenges']) || value.policyVersion !== CHALLENGE_POLICY || value.metric !== CHALLENGE_METRIC || !list(value.challenges)) throw invalid()
  const challenges = value.challenges.map(entry => { if (!exact(entry, historicalKeys)) throw invalid(); return readHistorical(entry) })
  if (new Set(challenges.map(entry => entry.id)).size !== challenges.length) throw invalid()
  return { policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, challenges }
}
function active(challenge: PrivateChallenge) {
  if (challenge.status !== 'active' || Date.parse(challenge.expiresAt) <= Date.now()) throw conflict()
}
export function readChallengeCounts(value: unknown, challenge: PrivateChallenge): ChallengeCounts {
  readPrivateChallenge(challenge); active(challenge)
  if (!challenge.ownConsent || !challenge.peerConsent) throw conflict()
  if (!exact(value, ['challengeId', 'challengeVersion', 'metric', 'selfReported', 'ownRecordedDays', 'peerRecordedDays']) || value.metric !== CHALLENGE_METRIC || value.selfReported !== true) throw invalid()
  if (value.challengeId !== challenge.id || value.challengeVersion !== challenge.version) throw conflict()
  const limit = challengeWindowDays(challenge)
  for (const count of [value.ownRecordedDays, value.peerRecordedDays]) if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > limit)) throw invalid()
  return { challengeId: challenge.id, challengeVersion: challenge.version, metric: CHALLENGE_METRIC, selfReported: true, ownRecordedDays: value.ownRecordedDays as number | null, peerRecordedDays: value.peerRecordedDays as number | null }
}

/** Stateless adapter. Do not cache private data or pass the local device dataset here. */
export class PrivateChallengeClient {
  constructor(private cloud: CloudClient) {}
  private context(): { generation: number; selfId: string } {
    const session = this.cloud.session
    if (!session || Date.parse(session.sessionExpiresAt) <= Date.now()) { this.cloud.clear(); throw new CloudError('session_expired', 'Sign in before checking private challenges.') }
    return { generation: this.cloud.sessionRevision, selfId: session.user.id }
  }
  private assertSession(generation: number): void {
    if (generation !== this.cloud.sessionRevision) throw new CloudError('cancelled', 'This private challenge action was cancelled.')
    this.context()
  }
  async overview(): Promise<ChallengeOverview> {
    const { generation, selfId } = this.context()
    const value = await this.cloud.challengeRequest('challenges')
    this.assertSession(generation)
    return readChallengeOverview(value, selfId)
  }
  async invite(email: string, window: ChallengeWindow, confirmed: boolean): Promise<void> {
    confirm(confirmed)
    const { generation } = this.context()
    const dates = invitationWindow(window.startDate, window.endDate)
    const value = await this.cloud.challengeRequest('challenges/invitations', 'POST', { email: challengeEmail(email), ...dates }, 202)
    this.assertSession(generation)
    if (!exact(value, ['status']) || value.status !== 'accepted') throw invalid()
  }
  async accept(invitation: ChallengeInvitation, confirmed: boolean): Promise<PrivateChallenge> {
    confirm(confirmed)
    const { generation, selfId } = this.context()
    const reviewed = readChallengeInvitation(invitation, selfId)
    if (Date.parse(reviewed.expiresAt) <= Date.now()) throw conflict()
    const value = await this.cloud.challengeRequest(`challenges/invitations/${reviewed.id}/accept`, 'POST', { baseVersion: reviewed.version })
    this.assertSession(generation)
    if (!exact(value, ['challenge'])) throw invalid()
    const result = readPrivateChallenge(value.challenge, selfId)
    if (result.id !== reviewed.id || result.role !== 'invitee' || result.counterpart.id !== reviewed.inviter.id || result.counterpart.email !== reviewed.inviter.email || result.startDate !== reviewed.startDate || result.endDate !== reviewed.endDate || result.createdAt !== reviewed.createdAt || result.status !== 'active' || result.version <= reviewed.version || result.ownConsent || result.peerConsent) throw invalid()
    return result
  }
  async decline(invitation: ChallengeInvitation, confirmed: boolean): Promise<void> {
    confirm(confirmed)
    const { generation, selfId } = this.context()
    const reviewed = readChallengeInvitation(invitation, selfId)
    await this.cloud.challengeRequest(`challenges/invitations/${reviewed.id}`, 'DELETE', { baseVersion: reviewed.version }, 204)
    this.assertSession(generation)
  }
  private changed(value: unknown, previous: PrivateChallenge, selfId: string, allowEqual = false): PrivateChallenge {
    if (!exact(value, ['challenge'])) throw invalid()
    const result = readPrivateChallenge(value.challenge, selfId)
    if (result.id !== previous.id || result.role !== previous.role || result.counterpart.id !== previous.counterpart.id || result.counterpart.email !== previous.counterpart.email || result.startDate !== previous.startDate || result.endDate !== previous.endDate || result.createdAt !== previous.createdAt || result.acceptedAt !== previous.acceptedAt || result.expiresAt !== previous.expiresAt || result.version < previous.version || !allowEqual && result.version === previous.version) throw invalid()
    return result
  }
  async consent(challenge: PrivateChallenge, confirmed: boolean): Promise<PrivateChallenge> {
    confirm(confirmed)
    const { generation, selfId } = this.context()
    const reviewed = readPrivateChallenge(challenge, selfId); active(reviewed)
    const value = await this.cloud.challengeRequest(`challenges/${reviewed.id}/consent`, 'PUT', { baseVersion: reviewed.version, policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, startDate: reviewed.startDate, endDate: reviewed.endDate, shareTrainingDays: true, recipient: reviewed.counterpart })
    this.assertSession(generation)
    const result = this.changed(value, reviewed, selfId)
    if (result.status !== 'active' || !result.ownConsent || result.peerConsent !== reviewed.peerConsent) throw invalid()
    return result
  }
  async revoke(challenge: PrivateChallenge, action: 'revoke' | 'leave', confirmed: boolean): Promise<void> {
    confirm(confirmed)
    if (!['revoke', 'leave'].includes(action)) throw new CloudError('invalid_request', 'This challenge action is not supported.')
    const { generation, selfId } = this.context()
    const reviewed = readPrivateChallenge(challenge, selfId)
    const value = await this.cloud.challengeRequest(`challenges/${reviewed.id}${action === 'revoke' ? '/consent' : ''}`, 'DELETE', { baseVersion: reviewed.version })
    this.assertSession(generation)
    const result = this.changed(value, reviewed, selfId, reviewed.status !== 'active' || reviewed.version === Number.MAX_SAFE_INTEGER)
    if (result.status !== (reviewed.status === 'expired' ? 'expired' : 'revoked') || result.ownConsent || result.peerConsent) throw invalid()
  }
  async block(target: PrivateChallenge | ChallengeInvitation, confirmed: boolean): Promise<void> {
    confirm(confirmed)
    const { generation, selfId } = this.context()
    const reviewed = 'inviter' in target ? readChallengeInvitation(target, selfId) : readPrivateChallenge(target, selfId)
    await this.cloud.challengeRequest(`challenges/${reviewed.id}/block`, 'POST', { baseVersion: reviewed.version }, 204)
    this.assertSession(generation)
  }
  async counts(challenge: PrivateChallenge): Promise<ChallengeCounts> {
    const { generation, selfId } = this.context()
    const reviewed = readPrivateChallenge(challenge, selfId); active(reviewed)
    if (!reviewed.ownConsent || !reviewed.peerConsent) throw conflict()
    const value = await this.cloud.challengeRequest(`challenges/${reviewed.id}/counts`)
    this.assertSession(generation)
    return readChallengeCounts(value, reviewed)
  }
}
