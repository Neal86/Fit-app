import {
  NATIVE_ACCOUNT_LIMITS, readNativeAccountCapabilities, readNativeAccountCapabilitiesQuery,
  readNativeAccountContext, readNativeAccountContextReply, readNativeAccountReply, readNativeAccountRequest,
  type NativeAccountCapabilities, type NativeAccountCapabilitiesQuery, type NativeAccountContext,
  type NativeAccountPort, type NativeAccountReply, type NativeAccountRequest,
} from './nativeAccountContract'

/** Unwired, explicit-use adapter. A capability reply is NOT evidence of native isolation. */
export const NATIVE_ACCOUNT_CHANNEL_LIMITS = Object.freeze({
  pendingRequests: 2, pendingLocal: 4, contexts: 128, requestsPerContext: 4096, calls: 8192,
  envelopeBytes: 1024, localReplyBytes: 1024,
})
export type NativeAccountChannelErrorCode = 'unavailable' | 'invalid_request' | 'invalid_response' | 'cancelled' | 'expired' | 'network_error' | 'busy' | 'context_exhausted'
export class NativeAccountChannelError extends Error {
  constructor(readonly code: NativeAccountChannelErrorCode) {
    super('Native account channel operation failed.')
    this.name = 'NativeAccountChannelError'
  }
}
export interface NativeAccountAndroidChannel {
  postMessage(message: string): void
  onmessage?: ((event: { data: unknown }) => void) | null
}
export interface NativeAccountIOSChannel { postMessage(message: string): Promise<string> }
/** Test doubles may implement these exact endpoints; there is no URL/header/transport option. */
export interface NativeAccountChannelWindow {
  FitflowNativeAccounts?: NativeAccountAndroidChannel
  webkit?: { messageHandlers?: { FitflowNativeAccounts?: NativeAccountIOSChannel } }
}
export interface NativeAccountChannel extends NativeAccountPort { dispose(): void }
export interface NativeAccountChannelOptions {
  target?: NativeAccountChannelWindow
  /** Trusted current clock. Injection is for deterministic synthetic tests, never message data. */
  now?: () => number
}

type Operation = 'capabilities' | 'startContext' | 'clearContext' | 'request'
type Payload = NativeAccountCapabilitiesQuery | NativeAccountContext | NativeAccountRequest
type Value = NativeAccountCapabilities | NativeAccountContext | NativeAccountReply
type Context = { value: NativeAccountContext; ready: boolean; requests: Set<string> }
type Pending = {
  operation: Operation; payload: Payload | undefined; context?: Context; limit: number;
  timer: ReturnType<typeof setTimeout>; resolve(value: Value): void; reject(error: NativeAccountChannelError): void
}
type Transport = { kind: 'android'; endpoint: NativeAccountAndroidChannel; send(message: string): void } | { kind: 'ios'; send(message: string): Promise<string> }
const errorCodes: readonly NativeAccountChannelErrorCode[] = ['unavailable', 'invalid_request', 'invalid_response', 'cancelled', 'expired', 'network_error', 'busy', 'context_exhausted']
const owners = new WeakMap<NativeAccountAndroidChannel, object>()
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const fail = (code: NativeAccountChannelErrorCode): never => { throw new NativeAccountChannelError(code) }
const encoder = new TextEncoder()
function boundedString(value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || encoder.encode(value).byteLength > limit) fail('invalid_response')
}
function replyLimit(operation: Operation, payload: Payload): number {
  if (operation !== 'request') return NATIVE_ACCOUNT_CHANNEL_LIMITS.localReplyBytes
  const { path } = payload as NativeAccountRequest
  return (path === 'account/export' ? NATIVE_ACCOUNT_LIMITS.exportResponseBytes : path.startsWith('challenges') ? NATIVE_ACCOUNT_LIMITS.challengeResponseBytes : NATIVE_ACCOUNT_LIMITS.responseBytes) + NATIVE_ACCOUNT_CHANNEL_LIMITS.envelopeBytes
}

/** Scan bounded JSON before materializing it: enforce depth/nodes, reject duplicate keys,
 * and identify the outer correlation ID before choosing the per-call parse budget.
 * This deliberately never decodes business string values or interprets their contents. */
function scanEnvelope(raw: string): string {
  let offset = 0; let nodes = 0; let callId = ''
  const invalid = () => fail('invalid_response')
  const space = () => { while (/[\t\n\r ]/.test(raw[offset] ?? '') && offset < raw.length) offset++ }
  const string = () => {
    const start = offset
    if (raw[offset++] !== '"') invalid()
    while (offset < raw.length) {
      const code = raw.charCodeAt(offset++)
      if (code === 34) return [start, offset] as const
      if (code < 32) invalid()
      if (code === 92) {
        const escaped = raw[offset++]
        if (escaped === 'u') {
          for (let count = 0; count < 4; count++) if (!/[0-9a-fA-F]/.test(raw[offset++] ?? '')) invalid()
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid()
      }
    }
    return invalid()
  }
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  const value = (depth: number): void => {
    if (depth > NATIVE_ACCOUNT_LIMITS.depth + 1 || ++nodes > NATIVE_ACCOUNT_LIMITS.nodes + 4) invalid()
    space()
    if (raw[offset] === '"') { string(); return }
    if (raw[offset] === '{') {
      offset++; space()
      const keys = new Set<string>()
      if (raw[offset] === '}') { offset++; return }
      for (;;) {
        const [start, end] = string()
        const key: string = JSON.parse(raw.slice(start, end))
        if (keys.has(key)) invalid()
        keys.add(key); space()
        if (raw[offset++] !== ':') invalid()
        space()
        const begin = offset
        value(depth + 1)
        if (depth === 0 && key === 'callId') {
          if (offset - begin !== 38 || raw[begin] !== '"') invalid()
          callId = raw.slice(begin + 1, offset - 1)
        }
        space()
        if (raw[offset] === '}') { offset++; return }
        if (raw[offset++] !== ',') invalid()
        space()
      }
    }
    if (raw[offset] === '[') {
      offset++; space()
      if (raw[offset] === ']') { offset++; return }
      for (;;) {
        value(depth + 1); space()
        if (raw[offset] === ']') { offset++; return }
        if (raw[offset++] !== ',') invalid()
        space()
      }
    }
    for (const token of ['true', 'false', 'null']) {
      if (raw.startsWith(token, offset)) { offset += token.length; return }
    }
    number.lastIndex = offset
    const match = number.exec(raw)
    if (!match) invalid()
    offset = number.lastIndex
  }
  value(0); space()
  if (offset !== raw.length || !uuid(callId)) invalid()
  return callId
}
function readEnvelope(raw: string, expectedId: string): { ok: true; value: unknown } | { ok: false; error: NativeAccountChannelErrorCode } {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_response')
  const record = value as Record<string, unknown>
  const fields = record.ok === true ? ['version', 'callId', 'ok', 'value'] : ['version', 'callId', 'ok', 'error']
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key)) || record.version !== 1 || record.callId !== expectedId || typeof record.ok !== 'boolean') fail('invalid_response')
  if (record.ok) return { ok: true, value: record.value }
  if (!errorCodes.includes(record.error as NativeAccountChannelErrorCode)) fail('invalid_response')
  return { ok: false, error: record.error as NativeAccountChannelErrorCode }
}

/** Constructing is explicit; discovery/handler acquisition happens only on a validated call.
 * Native code independently owns origin/frame isolation, credentials and session lifetime.
 * Successful business bodies STILL require the existing domain validators before use. */
export function createNativeAccountChannel(options: NativeAccountChannelOptions = {}): NativeAccountChannel {
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window as NativeAccountChannelWindow)
  const now = options.now ?? Date.now
  const owner = {}
  const pending = new Map<string, Pending>()
  const calls = new Set<string>()
  const contexts = new Set<string>()
  let transport: Transport | undefined
  let current: Context | undefined
  let disposed = false

  function nextCallId(): string {
    if (calls.size >= NATIVE_ACCOUNT_CHANNEL_LIMITS.calls) return fail('context_exhausted')
    let id: unknown
    try { id = globalThis.crypto.randomUUID() } catch { return fail('unavailable') }
    if (!uuid(id) || id[14] !== '4' || calls.has(id)) return fail('unavailable')
    calls.add(id)
    return id
  }
  function ownsHandler(): boolean {
    return transport?.kind !== 'android' || owners.get(transport.endpoint) === owner && transport.endpoint.onmessage === onmessage
  }
  function detach(): void {
    if (transport?.kind !== 'android') return
    try { if (transport.endpoint.onmessage === onmessage) transport.endpoint.onmessage = null } catch { /* No diagnostics or takeover. */ }
    if (owners.get(transport.endpoint) === owner) owners.delete(transport.endpoint)
  }
  function take(id: string): Pending | undefined {
    const entry = pending.get(id)
    if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.payload = undefined }
    return entry
  }
  function cancelContext(context: Context): void {
    if (current === context) current = undefined
    for (const [id, entry] of pending) if (entry.context === context) take(id)?.reject(new NativeAccountChannelError('cancelled'))
  }
  function abandon(): void {
    disposed = true; current = undefined
    for (const id of pending.keys()) take(id)?.reject(new NativeAccountChannelError('unavailable'))
    detach()
  }
  function connect(): Transport | undefined {
    if (disposed) return fail('cancelled')
    try {
      if (transport) {
        if (!ownsHandler()) { abandon(); return fail('unavailable') }
        return transport
      }
      const android = target?.FitflowNativeAccounts
      const ios = target?.webkit?.messageHandlers?.FitflowNativeAccounts
      if (android && ios) return undefined
      if (android && typeof android.postMessage === 'function') {
        if (owners.has(android) || android.onmessage != null) return fail('busy')
        const send = android.postMessage.bind(android)
        owners.set(android, owner)
        try {
          android.onmessage = onmessage
          if (android.onmessage !== onmessage) fail('unavailable')
        } catch { owners.delete(android); return fail('unavailable') }
        transport = { kind: 'android', endpoint: android, send }
      } else if (ios && typeof ios.postMessage === 'function') transport = { kind: 'ios', send: ios.postMessage.bind(ios) }
      return transport
    } catch (error) {
      if (error instanceof NativeAccountChannelError) throw error
      return fail('unavailable')
    }
  }
  function count(network: boolean): number {
    let count = 0
    for (const entry of pending.values()) if ((entry.operation === 'request') === network) count++
    return count
  }
  function wire(operation: Operation, payload: Payload, id: string): string {
    const raw = JSON.stringify({ version: 1, callId: id, operation, payload })
    const limit = operation === 'request' ? ((payload as NativeAccountRequest).path === 'sync' && (payload as NativeAccountRequest).method === 'PUT' ? NATIVE_ACCOUNT_LIMITS.snapshotBytes : NATIVE_ACCOUNT_LIMITS.requestBytes) + NATIVE_ACCOUNT_CHANNEL_LIMITS.envelopeBytes : NATIVE_ACCOUNT_CHANNEL_LIMITS.localReplyBytes
    if (encoder.encode(raw).byteLength > limit) return fail('invalid_request')
    return raw
  }
  function makeClearRoom(): void {
    // Credential disposal has priority over an unrelated local acknowledgment. The
    // abandoned call stays terminal, so its later callback cannot regain ownership.
    if (count(false) < NATIVE_ACCOUNT_CHANNEL_LIMITS.pendingLocal) return
    for (const [id, entry] of pending) if (entry.operation !== 'request') {
      take(id)?.reject(new NativeAccountChannelError('cancelled'))
      return
    }
  }
  function cleanup(context: NativeAccountContext): void {
    // Local clear only; this never claims server logout/revocation and cannot clear a newer ID.
    try { makeClearRoom(); void issue('clearContext', context).catch(() => undefined) } catch { /* Best effort. */ }
  }
  function reject(id: string, code: NativeAccountChannelErrorCode): void {
    const entry = take(id)
    if (!entry) return
    const context = entry.context
    if (context && current === context && code !== 'busy') {
      cancelContext(context)
      cleanup(context.value)
    } else if (context && current === context && entry.operation === 'startContext') {
      cancelContext(context)
    }
    entry.reject(new NativeAccountChannelError(code))
  }
  function receive(raw: unknown, expectedId?: string): void {
    if (disposed || !pending.size) return
    if (!ownsHandler()) { abandon(); return }
    if (expectedId && !pending.has(expectedId)) return
    let id: string
    try {
      const limit = expectedId ? pending.get(expectedId)!.limit : Math.max(...Array.from(pending.values(), entry => entry.limit))
      boundedString(raw, limit)
      id = scanEnvelope(raw)
      if (expectedId && id !== expectedId) return reject(expectedId, 'invalid_response')
    } catch {
      // Uncorrelated Android garbage may be an old callback; it must not cancel a new call.
      if (expectedId) reject(expectedId, 'invalid_response')
      return
    }
    const entry = pending.get(id)
    if (!entry) return
    try {
      boundedString(raw, entry.limit)
      const envelope = readEnvelope(raw, id)
      if (!envelope.ok) { reject(id, envelope.error); return }
      if (entry.context && current !== entry.context) { reject(id, 'cancelled'); return }
      let value: Value
      if (entry.operation === 'capabilities') value = readNativeAccountCapabilities(envelope.value)
      else if (entry.operation === 'request') {
        const clock = now()
        if (!Number.isSafeInteger(clock)) fail('invalid_response')
        value = readNativeAccountReply(envelope.value, entry.payload as NativeAccountRequest, clock)
      } else value = readNativeAccountContextReply(envelope.value, entry.payload as NativeAccountContext)
      if (entry.operation === 'startContext' && entry.context) entry.context.ready = true
      take(id)?.resolve(value)
    } catch { reject(id, 'invalid_response') }
  }
  function onmessage(event: { data: unknown }): void {
    try { receive(event.data) } catch { /* Never publish native diagnostics or malformed data. */ }
  }
  function prepare(operation: Operation, payload: Payload, replacingStart = false) {
    const endpoint = connect()
    if (!endpoint) return fail('unavailable')
    const network = operation === 'request'
    const retiring = replacingStart ? Array.from(pending.values()).filter(entry => entry.operation === 'startContext' && entry.context === current).length : 0
    if (count(network) - retiring >= (network ? NATIVE_ACCOUNT_CHANNEL_LIMITS.pendingRequests : NATIVE_ACCOUNT_CHANNEL_LIMITS.pendingLocal)) return fail('busy')
    const id = nextCallId()
    return { endpoint, id, message: wire(operation, payload, id) }
  }
  function forward(result: Promise<string>, id: string, operation: Operation): void {
    // A separate lexical scope keeps unresolved native promises away from form payloads.
    void result.then(raw => receive(raw, id), () => reject(id, operation === 'request' ? 'network_error' : 'unavailable'))
  }
  function issue(operation: Operation, payload: Payload, context?: Context, prepared = prepare(operation, payload)): Promise<Value> {
    const { endpoint, id, message } = prepared
    return new Promise<Value>((resolve, rejectPromise) => {
      const timer = setTimeout(() => reject(id, 'expired'), NATIVE_ACCOUNT_LIMITS.requestTimeoutMs)
      pending.set(id, { operation, payload, context, limit: replyLimit(operation, payload), timer, resolve, reject: rejectPromise })
      try {
        if (endpoint.kind === 'android') endpoint.send(message)
        else {
          const result = endpoint.send(message)
          if (!(result instanceof Promise)) { reject(id, 'invalid_response'); return }
          forward(result, id, operation)
        }
      } catch { reject(id, operation === 'request' ? 'network_error' : 'unavailable') }
    })
  }
  function reviewed<T>(reader: () => T): T {
    try { return reader() } catch { return fail('invalid_request') }
  }
  function promise<T>(work: () => T | Promise<T>): Promise<T> {
    try { return Promise.resolve(work()) } catch (error) {
      return Promise.reject(error instanceof NativeAccountChannelError ? error : new NativeAccountChannelError('unavailable'))
    }
  }
  return Object.freeze({
    capabilities(query: NativeAccountCapabilitiesQuery): Promise<NativeAccountCapabilities> {
      return promise(() => {
        const input = reviewed(() => readNativeAccountCapabilitiesQuery(query))
        if (!connect()) return Object.freeze({ version: 1 as const, available: false })
        return issue('capabilities', input) as Promise<NativeAccountCapabilities>
      })
    },
    startContext(context: NativeAccountContext): Promise<NativeAccountContext> {
      return promise(() => {
        const input = reviewed(() => readNativeAccountContext(context))
        if (contexts.has(input.contextId)) return fail('invalid_request')
        if (contexts.size >= NATIVE_ACCOUNT_CHANNEL_LIMITS.contexts) return fail('context_exhausted')
        if (!connect()) return fail('unavailable')
        // Prepare IDs and capacity first: an unsent command cannot retire the current state.
        const prepared = prepare('startContext', input, true)
        if (current) {
          const previous = current
          cancelContext(previous)
          // If the new start never reaches native, its own clear would not match
          // the previous generation. Retire that exact context locally first.
          cleanup(previous.value)
          makeClearRoom()
        }
        const next: Context = { value: input, ready: false, requests: new Set() }
        current = next; contexts.add(input.contextId)
        try { return issue('startContext', input, next, prepared) as Promise<NativeAccountContext> } catch (error) {
          if (current === next) cancelContext(next)
          throw error
        }
      })
    },
    clearContext(context: NativeAccountContext): Promise<NativeAccountContext> {
      return promise(() => {
        const input = reviewed(() => readNativeAccountContext(context))
        if (current?.value.contextId === input.contextId) { cancelContext(current); makeClearRoom() }
        return issue('clearContext', input) as Promise<NativeAccountContext>
      })
    },
    request(command: NativeAccountRequest): Promise<NativeAccountReply> {
      return promise(() => {
        const input = reviewed(() => readNativeAccountRequest(command))
        if (disposed) return fail('cancelled')
        const context = current
        if (!context?.ready || context.value.contextId !== input.contextId) return fail('cancelled')
        if (context.requests.has(input.requestId)) return fail('invalid_request')
        if (context.requests.size >= NATIVE_ACCOUNT_CHANNEL_LIMITS.requestsPerContext) return fail('context_exhausted')
        if (count(true) >= NATIVE_ACCOUNT_CHANNEL_LIMITS.pendingRequests) return fail('busy')
        // Burn the ID before a synchronous callback/throw; never retry an uncertain write.
        context.requests.add(input.requestId)
        return issue('request', input, context) as Promise<NativeAccountReply>
      })
    },
    dispose(): void {
      if (disposed) return
      const context = current?.value
      disposed = true; current = undefined
      for (const id of pending.keys()) take(id)?.reject(new NativeAccountChannelError('cancelled'))
      try {
        // One bounded, untracked local clear; no reply can restore a disposed generation.
        if (context && transport && ownsHandler()) {
          const message = wire('clearContext', context, nextCallId())
          const result = transport.send(message)
          if (result instanceof Promise) void result.then(() => undefined, () => undefined)
        }
      } catch { /* Best effort; explicit server logout is a separate operation. */ }
      detach()
    },
  })
}
