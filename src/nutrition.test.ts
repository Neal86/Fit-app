import { describe, expect, it, vi } from 'vitest'
import {
  createNutritionId, createNutritionState, deleteHydrationEntry, deleteMealEntry, emptyDailyTargets,
  isNutritionDate, MAX_NUTRITION_DATE, MIN_NUTRITION_DATE, NUTRITION_LIMITS, nutritionHistoryDates,
  nutritionTotals, parseNutritionNumber, parseNutritionState, saveDailyTargets, saveHydrationEntry,
  saveMealEntry, shiftNutritionDate, type HydrationEntry, type MealEntry,
} from './nutrition'

const meal = (overrides: Partial<MealEntry> = {}): MealEntry => ({ id: 'meal-1', date: '2026-10-15', mealType: 'Lunch', foodName: 'User-entered food', serving: '1 serving', calories: 123.4, protein: 10.1, carbs: 20.2, fat: 3.3, ...overrides })
const water = (overrides: Partial<HydrationEntry> = {}): HydrationEntry => ({ id: 'water-1', date: '2026-10-15', milliliters: 250, note: '', ...overrides })

describe('nutrition parsing and legacy defaults', () => {
  it('defaults only absent legacy nutrition, without sharing mutable arrays', () => {
    const a = parseNutritionState(undefined); a.meals.push(meal())
    expect(parseNutritionState(undefined)).toEqual(createNutritionState())
    expect(() => parseNutritionState(null)).toThrow()
    expect(() => parseNutritionState({})).toThrow()
  })
  it('round-trips validated data as an isolated copy and never mutates the input', () => {
    const state = { ...createNutritionState(), meals: [meal()], hydration: [water()], targets: [emptyDailyTargets('2026-10-15')] }
    const parsed = parseNutritionState(JSON.parse(JSON.stringify(state)))
    expect(parsed).toEqual(state)
    parsed.meals[0].foodName = 'Edited'
    expect(state.meals[0].foodName).toBe('User-entered food')
  })
  it.each([NaN, Infinity, -Infinity, -1, NUTRITION_LIMITS.calories + 1, '100', null, undefined])('rejects invalid calories %s', calories => {
    expect(() => parseNutritionState({ ...createNutritionState(), meals: [{ ...meal(), calories }] })).toThrow()
  })
  it.each(['protein', 'carbs', 'fat'] as const)('bounds %s and rejects non-finite values', key => {
    for (const value of [-1, Infinity, NUTRITION_LIMITS.grams + 1, '10']) expect(() => parseNutritionState({ ...createNutritionState(), meals: [{ ...meal(), [key]: value }] })).toThrow()
  })
  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-01-32', '2026-00-00', '2026-1-01', '1899-12-31', '2201-01-01', 'invalid', '2026-10-15T00:00:00Z'])('rejects invalid date %s without native date exceptions', date => {
    expect(isNutritionDate(date)).toBe(false)
    expect(() => parseNutritionState({ ...createNutritionState(), meals: [meal({ date })] })).toThrow('Nutrition data')
  })
  it('accepts leap days and calendar range boundaries', () => {
    expect(isNutritionDate('2024-02-29')).toBe(true)
    expect(isNutritionDate(MIN_NUTRITION_DATE)).toBe(true)
    expect(isNutritionDate(MAX_NUTRITION_DATE)).toBe(true)
  })
  it('requires explicit food values, source amount, valid type, bounded text and stable IDs', () => {
    for (const patch of [{ foodName: ' ' }, { foodName: 'a'.repeat(151) }, { serving: '' }, { serving: 'a'.repeat(201) }, { mealType: 'Brunch' }, { id: '' }, { id: 'invalid id' }, { id: 'a'.repeat(151) }, { calories: undefined }, { surprise: true }]) {
      expect(() => parseNutritionState({ ...createNutritionState(), meals: [{ ...meal(), ...patch }] })).toThrow()
    }
    expect(parseNutritionState({ ...createNutritionState(), meals: [meal({ calories: 0, protein: 0, carbs: 0, fat: 0 })] }).meals[0].calories).toBe(0)
  })
  it('requires positive, finite, bounded hydration and a string note', () => {
    for (const patch of [{ milliliters: 0 }, { milliliters: -1 }, { milliliters: Infinity }, { milliliters: 20001 }, { milliliters: '250' }, { note: null }, { note: 'a'.repeat(201) }, { date: '2026-02-30' }]) expect(() => parseNutritionState({ ...createNutritionState(), hydration: [{ ...water(), ...patch }] })).toThrow()
  })
  it('rejects duplicate IDs within meals, within hydration, and across both', () => {
    expect(() => parseNutritionState({ ...createNutritionState(), meals: [meal(), meal()] })).toThrow('unique IDs')
    expect(() => parseNutritionState({ ...createNutritionState(), hydration: [water(), water()] })).toThrow('unique IDs')
    expect(() => parseNutritionState({ ...createNutritionState(), meals: [meal()], hydration: [water({ id: 'meal-1' })] })).toThrow('unique IDs')
  })
  it('validates date-specific target uniqueness and each target field', () => {
    const target = emptyDailyTargets('2026-10-15')
    expect(() => parseNutritionState({ ...createNutritionState(), targets: [target, target] })).toThrow('one set')
    for (const patch of [{ date: 'bad' }, { calories: -1 }, { protein: Infinity }, { carbs: 10001 }, { fat: '20' }, { milliliters: 20001 }, { extra: 2 }]) expect(() => parseNutritionState({ ...createNutritionState(), targets: [{ ...target, ...patch }] })).toThrow()
  })
  it('rejects unsupported versions, unknown fields and excessive entry counts', () => {
    expect(() => parseNutritionState({ ...createNutritionState(), version: 2 })).toThrow()
    expect(() => parseNutritionState({ ...createNutritionState(), extra: true })).toThrow()
    expect(() => parseNutritionState({ ...createNutritionState(), meals: Array.from({ length: NUTRITION_LIMITS.entries + 1 }, (_, index) => meal({ id: `meal-${index}` })) })).toThrow()
  })
  it('rejects sparse arrays instead of accepting missing records', () => {
    for (const key of ['meals', 'hydration', 'targets']) expect(() => parseNutritionState({ ...createNutritionState(), [key]: new Array(1) })).toThrow('Nutrition data')
  })
  it('does not turn a blank required value into zero or accept non-finite form input', () => {
    for (const value of ['', ' ', 'Infinity', 'NaN', '-1', '1001', '0x10', '0b10', '12x', '-']) expect(() => parseNutritionNumber(value, 'Value', 1000)).toThrow()
    expect(parseNutritionNumber('0', 'Value', 1000)).toBe(0)
    expect(parseNutritionNumber('0.5', 'Value', 1000)).toBe(0.5)
    expect(parseNutritionNumber('', 'Target', 1000, { optional: true })).toBe(0)
    expect(() => parseNutritionNumber('0', 'Water', 1000, { positive: true })).toThrow()
  })
})

describe('nutrition totals and diary operations', () => {
  it('sums only the selected date and rounds display totals without mutating source precision', () => {
    const state = { ...createNutritionState(), meals: [meal({ calories: 0.1 }), meal({ id: 'meal-2', calories: 0.2 }), meal({ id: 'other', date: '2026-10-14', calories: 999 })], hydration: [water(), water({ id: 'water-2', milliliters: 125.5 }), water({ id: 'water-other', date: '2026-10-14' })] }
    expect(nutritionTotals(state, '2026-10-15')).toEqual({ calories: 0.3, protein: 20.2, carbs: 40.4, fat: 6.6, milliliters: 375.5, mealCount: 2, hydrationCount: 2 })
    expect(nutritionTotals(state, '2026-10-16')).toEqual({ calories: 0, protein: 0, carbs: 0, fat: 0, milliliters: 0, mealCount: 0, hydrationCount: 0 })
    expect(state.meals[0].calories).toBe(0.1)
  })
  it('edits a same-day food entry in place without duplicates and supports moving dates', () => {
    const state = saveMealEntry(createNutritionState(), meal())
    const changed = saveMealEntry(state, meal({ calories: 200 }), meal())
    expect(changed.meals).toHaveLength(1)
    expect(changed.meals[0].id).toBe('meal-1')
    expect(nutritionTotals(changed, '2026-10-15').calories).toBe(200)
    const moved = saveMealEntry(changed, meal({ date: '2026-10-14', calories: 200 }), changed.meals[0])
    expect(nutritionTotals(moved, '2026-10-15').mealCount).toBe(0)
    expect(nutritionTotals(moved, '2026-10-14').calories).toBe(200)
    expect(state.meals[0].calories).toBe(123.4)
  })
  it('edits, moves and deletes water entries using stable IDs', () => {
    const initial = saveHydrationEntry(createNutritionState(), water())
    const changed = saveHydrationEntry(initial, water({ milliliters: 400, date: '2026-10-14' }), water())
    expect(changed.hydration).toEqual([water({ milliliters: 400, date: '2026-10-14' })])
    expect(nutritionTotals(changed, '2026-10-15').milliliters).toBe(0)
    expect(deleteHydrationEntry(changed, changed.hydration[0]).hydration).toEqual([])
  })
  it('rejects repeated add, stale save, ID replacement, stale delete and resurrecting removed entries', () => {
    const state = saveMealEntry(createNutritionState(), meal())
    expect(() => saveMealEntry(state, meal())).toThrow('changed or was removed')
    const changed = saveMealEntry(state, meal({ calories: 200 }), meal())
    expect(() => saveMealEntry(changed, meal({ calories: 300 }), meal())).toThrow('changed or was removed')
    expect(() => saveMealEntry(state, meal({ id: 'different' }), meal())).toThrow('ID cannot be changed')
    expect(() => deleteMealEntry(changed, meal())).toThrow('changed or was removed')
    const removed = deleteMealEntry(changed, changed.meals[0])
    expect(() => saveMealEntry(removed, meal(), meal())).toThrow('changed or was removed')
    expect(state.meals).toHaveLength(1)
  })
  it('protects repeated water adds, stale edits and deletes, and cross-kind ID collisions', () => {
    const state = saveHydrationEntry(createNutritionState(), water())
    expect(() => saveHydrationEntry(state, water())).toThrow()
    const changed = saveHydrationEntry(state, water({ milliliters: 500 }), water())
    expect(() => saveHydrationEntry(changed, water({ milliliters: 750 }), water())).toThrow()
    expect(() => deleteHydrationEntry(changed, water())).toThrow()
    expect(() => saveHydrationEntry(state, water({ id: 'new-id' }), water())).toThrow('ID cannot be changed')
    expect(() => saveMealEntry(state, meal({ id: 'water-1' }))).toThrow('unique IDs')
  })
  it('generates a duplicate-safe ID even if the UUID generator repeats', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111')
    try {
      const id = createNutritionId(createNutritionState())
      const state = { ...createNutritionState(), meals: [meal({ id })], hydration: [water({ id: `${id}-1` })] }
      expect(createNutritionId(state)).toBe(`${id}-2`)
    } finally { spy.mockRestore() }
  })
  it('stores targets for one date, treats zeros as unset, and preserves other dates', () => {
    const target = { ...emptyDailyTargets('2026-10-15'), calories: 1234, milliliters: 1500 }
    const first = saveDailyTargets(createNutritionState(), target)
    const other = { ...emptyDailyTargets('2026-10-14'), protein: 65 }
    const both = saveDailyTargets(first, other)
    expect(both.targets).toEqual([target, other])
    expect(() => saveDailyTargets(both, { ...target, calories: 1500 })).toThrow()
    const removed = saveDailyTargets(both, emptyDailyTargets(target.date), target)
    expect(removed.targets).toEqual([other])
    expect(saveDailyTargets(createNutritionState(), emptyDailyTargets('2026-10-15')).targets).toEqual([])
    expect(() => saveDailyTargets(first, { ...target, date: '2026-10-16' }, target)).toThrow('date cannot be changed')
  })
  it('lists unique recorded dates in newest-first order, including water-only and target-only days', () => {
    const state = { ...createNutritionState(), meals: [meal(), meal({ id: 'meal-2' })], hydration: [water({ date: '2026-10-13' })], targets: [emptyDailyTargets('2026-10-14')] }
    expect(nutritionHistoryDates(state)).toEqual(['2026-10-15', '2026-10-14', '2026-10-13'])
    expect(nutritionHistoryDates(createNutritionState())).toEqual([])
  })
  it('moves calendar dates across month, leap year and daylight-saving boundaries', () => {
    expect(shiftNutritionDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftNutritionDate('2024-02-29', 1)).toBe('2024-03-01')
    expect(shiftNutritionDate('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftNutritionDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(() => shiftNutritionDate('bad', 1)).toThrow()
    expect(() => shiftNutritionDate(MIN_NUTRITION_DATE, -1)).toThrow()
    expect(() => shiftNutritionDate(MAX_NUTRITION_DATE, 1)).toThrow()
  })
})
