import { describe, expect, it } from 'vitest'
import { EQUIPMENT_OPTIONS, equipmentMatch, equipmentSummary, isEquipmentList } from './equipment'
import type { EquipmentId } from './equipment'
import { freshState } from './storage'

describe('explicit equipment categories', () => {
  it('defines the closed categories in stable option order without classifying starter exercises', () => {
    expect(EQUIPMENT_OPTIONS.map(option => option.id)).toEqual([
      'barbell', 'weight-plates', 'dumbbells', 'kettlebell', 'resistance-bands', 'cable-machine', 'weight-machine', 'bench', 'squat-rack', 'pull-up-bar', 'step-platform', 'stability-ball', 'exercise-mat', 'stationary-bike', 'treadmill', 'rower', 'elliptical',
    ])
    expect(EQUIPMENT_OPTIONS.every(option => option.label.trim().length > 0)).toBe(true)
    expect(freshState().workouts.flatMap(workout => workout.exercises).every(exercise => !Object.hasOwn(exercise, 'equipment'))).toBe(true)
  })
  it('accepts zero to seventeen unique, dense supported IDs in any order', () => {
    expect(isEquipmentList([])).toBe(true)
    expect(isEquipmentList(['bench', 'barbell'])).toBe(true)
    expect(isEquipmentList(EQUIPMENT_OPTIONS.map(option => option.id))).toBe(true)
  })
  it.each([
    ['undefined', undefined], ['null', null], ['scalar', 'barbell'], ['object', { 0: 'barbell', length: 1 }],
    ['unknown ID', ['smith-machine']], ['wrong case', ['Barbell']], ['non-string', [1]],
    ['duplicate', ['bench', 'bench']], ['sparse', new Array(1)], ['sparse tail', Object.assign(new Array(2), { 0: 'bench' })],
    ['explicit undefined', [undefined]], ['more than seventeen', Array(18).fill('bench')],
  ])('rejects %s equipment metadata', (_label, value) => {
    expect(isEquipmentList(value)).toBe(false)
  })
  it('does not mistake inherited array values for dense own entries', () => {
    const sparse = new Array(1)
    Object.setPrototypeOf(sparse, { 0: 'bench', [Symbol.iterator]: Array.prototype[Symbol.iterator] })
    expect(isEquipmentList(sparse)).toBe(false)
  })
  it('keeps unknown and explicitly no-equipment requirements different', () => {
    expect(equipmentMatch(undefined, [])).toEqual({ status: 'unknown', missing: [] })
    expect(equipmentMatch(undefined, EQUIPMENT_OPTIONS.map(option => option.id))).toEqual({ status: 'unknown', missing: [] })
    expect(equipmentMatch([], [])).toEqual({ status: 'matched', missing: [] })
    expect(equipmentMatch([], ['barbell'])).toEqual({ status: 'matched', missing: [] })
  })
  it('requires every exact category and reports missing IDs in option order without mutating inputs', () => {
    const requirements: EquipmentId[] = ['bench', 'weight-plates', 'barbell']
    const available: EquipmentId[] = ['dumbbells', 'barbell']
    expect(equipmentMatch(requirements, available)).toEqual({ status: 'missing', missing: ['weight-plates', 'bench'] })
    expect(equipmentMatch(requirements, ['bench', 'barbell', 'weight-plates'])).toEqual({ status: 'matched', missing: [] })
    expect(equipmentMatch(['cable-machine'], ['weight-machine'])).toEqual({ status: 'missing', missing: ['cable-machine'] })
    expect(equipmentMatch(['barbell'], ['dumbbells'])).toEqual({ status: 'missing', missing: ['barbell'] })
    expect(requirements).toEqual(['bench', 'weight-plates', 'barbell'])
    expect(available).toEqual(['dumbbells', 'barbell'])
  })
  it('summarizes categories in option order while retaining the three meanings', () => {
    expect(equipmentSummary(undefined)).toBe('Equipment not specified')
    expect(equipmentSummary([])).toBe('No equipment')
    expect(equipmentSummary(['bench', 'barbell', 'weight-plates'])).toBe('Barbell, Weight plates, Bench')
  })
  it.each([null, ['unsupported'], ['bench', 'bench'], new Array(1)])('fails closed for malformed runtime helper arguments %j', invalid => {
    const value = invalid as unknown as EquipmentId[]
    expect(equipmentMatch(value, [])).toEqual({ status: 'unknown', missing: [] })
    expect(equipmentMatch([], value)).toEqual({ status: 'unknown', missing: [] })
    expect(equipmentMatch(['bench'], value)).toEqual({ status: 'unknown', missing: [] })
    expect(equipmentSummary(value)).toBe('Equipment not specified')
  })
})
