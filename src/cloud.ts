import { MAX_BACKUP_BYTES, parseBackup } from './storage'
import { elapsedSeconds } from './session'
import type { AppState } from './types'
import type { CoachingAccountExport } from './coaching'
import { Capacitor } from '@capacitor/core'

export const HEALTH_SYNC_POLICY = '2026-10-15'
export type CloudUser = { id: string; email: string; emailVerified: boolean; createdAt: string }
export type CloudSession = { user: CloudUser; csrfToken: string; sessionExpiresAt: string }
export type CloudConsent = { healthSync: boolean; policyVersion: typeof HEALTH_SYNC_POLICY; updatedAt: string | null }
export type CloudSnapshot = { revision: number; state: AppState | null; updatedAt: string | null }
export type AccountExport = { format: 'fitflow-account-export'; version: 1; exportedAt: string; user: CloudUser; consent: CloudConsent; sync: CloudSnapshot; coaching?: CoachingAccountExport }
export class CloudError extends Error {
  constructor(public code: string, message: string, public status = 0, public revision?: number) { super(message); this.name = 'CloudError' }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const invalid = () => new CloudError('invalid_response', 'The service returned invalid data. Nothing was restored or confirmed as saved.')
function readUser(value: unknown): CloudUser {
  if (!record(value) || !text(value.id) || !text(value.email) || !value.email.includes('@') || typeof value.emailVerified !== 'boolean' || !date(value.createdAt)) throw invalid()
  return { id: value.id, email: value.email, emailVerified: value.emailVerified, createdAt: value.createdAt }
}
function readConsent(value: unknown): CloudConsent {
  if (!record(value) || typeof value.healthSync !== 'boolean' || value.policyVersion !== HEALTH_SYNC_POLICY || !(value.updatedAt === null || date(value.updatedAt))) throw invalid()
  return { healthSync: value.healthSync, policyVersion: HEALTH_SYNC_POLICY, updatedAt: value.updatedAt }
}
function readSnapshot(value: unknown): CloudSnapshot {
  if (!record(value) || !revision(value.revision) || !(value.updatedAt === null || date(value.updatedAt)) || !('state' in value)) throw invalid()
  // Use the same strict, size-limited validator and migrations as device backup restore.
  const state = value.state === null ? null : parseBackup(JSON.stringify(value.state))
  return { revision: value.revision, state, updatedAt: value.updatedAt }
}
export function pausedCloudState(state: AppState, now = Date.now()): AppState {
  const copy = parseBackup(JSON.stringify(state))
  if (copy.activeSession) copy.activeSession = { ...copy.activeSession, elapsedSeconds: elapsedSeconds(copy.activeSession, now), runningSince: null, restUntil: null }
  return parseBackup(JSON.stringify(copy))
}
// Never infer a server from the page origin. A missing/unsafe configuration means no network access.
export function cloudEndpoint(config: string | undefined): string | null {
  if (!config?.trim()) return null
  try {
    const url = new URL(config.trim())
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}
const environment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env

/** One in-memory account context. Do not put this instance, its CSRF token, or server snapshots in storage. */
export class CloudClient {
  readonly endpoint: string | null
  readonly nativeUnsupported: boolean
  private auth: CloudSession | null = null
  private consent: CloudConsent | null = null
  private inspectedRevision: number | null = null
  private generation = 0
  private requests = new Set<AbortController>()
  private sessionListeners = new Set<() => void>()
  private sessionVersion = 0
  /** Stable in-memory identity generation; same-account reauthentication also invalidates views. */
  get sessionRevision(): number { return this.sessionVersion }
  subscribeSession = (listener: () => void): (() => void) => {
    this.sessionListeners.add(listener)
    return () => { this.sessionListeners.delete(listener) }
  }
  private notifySession(): void { this.sessionVersion += 1; this.sessionListeners.forEach(listener => listener()) }
  constructor(config = environment?.VITE_FITFLOW_API_URL, private fetcher: typeof fetch = (...args) => fetch(...args)) { this.nativeUnsupported = Capacitor.isNativePlatform(); this.endpoint = this.nativeUnsupported ? null : cloudEndpoint(config) }
  get session(): CloudSession | null { return this.auth ? structuredClone(this.auth) : null }
  get configured(): boolean { return this.endpoint !== null }
  clear(): void {
    this.generation += 1
    this.auth = null; this.consent = null; this.inspectedRevision = null
    this.requests.forEach(controller => controller.abort()); this.requests.clear()
    this.notifySession()
  }
  private requireSession(verified = false): CloudSession {
    if (!this.auth || Date.parse(this.auth.sessionExpiresAt) <= Date.now()) {
      this.clear(); throw new CloudError('session_expired', 'Your session has expired. Sign in again; your device data is unchanged.')
    }
    if (verified && !this.auth.user.emailVerified) throw new CloudError('email_unverified', 'Verify your email, then sign in again before using cloud data.')
    return this.auth
  }
  private assertGeneration(generation: number, authenticated = false): void {
    if (generation !== this.generation) throw new CloudError('cancelled', 'This account action was cancelled.')
    if (authenticated) this.requireSession()
  }
  private async request(path: string, method = 'GET', body?: unknown, authenticated = false, expectedStatus = 200, responseLimit = MAX_BACKUP_BYTES + 64 * 1024): Promise<unknown> {
    if (!this.endpoint) throw new CloudError('not_configured', 'Cloud accounts are not configured in this build. Your data stays on this device.')
    const session = authenticated ? this.requireSession() : null
    const generation = this.generation
    const controller = new AbortController(); this.requests.add(controller)
    const timer = setTimeout(() => controller.abort(), 20_000)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'; headers['X-Fitflow-Client'] = 'web'
    }
    if (session) headers['X-CSRF-Token'] = session.csrfToken
    try {
      const response = await this.fetcher(`${this.endpoint}/${path}`, {
        method, headers, credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      this.assertGeneration(generation, authenticated)
      if (!response.ok) {
        let value: unknown = null
        try { value = await response.json() } catch { /* Do not expose response bodies or secrets. */ }
        this.assertGeneration(generation, authenticated)
        const detail = record(value) && record(value.error) ? value.error : null
        const code = detail && typeof detail.code === 'string' ? detail.code : ''
        if (response.status === 401) {
          this.clear()
          throw new CloudError('unauthorized', 'Sign-in was not accepted or your session has expired. Sign in again.', 401)
        }
        if (response.status === 409 && code === 'sync_conflict') {
          this.inspectedRevision = null
          const next = detail && record(detail.details) && revision(detail.details.revision) ? detail.details.revision : undefined
          throw new CloudError('sync_conflict', 'The cloud copy changed. Inspect the latest cloud copy, then choose upload or restore again. Nothing was overwritten by this request.', 409, next)
        }
        if (response.status === 403 && code === 'csrf_failed') {
          this.clear(); throw new CloudError('account_changed', 'Your browser session changed. Sign in again before accessing cloud data.', 403)
        }
        if (response.status === 403) { this.consent = null; this.inspectedRevision = null }
        const messages: Record<number, string> = {
          400: 'The service could not accept these details. Check the form and try again.',
          403: 'This action is not allowed. Check email verification and cloud consent, or sign in again.',
          409: 'This action conflicts with the current account. Refresh the account details before trying again.',
          413: 'The data is too large for cloud storage. Your device data is unchanged.',
          422: 'The service could not validate these details. Check the form and try again.',
          429: 'Too many requests. Wait before trying again.',
          503: 'The cloud service or email provider is not enabled or is unavailable. This action was not confirmed.',
        }
        throw new CloudError(code || 'service_error', messages[response.status] ?? 'The cloud service could not complete this action. Its outcome is not confirmed.', response.status)
      }
      if (response.status !== expectedStatus) throw invalid()
      if (response.status === 204) return undefined
      const source = await response.text()
      if (new Blob([source]).size > responseLimit) throw invalid()
      this.assertGeneration(generation, authenticated)
      try { return JSON.parse(source) } catch { throw invalid() }
    } catch (cause) {
      if (cause instanceof CloudError) throw cause
      this.assertGeneration(generation, authenticated)
      throw new CloudError('network_error', 'The request did not complete. Check your connection. Its outcome is not confirmed; inspect the cloud copy before retrying an upload.')
    } finally { clearTimeout(timer); this.requests.delete(controller) }
  }
  private setSession(value: unknown): CloudSession {
    if (!record(value) || !text(value.csrfToken) || !date(value.sessionExpiresAt) || Date.parse(value.sessionExpiresAt) <= Date.now()) throw invalid()
    this.auth = { user: readUser(value.user), csrfToken: value.csrfToken, sessionExpiresAt: value.sessionExpiresAt }
    const generation = ++this.generation
    this.notifySession()
    this.assertGeneration(generation, true)
    return this.session!
  }
  async login(email: string, password: string): Promise<CloudSession> {
    this.clear()
    const generation = this.generation
    const value = await this.request('auth/login', 'POST', { email: email.trim(), password })
    this.assertGeneration(generation)
    return this.setSession(value)
  }
  async checkSession(): Promise<CloudSession> {
    this.clear()
    const generation = this.generation
    const value = await this.request('auth/session')
    this.assertGeneration(generation)
    return this.setSession(value)
  }
  async register(email: string, password: string): Promise<void> {
    this.clear()
    const generation = this.generation
    const value = await this.request('auth/register', 'POST', { email: email.trim(), password }, false, 202)
    this.assertGeneration(generation)
    if (!record(value) || value.status !== 'verification_required') throw invalid()
  }
  async logout(): Promise<void> {
    const generation = this.generation
    try {
      await this.request('auth/logout', 'POST', {}, true, 204)
      this.assertGeneration(generation, true)
    } finally {
      // An old logout must never clear a newer account established while it was pending.
      if (generation === this.generation) this.clear()
    }
  }
  async requestVerification(email: string): Promise<void> {
    const generation = this.generation
    const value = await this.request('auth/verification/request', 'POST', { email: email.trim() }, false, 202)
    this.assertGeneration(generation); this.expectStatus(value, 'accepted')
  }
  async confirmVerification(token: string): Promise<void> {
    const generation = this.generation
    const value = await this.request('auth/verification/confirm', 'POST', { token: token.trim() })
    this.assertGeneration(generation); this.expectStatus(value, 'verified'); this.clear()
  }
  async requestPasswordReset(email: string): Promise<void> {
    const generation = this.generation
    const value = await this.request('auth/password-reset/request', 'POST', { email: email.trim() }, false, 202)
    this.assertGeneration(generation); this.expectStatus(value, 'accepted')
  }
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    this.clear()
    const generation = this.generation
    const value = await this.request('auth/password-reset/confirm', 'POST', { token: token.trim(), password })
    this.assertGeneration(generation); this.expectStatus(value, 'password_reset')
  }
  private expectStatus(value: unknown, status: string): void { if (!record(value) || value.status !== status) throw invalid() }
  /** Narrow authenticated transport. Collaboration payloads are validated by coaching.ts. */
  async coachingRequest(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, expectedStatus = 200): Promise<unknown> {
    const id = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
    const allowed: Record<string, RegExp> = {
      GET: new RegExp(`^coaching(?:/relationships/${id}/(?:snapshot|feedback))?$`),
      POST: new RegExp(`^coaching/(?:invitations(?:/cancel|/${id}/accept)?|relationships/${id}/feedback)$`),
      PUT: new RegExp(`^coaching/relationships/${id}/consent$`),
      DELETE: new RegExp(`^coaching/(?:invitations/${id}|relationships/${id}(?:/feedback/${id})?)$`),
    }
    if (!allowed[method]?.test(path) || ![200, 201, 202, 204].includes(expectedStatus)) throw new CloudError('invalid_request', 'This collaboration action is not supported.')
    this.requireSession(true)
    const generation = this.generation
    const value = await this.request(path, method, body, true, expectedStatus)
    this.assertGeneration(generation, true)
    return value
  }
  async getConsent(): Promise<CloudConsent> {
    this.requireSession(true)
    const generation = this.generation
    this.consent = null
    const response = await this.request('consent', 'GET', undefined, true)
    this.assertGeneration(generation, true)
    const value = readConsent(response)
    this.consent = value
    if (!value.healthSync) this.inspectedRevision = null
    return structuredClone(value)
  }
  async setConsent(healthSync: boolean): Promise<CloudConsent> {
    this.requireSession(true)
    const generation = this.generation
    this.consent = null; this.inspectedRevision = null
    const response = await this.request('consent', 'PUT', { healthSync, policyVersion: HEALTH_SYNC_POLICY }, true)
    this.assertGeneration(generation, true)
    const value = readConsent(response)
    if (value.healthSync !== healthSync) throw invalid()
    this.consent = value
    return structuredClone(value)
  }
  async inspectSync(): Promise<CloudSnapshot> {
    this.requireSession(true)
    const generation = this.generation
    this.inspectedRevision = null
    const consent = await this.getConsent()
    this.assertGeneration(generation, true)
    if (!consent.healthSync) throw new CloudError('consent_required', 'Enable cloud health-data consent before accessing a cloud copy.')
    const response = await this.request('sync', 'GET', undefined, true)
    this.assertGeneration(generation, true)
    const value = readSnapshot(response)
    this.inspectedRevision = value.revision
    return value
  }
  async upload(state: AppState, baseRevision: number, confirmed: boolean): Promise<{ revision: number; updatedAt: string; replayed: boolean }> {
    this.requireSession(true)
    const generation = this.generation
    if (!confirmed) throw new CloudError('confirmation_required', 'Review and confirm this upload first.')
    if (!revision(baseRevision) || baseRevision !== this.inspectedRevision) throw new CloudError('inspection_required', 'Inspect the latest cloud copy before uploading.')
    const snapshot = pausedCloudState(state)
    // A fresh server-side consent check is required for every manual upload.
    const consent = await this.getConsent()
    this.assertGeneration(generation, true)
    if (!consent.healthSync) throw new CloudError('consent_required', 'Cloud health-data consent is off. Nothing was uploaded.')
    if (baseRevision !== this.inspectedRevision) throw new CloudError('inspection_required', 'Inspect the latest cloud copy before uploading.')
    if (!globalThis.crypto?.randomUUID) throw new CloudError('secure_context_required', 'Cloud upload requires a browser with secure UUID support.')
    this.inspectedRevision = null // No blind retries after an uncertain response or conflict.
    const value = await this.request('sync', 'PUT', { baseRevision, operationId: crypto.randomUUID(), state: snapshot }, true)
    this.assertGeneration(generation, true)
    if (!record(value) || !revision(value.revision) || value.revision <= baseRevision || !date(value.updatedAt) || typeof value.replayed !== 'boolean') throw invalid()
    return { revision: value.revision, updatedAt: value.updatedAt, replayed: value.replayed }
  }
  async exportAccount(password: string): Promise<AccountExport> {
    const id = this.requireSession().user.id
    const generation = this.generation
    const value = await this.request('account/export', 'POST', { password }, true, 200, 64 * 1024 * 1024)
    this.assertGeneration(generation, true)
    if (!record(value) || value.format !== 'fitflow-account-export' || value.version !== 1 || !date(value.exportedAt)) throw invalid()
    const user = readUser(value.user)
    if (user.id !== id) throw invalid()
    const consent = readConsent(value.consent)
    const sync = readSnapshot(value.sync)
    let coaching: CoachingAccountExport | undefined
    if (value.coaching !== undefined) {
      const { readCoachingAccountExport } = await import('./coaching')
      // Module loading is another asynchronous boundary before private data can be returned.
      this.assertGeneration(generation, true)
      coaching = readCoachingAccountExport(value.coaching, id)
    }
    return { format: 'fitflow-account-export', version: 1, exportedAt: value.exportedAt, user, consent, sync, ...(coaching ? { coaching } : {}) }
  }
  async deleteAccount(password: string, confirmation: string): Promise<void> {
    if (confirmation !== 'DELETE') throw new CloudError('confirmation_required', 'Type DELETE to confirm permanent cloud-account deletion.')
    this.requireSession()
    const generation = this.generation
    await this.request('account', 'DELETE', { password, confirmation }, true, 204)
    this.assertGeneration(generation, true)
    this.clear()
  }
}
