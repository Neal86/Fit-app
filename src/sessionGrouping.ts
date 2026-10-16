import { uid } from './session'
import { parseState } from './stateValidation'
import { denseArray } from './sessionGroupingValidation'
import type { ActiveSession, AppState, Exercise, ExerciseSet, SessionGroup } from './types'

export type SessionGroupingSelection = { name: string; restSeconds: number; rounds: string[][] }
export type SessionGroupingReviewRow = Readonly<{ set: Readonly<ExerciseSet>; exercise: Readonly<Exercise> }>
export type SessionGroupingReviewRound = Readonly<{ setIds: readonly string[]; rows: readonly SessionGroupingReviewRow[] }>
export type SessionGroupingReview = Readonly<{
  name: string; restSeconds: number; rounds: readonly SessionGroupingReviewRound[]; remainingUngroupedSetCount: number
}>
export type FrozenSessionGroup = Readonly<Omit<SessionGroup, 'rounds'> & { rounds: readonly Readonly<{ id: string; setIds: readonly string[] }>[] }>
export type SessionGroupRemovalReview = Readonly<{ group: FrozenSessionGroup; rounds: readonly SessionGroupingReviewRound[] }>
const sources = new WeakMap<object, { session: ActiveSession; snapshot: string }>()
const stale = () => new Error('This session changed. Cancel and review the grouping again.')
const freezeExercise = (exercise: Exercise) => {
  const copy = structuredClone(exercise)
  if (copy.equipment !== undefined) Object.freeze(copy.equipment)
  return Object.freeze(copy)
}
function snapshotRounds(session: ActiveSession, rounds: readonly { setIds: readonly string[] }[]): readonly SessionGroupingReviewRound[] {
  return Object.freeze(rounds.map(round => Object.freeze({
    setIds: Object.freeze([...round.setIds]),
    rows: Object.freeze(round.setIds.map(setId => {
      const set = session.sets.find(set => set.id === setId)!
      return Object.freeze({ set: Object.freeze(structuredClone(set)), exercise: freezeExercise(session.workout.exercises.find(exercise => exercise.id === set.exerciseId)!) })
    })),
  })))
}
function bind<T extends object>(review: T, session: ActiveSession): T {
  sources.set(review, { session, snapshot: JSON.stringify(session) })
  return review
}
function currentSession(state: AppState, review: object): ActiveSession {
  const source = sources.get(review)
  if (!source || state.activeSession !== source.session || JSON.stringify(state.activeSession) !== source.snapshot) throw stale()
  parseState(state)
  return source.session
}

export function reviewSessionGrouping(state: AppState, selection: SessionGroupingSelection): SessionGroupingReview {
  parseState(state)
  const session = state.activeSession
  if (!session) throw stale()
  if (!selection || typeof selection !== 'object' || Object.keys(selection).length !== 3 || !['name', 'restSeconds', 'rounds'].every(key => Object.hasOwn(selection, key)) || typeof selection.name !== 'string' || !selection.name.trim() || selection.name.trim().length > 80 || !Number.isInteger(selection.restSeconds) || selection.restSeconds < 0 || selection.restSeconds > 900 || !denseArray(selection.rounds, 1, 50)) throw new Error('Choose a name of 1–80 characters, 0–900 seconds of rest and 1–50 exact rounds.')
  if ((session.grouping?.groups.length ?? 0) >= 25) throw new Error('A session supports at most 25 groups.')
  const grouped = new Set(session.grouping?.groups.flatMap(group => group.rounds.flatMap(round => round.setIds)) ?? [])
  const selected = new Set<string>()
  let movementOrder: string[] | undefined
  for (const round of selection.rounds) {
    if (!denseArray(round, 2, 6)) throw new Error('Each round must explicitly select 2–6 distinct movements.')
    const movements: string[] = []
    for (const setId of round) {
      const row = session.sets.find(set => set.id === setId)
      if (!row || row.completed || row.warmup || grouped.has(row.id) || selected.has(row.id)) throw new Error('Select each existing unfinished, non-warm-up, ungrouped set only once.')
      movements.push(row.exerciseId); selected.add(row.id)
    }
    if (new Set(movements).size !== movements.length || movementOrder && (movements.length !== movementOrder.length || movements.some((id, index) => movementOrder![index] !== id))) throw new Error('Choose the same distinct movements in the same order for every round.')
    movementOrder = movements
  }
  return bind(Object.freeze({
    name: selection.name.trim(), restSeconds: selection.restSeconds,
    rounds: snapshotRounds(session, selection.rounds.map(setIds => ({ setIds }))),
    remainingUngroupedSetCount: session.sets.filter(set => !grouped.has(set.id) && !selected.has(set.id)).length,
  }), session)
}

/** Pure candidate construction: only the caller's successful transaction commits it. */
export function applySessionGrouping(state: AppState, review: SessionGroupingReview, makeId: () => string = uid): AppState {
  const session = currentSession(state, review)
  reviewSessionGrouping(state, { name: review.name, restSeconds: review.restSeconds, rounds: review.rounds.map(round => [...round.setIds]) })
  const reserved = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('Id')) && typeof child === 'string') reserved.add(child)
      else if (key.endsWith('Ids') && Array.isArray(child)) child.forEach(id => { if (typeof id === 'string') reserved.add(id) })
      else collect(child)
    }
  }
  collect(state)
  const freshId = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = makeId()
      if (typeof id === 'string' && id.trim() && id.length <= 150 && !reserved.has(id)) { reserved.add(id); return id }
    }
    throw new Error('Could not create distinct grouping identities. No rows were changed; try again.')
  }
  const group: SessionGroup = { id: freshId(), name: review.name, restSeconds: review.restSeconds, rounds: review.rounds.map(round => ({ id: freshId(), setIds: [...round.setIds] })) }
  const next: AppState = { ...state, activeSession: structuredClone({ ...session, grouping: { version: 1 as const, groups: [...session.grouping?.groups ?? [], group] } }) }
  parseState(next)
  return next
}

export function reviewSessionGroupRemoval(state: AppState, groupId: string): SessionGroupRemovalReview {
  parseState(state)
  const session = state.activeSession
  const group = session?.grouping?.groups.find(group => group.id === groupId)
  if (!session || !group) throw stale()
  const members = new Set(group.rounds.flatMap(round => round.setIds))
  if (session.sets.some(set => members.has(set.id) && set.completed)) throw new Error('Undo every currently completed set in this group before removing its grouping.')
  const copy = structuredClone(group)
  for (const round of copy.rounds) { Object.freeze(round.setIds); Object.freeze(round) }
  Object.freeze(copy.rounds); Object.freeze(copy)
  return bind(Object.freeze({ group: copy, rounds: snapshotRounds(session, group.rounds) }), session)
}
export function applySessionGroupRemoval(state: AppState, review: SessionGroupRemovalReview): AppState {
  const session = currentSession(state, review)
  reviewSessionGroupRemoval(state, review.group.id)
  const activeSession = structuredClone(session)
  const groups = activeSession.grouping!.groups.filter(group => group.id !== review.group.id)
  if (groups.length) activeSession.grouping = { version: 1, groups }
  else delete activeSession.grouping
  const next = { ...state, activeSession }
  parseState(next)
  return next
}
