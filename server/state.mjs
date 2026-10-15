import { parseState } from '../.server-build/stateValidation.js'
import { fail } from './errors.mjs'

export const MAX_STATE_BYTES = 10 * 1024 * 1024
export function validateState(value) {
  // Walk depth-first with bounded width and node count. Never enqueue every child:
  // a compact, wide JSON array must not amplify into millions of pending tuples.
  let visited = 0
  function inspect(item, depth) {
    if (++visited > 1000000 || depth > 16) fail(400, 'invalid_state', 'Fitness state exceeds structural limits.')
    if (Array.isArray(item)) {
      if (item.length > 20000) fail(400, 'invalid_state', 'Fitness state has too many entries.')
      for (const child of item) inspect(child, depth + 1)
    } else if (item !== null && typeof item === 'object') {
      const keys = Object.keys(item)
      if (keys.length > 32) fail(400, 'invalid_state', 'Fitness state has too many object fields.')
      for (const key of keys) inspect(item[key], depth + 1)
    }
  }
  inspect(value, 0)
  let parsed
  try { parsed = parseState(value) } catch { fail(400, 'invalid_state', 'Sync requires a valid current-version fitness backup.') }
  // Device migration happens locally and is reviewed before uploading, never implicitly on server.
  if (value.version !== parsed.version) fail(400, 'invalid_state', 'Upgrade your fitness backup locally before syncing.')
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_STATE_BYTES) fail(413, 'state_too_large', 'Fitness state exceeds the 10 MiB limit.')
  return parsed
}
