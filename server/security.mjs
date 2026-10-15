import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { fail } from './errors.mjs'

const scrypt = promisify(scryptCallback)
// OWASP's memory-hard fallback where Argon2id is unavailable. Never lower in tests.
const COST = { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }
const DUMMY_SALT = '7e97fe66e8a64d21ab070e02f960f416'
const DUMMY_HASH = '00'.repeat(64)
let activeHashes = 0
export const token = () => randomBytes(32).toString('base64url')
export const digest = value => createHash('sha256').update(value).digest('hex')
export const csrfFor = value => digest(`fitflow-csrf-v1:${value}`)
export const safeEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || Buffer.byteLength(password) > 512) fail(400, 'invalid_password', 'Use a password between 12 and 128 characters (at most 512 bytes).')
}
export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(value.trim())) fail(400, 'invalid_email', 'Enter a valid email address.')
  return value.trim().toLowerCase()
}
async function derive(password, salt) {
  // Bound 128 MiB derivations globally; reject excess work instead of building an unbounded queue.
  if (activeHashes >= 2) fail(503, 'auth_busy', 'Authentication is busy. Try again shortly.')
  activeHashes++
  try { return await scrypt(password, salt, 64, COST) } finally { activeHashes-- }
}
export async function hashPassword(password) {
  validatePassword(password)
  const salt = randomBytes(16).toString('hex')
  const result = await derive(password, salt)
  return `scrypt$131072$8$1$${salt}$${result.toString('hex')}`
}
export async function verifyPassword(password, encoded) {
  validatePassword(password)
  const pieces = (encoded ?? `scrypt$131072$8$1$${DUMMY_SALT}$${DUMMY_HASH}`).split('$')
  if (pieces.length !== 6 || pieces.slice(0, 4).join('$') !== 'scrypt$131072$8$1' || !/^[a-f0-9]{32}$/.test(pieces[4]) || !/^[a-f0-9]{128}$/.test(pieces[5])) throw new Error('Invalid stored password hash')
  const actual = await derive(password, pieces[4])
  return timingSafeEqual(actual, Buffer.from(pieces[5], 'hex')) && !!encoded
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
