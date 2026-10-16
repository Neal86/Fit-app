import type { AppState, Exercise, ExerciseLibrary, LibraryContent, LibraryEntry } from './types'
import { parseState } from './stateValidation'
import { LIBRARY_ENTRY_LIMIT, validLibraryContent } from './exerciseLibraryValidation'
import { freshIdentityFactory, type IdentityOptions } from './identities'
import { uid } from './session'

export type LibraryChangeReview = Readonly<{
  kind: 'create' | 'edit' | 'archive' | 'restore'
  entry: Readonly<LibraryEntry> | null
  content: Readonly<LibraryContent> | null
}>
export type LibraryCopyReview = Readonly<{ exercise: Readonly<Exercise>; entryId: string; revision: number }>
type Source = { state: AppState; library: ExerciseLibrary | undefined; entry: LibraryEntry | null; snapshot: string }
const changes = new WeakMap<LibraryChangeReview, Source>()
const copies = new WeakMap<LibraryCopyReview, Source>()
const stale = () => new Error('The exercise library changed. Cancel and review this entry again.')

function freezeContent(content: LibraryContent): LibraryContent {
  const copy = structuredClone(content)
  if (copy.equipment !== undefined) Object.freeze(copy.equipment)
  return Object.freeze(copy)
}
function freezeEntry(entry: LibraryEntry): LibraryEntry {
  return Object.freeze({ ...entry, exercise: freezeContent(entry.exercise) })
}
function contentKey(content: LibraryContent): string {
  return JSON.stringify([content.name, content.category, content.sets, content.reps, content.restSeconds,
    Object.hasOwn(content, 'notes') ? [content.notes] : null, content.equipment === undefined ? null : [...content.equipment].sort()])
}
function source(state: AppState, entry: LibraryEntry | null): Source {
  return { state, library: state.exerciseLibrary, entry, snapshot: JSON.stringify(state) }
}
function assertSource(state: AppState, expected: Source | undefined): asserts expected is Source {
  parseState(state)
  if (!expected || state !== expected.state || state.exerciseLibrary !== expected.library || JSON.stringify(state) !== expected.snapshot || expected.entry !== null && state.exerciseLibrary?.entries.find(entry => entry.id === expected.entry!.id) !== expected.entry) throw stale()
}
function findEntry(state: AppState, entryId: string): LibraryEntry {
  parseState(state)
  const entry = state.exerciseLibrary?.entries.find(entry => entry.id === entryId)
  if (!entry) throw stale()
  return entry
}
function requireContent(input: LibraryContent): void {
  if (!validLibraryContent(input)) throw new Error('The library entry contains invalid or unsupported fields. No data was changed.')
}
function bindChange(state: AppState, entry: LibraryEntry | null, kind: LibraryChangeReview['kind'], content: LibraryContent | null): LibraryChangeReview {
  const review = Object.freeze({ kind, entry: entry && freezeEntry(entry), content: content && freezeContent(content) })
  changes.set(review, source(state, entry)); return review
}

export function reviewLibraryCreate(state: AppState, input: LibraryContent): LibraryChangeReview {
  parseState(state); requireContent(input)
  if ((state.exerciseLibrary?.entries.length ?? 0) >= LIBRARY_ENTRY_LIMIT) throw new Error('The exercise library is full (500 entries, including archived entries).')
  return bindChange(state, null, 'create', input)
}
export function reviewLibraryEdit(state: AppState, entryId: string, input: LibraryContent): LibraryChangeReview {
  const entry = findEntry(state, entryId); requireContent(input)
  if (contentKey(entry.exercise) !== contentKey(input) && entry.revision === Number.MAX_SAFE_INTEGER) throw new Error('This entry has reached its revision limit. Its content cannot be edited.')
  return bindChange(state, entry, 'edit', input)
}
export function reviewLibraryArchive(state: AppState, entryId: string, archived: boolean): LibraryChangeReview {
  const entry = findEntry(state, entryId)
  if (typeof archived !== 'boolean') throw new Error('Choose whether to archive or restore this entry.')
  return bindChange(state, entry, archived ? 'archive' : 'restore', null)
}

/** Pure and retryable: persistence failures do not consume reviews or mutate input. */
export function applyLibraryChange(state: AppState, review: LibraryChangeReview, options: IdentityOptions & { now?: number } = {}): AppState {
  const expected = changes.get(review); assertSource(state, expected)
  const now = options.now === undefined ? Date.now() : options.now
  if (!Number.isFinite(now) || now < 0 || now > 8640000000000000) throw new Error('The library update time is invalid.')
  const timestamp = new Date(now).toISOString()
  if (!/^\d{4}-/.test(timestamp) || expected.entry && timestamp < expected.entry.updatedAt) throw new Error('The library update time is invalid or earlier than the last update.')
  let entry: LibraryEntry
  if (review.kind === 'create') {
    requireContent(review.content!)
    if ((state.exerciseLibrary?.entries.length ?? 0) >= LIBRARY_ENTRY_LIMIT) throw new Error('The exercise library is full (500 entries, including archived entries).')
    const freshId = freshIdentityFactory([state, options.reserved], options.makeId ?? uid)
    entry = { id: freshId(), revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp, exercise: structuredClone(review.content!) }
  } else {
    const prior = expected.entry!
    if (review.kind === 'edit') {
      requireContent(review.content!)
      if (contentKey(prior.exercise) === contentKey(review.content!)) return state
      if (prior.revision === Number.MAX_SAFE_INTEGER) throw new Error('This entry has reached its revision limit. Its content cannot be edited.')
      entry = { ...prior, revision: prior.revision + 1, updatedAt: timestamp, exercise: structuredClone(review.content!) }
    } else {
      const status = review.kind === 'archive' ? 'archived' : 'active'
      if (prior.status === status) return state
      entry = { ...prior, status, updatedAt: timestamp, exercise: structuredClone(prior.exercise) }
    }
  }
  const entries = review.kind === 'create' ? [...state.exerciseLibrary?.entries ?? [], entry] : state.exerciseLibrary!.entries.map(old => old.id === entry.id ? entry : old)
  const next: AppState = { ...state, exerciseLibrary: { version: 1, entries } }
  parseState(next)
  return next
}

export function reviewLibraryCopy(state: AppState, entryId: string): LibraryCopyReview {
  const entry = findEntry(state, entryId)
  if (entry.status !== 'active') throw new Error('This library entry is archived. Restore it before copying.')
  const exercise: Exercise = { ...freezeContent(entry.exercise), id: entry.id, libraryOrigin: Object.freeze({ version: 1, entryId: entry.id, revision: entry.revision }) }
  const review = Object.freeze({ exercise: Object.freeze(exercise), entryId: entry.id, revision: entry.revision })
  copies.set(review, source(state, entry)); return review
}
export function assertLibraryCopyCurrent(state: AppState, review: LibraryCopyReview): void {
  const expected = copies.get(review); assertSource(state, expected)
  if (expected.entry?.status !== 'active') throw stale()
}
export function materializeLibraryCopy(state: AppState, review: LibraryCopyReview, options: IdentityOptions = {}): Exercise {
  assertLibraryCopyCurrent(state, review)
  const freshId = freshIdentityFactory([state, review.exercise, options.reserved], options.makeId ?? uid)
  return { ...structuredClone(review.exercise), id: freshId() }
}

/** A live picker token verifies ancestry only; explicit target edits remain allowed. */
export function assertLibrarySelection(state: AppState, selected: Readonly<Exercise>, review: LibraryCopyReview): void {
  assertLibraryCopyCurrent(state, review)
  const origin = selected.libraryOrigin
  if (!origin || origin.version !== 1 || origin.entryId !== review.entryId || origin.revision !== review.revision) throw stale()
}
