// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EQUIPMENT_OPTIONS, equipmentMatch, isEquipmentList, type EquipmentId } from './equipment'
import { exerciseCatalog } from './exerciseCatalog'
import { freshState, parseBackup, parseState, saveState, STORAGE_KEY } from './storage'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import { schedulePreview, savePlanRevision, restorePlanRevision } from './planning'
import { finishSession, startSession } from './session'
import type { Exercise } from './types'

afterEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('independent equipment adversarial review', () => {
  it('keeps the exact closed 17-category vocabulary and every individual match semantics', () => {
    const expected = ['barbell', 'weight-plates', 'dumbbells', 'kettlebell', 'resistance-bands', 'cable-machine', 'weight-machine', 'bench', 'squat-rack', 'pull-up-bar', 'step-platform', 'stability-ball', 'exercise-mat', 'stationary-bike', 'treadmill', 'rower', 'elliptical']
    expect(EQUIPMENT_OPTIONS.map(option => option.id)).toEqual(expected)
    for (const option of EQUIPMENT_OPTIONS) {
      expect(equipmentMatch([option.id], [])).toMatchObject({ status: 'missing', missing: [option.id] })
      expect(equipmentMatch([option.id], [option.id])).toMatchObject({ status: 'matched', missing: [] })
    }
    expect(equipmentMatch(undefined, [])).toMatchObject({ status: 'unknown' })
    expect(equipmentMatch([], [])).toMatchObject({ status: 'matched' })
    expect(equipmentMatch(['barbell', 'weight-plates', 'bench'], ['barbell', 'bench'])).toMatchObject({ status: 'missing', missing: ['weight-plates'] })
  })

  it('rejects malformed metadata in every full-workout persistence boundary without overwriting storage', () => {
    const rejected: unknown[] = [null, {}, 'barbell', [null], [undefined], ['Barbell'], ['trap-bar'], ['barbell', 'barbell'], Array(1), new Array(18).fill('barbell')]
    for (const value of rejected) {
      expect(isEquipmentList(value)).toBe(false)
      for (const destination of ['plan', 'active', 'history']) {
        const state = freshState()
        state.activeSession = startSession(state.workouts[0])
        state.planHistory = [{ id: 'prior', savedAt: '2026-10-15T12:00:00Z', label: 'Prior', workouts: structuredClone(state.workouts) }]
        const exercise = destination === 'plan' ? state.workouts[0].exercises[0] : destination === 'active' ? state.activeSession.workout.exercises[0] : state.planHistory[0].workouts[0].exercises[0]
        exercise.equipment = value as EquipmentId[]
        localStorage.setItem(STORAGE_KEY, 'untouched')
        expect(() => parseState(state)).toThrow()
        expect(() => parseBackup(JSON.stringify(state))).toThrow()
        expect(() => saveState(state)).toThrow()
        expect(localStorage.getItem(STORAGE_KEY)).toBe('untouched')
      }
    }
  })

  it('keeps unknown legacy metadata absent through backup/draft and preserves explicit none', () => {
    for (const version of [2, 3, 4]) {
      const raw = { ...freshState(), version }
      const parsed = parseState(raw)
      expect(parsed.version).toBe(4)
      expect(parsed.workouts.every(workout => workout.exercises.every(exercise => !Object.hasOwn(exercise, 'equipment')))).toBe(true)
    }
    const workout = freshState().workouts[0]
    workout.exercises[1].equipment = []
    savePlanDraft(workout)
    expect(readPlanDraft()).toEqual(workout)
    expect(readPlanDraft()!.exercises[1]).toHaveProperty('equipment', [])
    workout.exercises[1].equipment = ['dumbbells', 'bench']
    savePlanDraft(workout)
    expect(readPlanDraft()).toEqual(workout)
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify({ ...workout, exercises: [{ ...workout.exercises[0], equipment: ['invalid'] }] }))
    expect(readPlanDraft()).toBeNull()
  })

  it('preserves catalog set equivalence and distinguishes unknown, none, and known requirements', () => {
    const workout = freshState().workouts[0]
    const base: Exercise = { ...workout.exercises[0], name: 'Synthetic movement' }
    workout.exercises = [base, { ...base, id: 'none', equipment: [] }, { ...base, id: 'known', equipment: ['barbell', 'bench'] }, { ...base, id: 'reordered', equipment: ['bench', 'barbell'] }]
    const entries = exerciseCatalog([workout]).filter(entry => entry.exercise.name === base.name)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.key)).size).toBe(3)
    entries.find(entry => entry.exercise.equipment?.length)!.exercise.equipment!.push('weight-plates')
    expect(workout.exercises[2].equipment).toEqual(['barbell', 'bench'])
  })

  it('deep-copies nested metadata in every scheduled duplicate and archived plan', () => {
    const state = freshState()
    state.workouts[0].exercises[0].equipment = ['barbell', 'bench']
    const previews = schedulePreview(state.workouts, [{ day: 'Monday', workoutId: state.workouts[0].id }, { day: 'Wednesday', workoutId: state.workouts[0].id }], 60)
    previews[1].exercises[0].equipment!.push('weight-plates')
    expect(state.workouts[0].exercises[0].equipment).toEqual(['barbell', 'bench'])
    expect(previews[0].exercises[0].equipment).toEqual(['barbell', 'bench'])
    const saved = savePlanRevision(state, previews, 'Scheduled')
    expect(saved.planHistory[0].workouts[0].exercises[0].equipment).toEqual(['barbell', 'bench'])
    const restored = restorePlanRevision(saved, saved.planHistory[0].id)
    expect(restored.workouts).toEqual(state.workouts)
    restored.workouts[0].exercises[0].equipment!.push('dumbbells')
    expect(saved.planHistory[0].workouts[0].exercises[0].equipment).toEqual(['barbell', 'bench'])
  })

  it('retains requirements in active sessions but completed log schema stays exactly unchanged', () => {
    const state = freshState()
    state.workouts[0].exercises[0].equipment = ['barbell', 'bench']
    const session = startSession(state.workouts[0], 0)
    session.sets[0].completed = true
    expect(session.workout.exercises[0].equipment).toEqual(['barbell', 'bench'])
    const log = finishSession(session, 1000)
    expect(log.exerciseSnapshots!.every(exercise => Object.keys(exercise).sort().join() === 'category,id,name')).toBe(true)
    const invalid = { ...log, exerciseSnapshots: [{ ...log.exerciseSnapshots![0], equipment: [] }] }
    expect(() => parseState({ ...state, logs: [invalid] })).toThrow()
  })
})
