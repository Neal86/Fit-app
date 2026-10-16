import { uid } from './session'
import { parseState } from './stateValidation'
import type { ActiveSession, AppState, Exercise, ExerciseSet } from './types'

export type SessionReplacementGroupImpact = Readonly<{ groupId: string; groupName: string; roundId: string; roundNumber: number; setId: string }>

/** Ephemeral review only. No review token or new schema field is persisted. */
export type SessionReplacementReview = Readonly<{
  source: Readonly<Exercise>
  replacement: Readonly<Exercise>
  removedSets: readonly Readonly<ExerciseSet>[]
  completedCount: number
  groupImpacts: readonly SessionReplacementGroupImpact[]
}>
const sources = new WeakMap<SessionReplacementReview, { session: ActiveSession; snapshot: string }>()
const stale = () => new Error('This session changed. Cancel and review the replacement again.')
function freezeExercise(exercise: Exercise): Readonly<Exercise> {
  const snapshot = structuredClone(exercise)
  if (snapshot.equipment !== undefined) Object.freeze(snapshot.equipment)
  return Object.freeze(snapshot)
}

export function reviewSessionReplacement(state: AppState, sourceExerciseId: string, selected: Exercise): SessionReplacementReview {
  parseState(state)
  const session = state.activeSession
  const source = session?.workout.exercises.find(exercise => exercise.id === sourceExerciseId)
  if (!session || !source) throw stale()
  const rows = session.sets.filter(set => set.exerciseId === source.id)
  const removedSets = rows.filter(set => !set.completed)
  if (!removedSets.length) throw new Error('There are no unfinished sets to replace for this exercise.')
  if (rows.length > 50) throw new Error('Replacement supports up to 50 session sets per exercise. No rows were changed.')
  const completedCount = rows.length - removedSets.length
  if (completedCount && session.workout.exercises.length >= 50) throw new Error('Keeping completed work and adding a replacement would exceed 50 exercises. No rows were changed.')
  // Validate the selected entry against the unchanged shared schema, including its 1–20 planned sets.
  parseState({ ...state, workouts: [{ ...session.workout, exercises: [selected] }] })
  const removedIds = new Set(removedSets.map(set => set.id))
  const groupImpacts = Object.freeze((session.grouping?.groups ?? []).flatMap(group => group.rounds.flatMap((round, index) => round.setIds.filter(id => removedIds.has(id)).map(setId => Object.freeze({ groupId: group.id, groupName: group.name, roundId: round.id, roundNumber: index + 1, setId })))))
  const review = Object.freeze({
    source: freezeExercise(source), replacement: freezeExercise(selected),
    removedSets: Object.freeze(removedSets.map(set => Object.freeze(structuredClone(set)))), completedCount, groupImpacts,
  })
  sources.set(review, { session, snapshot: JSON.stringify(session) })
  return review
}

/** Uses the current transactional state, never a captured candidate result. */
export function applySessionReplacement(state: AppState, review: SessionReplacementReview, makeId: () => string = uid): AppState {
  const expected = sources.get(review)
  const session = state.activeSession
  if (!expected || session !== expected.session || JSON.stringify(session) !== expected.snapshot) throw stale()
  // Recheck capacity and schema at application time; no partial state is returned on failure.
  reviewSessionReplacement(state, review.source.id, review.replacement)
  const reserved = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('Id')) && typeof child === 'string') reserved.add(child)
      else if (key.endsWith('Ids') && Array.isArray(child)) child.forEach(id => reserved.add(id))
      else collect(child)
    }
  }
  collect(state); reserved.add(review.replacement.id)
  const freshId = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = makeId()
      if (typeof id === 'string' && id.trim() && id.length <= 150 && !reserved.has(id)) { reserved.add(id); return id }
    }
    throw new Error('Could not create distinct replacement identities. No rows were changed; try again.')
  }
  const replacement: Exercise = { ...review.replacement, id: freshId() }
  const setIdMap = new Map<string, string>()
  const freshSets: ExerciseSet[] = review.removedSets.map((old, index) => {
    const id = freshId(); setIdMap.set(old.id, id)
    return { id, exerciseId: replacement.id, setNumber: index + 1, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false }
  })
  const removedIds = new Set(review.removedSets.map(set => set.id))
  const exercises = session.workout.exercises.flatMap(exercise => exercise.id !== review.source.id ? [exercise] : review.completedCount ? [exercise, replacement] : [replacement])
  const grouping = session.grouping === undefined ? {} : { grouping: { ...session.grouping, groups: session.grouping.groups.map(group => ({ ...group, rounds: group.rounds.map(round => ({ ...round, setIds: round.setIds.map(id => setIdMap.get(id) ?? id) })) })) } }
  const next: AppState = { ...state, activeSession: structuredClone({ ...session, ...grouping, workout: { ...session.workout, exercises }, sets: [...session.sets.filter(set => !removedIds.has(set.id)), ...freshSets] }) }
  parseState(next)
  return next
}
