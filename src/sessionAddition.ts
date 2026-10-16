import { assertLibrarySelection, type LibraryCopyReview } from './exerciseLibrary'
import { uid } from './session'
import { parseState, validWorkout } from './stateValidation'
import type { ActiveSession, AppState, Exercise, ExerciseSet } from './types'

/** Ephemeral review only. No review token or new schema field is persisted. */
export type SessionAdditionReview = Readonly<{
  exercise: Readonly<Exercise>
  addedSetCount: number
}>
const sources = new WeakMap<SessionAdditionReview, { session: ActiveSession; snapshot: string; libraryCopyReview?: LibraryCopyReview }>()
const stale = () => new Error('This session changed. Cancel and review the addition again.')

function validateAddition(state: AppState, selected: Exercise): ActiveSession {
  const validated = parseState(state)
  const session = state.activeSession
  if (!session || !validated.activeSession) throw stale()
  // Reuse the unchanged exercise schema, including exactly 1–20 planned sets.
  if (!validWorkout({ ...session.workout, exercises: [selected] })) throw new Error('Backup data is incomplete or contains invalid values.')
  if (session.workout.exercises.length >= 50) throw new Error('Adding this exercise would exceed 50 exercises. No rows were changed.')
  if (session.sets.length + selected.sets > 2500) throw new Error('Adding these sets would exceed 2500 session sets. No rows were changed.')
  return session
}

export function reviewSessionAddition(state: AppState, selected: Exercise, libraryCopyReview?: LibraryCopyReview): SessionAdditionReview {
  if (libraryCopyReview) assertLibrarySelection(state, selected, libraryCopyReview)
  const session = validateAddition(state, selected)
  const exercise = structuredClone(selected)
  if (exercise.equipment !== undefined) Object.freeze(exercise.equipment)
  if (exercise.libraryOrigin !== undefined) Object.freeze(exercise.libraryOrigin)
  const review = Object.freeze({ exercise: Object.freeze(exercise), addedSetCount: exercise.sets })
  sources.set(review, { session, snapshot: JSON.stringify(session), libraryCopyReview })
  return review
}

/** Uses current transactional state; existing session content is never replaced by the selection. */
export function applySessionAddition(state: AppState, review: SessionAdditionReview, makeId: () => string = uid): AppState {
  const expected = sources.get(review)
  const session = state.activeSession
  if (!expected || session !== expected.session || JSON.stringify(session) !== expected.snapshot) throw stale()
  if (expected.libraryCopyReview) assertLibrarySelection(state, review.exercise, expected.libraryCopyReview)
  // Validate again before allocating identities. Failures leave the state and review usable.
  validateAddition(state, review.exercise)
  const reserved = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('Id')) && typeof child === 'string') reserved.add(child)
      else if (key.endsWith('Ids') && Array.isArray(child)) child.forEach(id => reserved.add(id))
      else collect(child)
    }
  }
  collect(state); collect(review.exercise)
  const freshId = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = makeId()
      if (typeof id === 'string' && id.trim() && id.length <= 150 && !reserved.has(id)) { reserved.add(id); return id }
    }
    throw new Error('Could not create distinct addition identities. No rows were changed; try again.')
  }
  const exercise: Exercise = { ...review.exercise, id: freshId() }
  const sets: ExerciseSet[] = Array.from({ length: review.addedSetCount }, (_, index) => ({
    id: freshId(), exerciseId: exercise.id, setNumber: index + 1,
    reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false,
  }))
  const next: AppState = {
    ...state,
    activeSession: structuredClone({
      ...session, workout: { ...session.workout, exercises: [...session.workout.exercises, exercise] },
      sets: [...session.sets, ...sets],
    }),
  }
  parseState(next)
  return next
}
