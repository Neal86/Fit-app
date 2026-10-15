export const POLICY_VERSION = '2026-10-15'
export const SESSION_TTL_MS = 7 * 86400000
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 30 * 60 * 1000
export function validateConfig(config) {
  const origin = new URL(config.origin)
  if (origin.origin !== config.origin || !['http:', 'https:'].includes(origin.protocol)) throw new Error('FITFLOW_APP_ORIGIN must be a single exact http(s) origin without a trailing slash.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (config.secureCookies === false && (!loopback || origin.protocol !== 'http:')) throw new Error('Insecure cookies are permitted only for explicit HTTP localhost development.')
  if (config.secureCookies !== false && origin.protocol !== 'https:') throw new Error('Secure mode requires an HTTPS app origin.')
  return { ...config, secureCookies: config.secureCookies !== false, coachingEnabled: config.coachingEnabled === true }
}
export function configFromEnv(env = process.env) {
  const secureCookies = env.FITFLOW_ALLOW_INSECURE_LOCALHOST !== 'true'
  const config = validateConfig({ origin: env.FITFLOW_APP_ORIGIN || 'https://localhost', secureCookies, coachingEnabled: env.FITFLOW_COACHING_ENABLED === 'true' })
  const port = Number(env.FITFLOW_SERVER_PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FITFLOW_SERVER_PORT is invalid.')
  const host = env.FITFLOW_SERVER_HOST || '127.0.0.1'
  if (!secureCookies && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Insecure development must bind to loopback.')
  return { ...config, port, host, enabled: env.FITFLOW_SERVER_ENABLED === 'true', databasePath: env.FITFLOW_DATABASE_PATH || './.fitflow-data/fitflow.sqlite' }
}
