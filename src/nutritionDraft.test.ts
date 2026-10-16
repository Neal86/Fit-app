// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { clearNutritionDraft, MAX_NUTRITION_DRAFT_BYTES, NUTRITION_DRAFT_KEY, parseNutritionDraft, readNutritionDraft, saveNutritionDraft, type NutritionDraft } from './nutritionDraft'
import type { MealEntry } from './nutrition'

const meal: MealEntry = { id: 'meal-1', date: '2026-10-15', mealType: 'Lunch', foodName: 'Food', serving: '1 serving', calories: 100, protein: 10, carbs: 10, fat: 1 }
const draft = (): NutritionDraft => ({ version: 1, date: '2026-10-15', editor: { kind: 'meal', id: 'meal-1', original: null, initial: { date: '2026-10-15', mealType: 'Lunch', foodName: '', serving: '', calories: '', protein: '', carbs: '', fat: '' }, form: { date: '', mealType: 'Lunch', foodName: 'Unfinished', serving: '', calories: '-', protein: '12x', carbs: '-1', fat: 'Infinity' } } })
beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('bounded nutrition drafts', () => {
  it('starts without a draft and round-trips incomplete text without treating it as saved data', () => {
    expect(readNutritionDraft()).toEqual({ draft: null, error: '' })
    saveNutritionDraft(draft())
    const result = readNutritionDraft()
    expect(result.error).toBe('')
    expect(result.draft).toEqual(draft())
    expect(result.draft?.editor?.form).toMatchObject({ date: '', calories: '-', protein: '12x', carbs: '-1', fat: 'Infinity' })
  })
  it('keeps the selected date with no open draft and can clear both for app restore/reset', () => {
    saveNutritionDraft({ version: 1, date: '2026-10-14', editor: null })
    expect(readNutritionDraft().draft?.date).toBe('2026-10-14')
    expect(clearNutritionDraft()).toBe(true)
    expect(sessionStorage.getItem(NUTRITION_DRAFT_KEY)).toBeNull()
  })
  it('returns isolated clones from parsed records', () => {
    const original = draft(); const parsed = parseNutritionDraft(original)
    if (parsed.editor?.kind === 'meal') parsed.editor.form.foodName = 'Changed'
    expect(original.editor?.form).toHaveProperty('foodName', 'Unfinished')
  })
  it.each(['{broken', 'null', '[]', '{"version":99}', '"text"'])('retains malformed stored bytes and reports failure: %s', source => {
    sessionStorage.setItem(NUTRITION_DRAFT_KEY, source)
    expect(readNutritionDraft()).toMatchObject({ draft: null, error: expect.stringContaining('could not restore') })
    expect(sessionStorage.getItem(NUTRITION_DRAFT_KEY)).toBe(source)
  })
  it('rejects an oversized stored draft before parsing and keeps the original bytes', () => {
    const source = ' '.repeat(MAX_NUTRITION_DRAFT_BYTES + 1)
    sessionStorage.setItem(NUTRITION_DRAFT_KEY, source)
    expect(readNutritionDraft().draft).toBeNull()
    expect(readNutritionDraft().error).not.toBe('')
    expect(sessionStorage.getItem(NUTRITION_DRAFT_KEY)).toBe(source)
  })
  it('rejects unknown keys, invalid dates, numeric form values, overlong strings and missing fields', () => {
    const valid = draft(); const editor = valid.editor!
    for (const value of [{ ...valid, extra: true }, { ...valid, date: '2026-02-30' }, { ...valid, editor: { ...editor, extra: true } }, { ...valid, editor: { ...editor, form: { ...editor.form, calories: 10 } } }, { ...valid, editor: { ...editor, form: { ...editor.form, calories: '1'.repeat(101) } } }, { ...valid, editor: { ...editor, form: { ...editor.form, foodName: 'x'.repeat(151) } } }, { ...valid, editor: { ...editor, form: {} } }]) expect(() => parseNutritionDraft(value)).toThrow()
  })
  it('validates the original saved snapshot and keeps its identity for stale-value protection', () => {
    const valid = draft(); const editor = valid.editor!
    expect(parseNutritionDraft({ ...valid, editor: { ...editor, original: meal } }).editor?.original).toEqual(meal)
    for (const original of [{ ...meal, id: 'other' }, { ...meal, calories: Infinity }, { ...meal, date: 'bad' }, { ...meal, extra: true }]) expect(() => parseNutritionDraft({ ...valid, editor: { ...editor, original } })).toThrow()
  })
  it('validates water and target forms while preserving incomplete values and original targets', () => {
    const water = { date: '', milliliters: '-', note: '' }
    expect(parseNutritionDraft({ version: 1, date: '2026-10-15', editor: { kind: 'water', id: 'water-1', original: null, initial: water, form: water } }).editor?.kind).toBe('water')
    const target = { calories: '', protein: '', carbs: 'abc', fat: '-1', milliliters: '0' }
    const original = { date: '2026-10-15', calories: 1000, protein: 0, carbs: 0, fat: 0, milliliters: 0 }
    const value = { version: 1, date: '2026-10-15', editor: { kind: 'targets', original, initial: target, form: target } }
    expect(parseNutritionDraft(value).editor?.original).toEqual(original)
    expect(() => parseNutritionDraft({ ...value, date: '2026-10-14' })).toThrow()
  })
  it('throws before touching the existing draft when a requested write is malformed', () => {
    saveNutritionDraft(draft()); const source = sessionStorage.getItem(NUTRITION_DRAFT_KEY)
    expect(() => saveNutritionDraft({ ...draft(), date: 'bad' })).toThrow()
    expect(sessionStorage.getItem(NUTRITION_DRAFT_KEY)).toBe(source)
  })
  it('reports read/write/clear storage failures instead of claiming persistence', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readNutritionDraft()).toMatchObject({ draft: null, error: expect.stringContaining('could not restore') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveNutritionDraft(draft())).toThrow('quota')
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    expect(clearNutritionDraft()).toBe(false)
  })
})
