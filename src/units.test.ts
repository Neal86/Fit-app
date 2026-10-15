import { describe, expect, it } from 'vitest'
import { CM_PER_IN, displayMeasurement, formatMeasurement, KG_PER_LB, measurementDraft, measurementRange, readMeasurement, switchMeasurement, syncMeasurement } from './units'
import type { Measurement, UnitSystem } from './units'

const input = (text: string, kind: Measurement = 'weight', unit: UnitSystem = 'imperial') => ({ ...measurementDraft(kind === 'load' ? null : kind === 'height' ? 178 : 72, kind, unit), text })
describe('canonical measurement conversions and decimal drafts', () => {
  it('uses exact international pound and inch definitions', () => {
    expect(readMeasurement(input('100'), 'weight')).toBe(100 * KG_PER_LB)
    expect(readMeasurement(input('70', 'height'), 'height')).toBe(70 * CM_PER_IN)
    expect(formatMeasurement(100 * KG_PER_LB, 'weight', 'imperial')).toBe('100')
    expect(displayMeasurement(254, 'height', 'imperial')).toBe(100)
    expect(measurementRange('weight', 'imperial')).toContain('66.14–661.39 lb (30–300 kg)')
  })
  it.each([
    ['weight', 30], ['weight', 300], ['weight', 72.123456789],
    ['height', 120], ['height', 230], ['height', 178.987654321],
    ['load', 0], ['load', 1000], ['load', 37.123456789],
  ] as [Measurement, number][])('preserves untouched %s %s and repeated toggles exactly', (kind, canonical) => {
    let draft = measurementDraft(canonical, kind, 'imperial')
    expect(readMeasurement(draft, kind)).toBe(canonical)
    expect(readMeasurement({ ...draft, text: `${draft.text}0`.replace(/^(\d+)0$/, '$1.0') }, kind)).toBe(canonical)
    for (let index = 0; index < 100; index++) {
      draft = switchMeasurement(draft, kind, 'metric')
      expect(readMeasurement(draft, kind)).toBe(canonical)
      draft = switchMeasurement(draft, kind, 'imperial')
      expect(readMeasurement(draft, kind)).toBe(canonical)
    }
  })
  it.each([['weight', 30], ['weight', 300], ['height', 120], ['height', 230], ['load', 1000]] as [Measurement, number][])('accepts precise converted %s endpoint %s', (kind, canonical) => {
    expect(readMeasurement(input(String(displayMeasurement(canonical, kind, 'imperial')), kind), kind)).toBeCloseTo(canonical, 12)
  })
  it.each(['', ' ', '.', '-', '-1', 'NaN', 'Infinity', '1e2', '0x50', '1,000', '75abc', '0', '29.999999', '300.000001'])('rejects invalid metric body-weight text %j', text => {
    expect(() => readMeasurement(input(text, 'weight', 'metric'), 'weight')).toThrow('30–300 kg')
  })
  it('rejects out-of-range imperial values without rounding them into bounds', () => {
    for (const [kind, min, max] of [['weight', 30, 300], ['height', 120, 230], ['load', 0, 1000]] as [Measurement, number, number][]) {
      for (const canonical of [min - 0.000001, max + 0.000001]) {
        expect(() => readMeasurement(input(String(displayMeasurement(canonical, kind, 'imperial')), kind), kind)).toThrow()
      }
    }
    expect(() => readMeasurement(input('661.39'), 'weight')).toThrow()
    expect(() => readMeasurement(input('2204.63', 'load'), 'load')).toThrow()
  })
  it('distinguishes blank load, explicit zero and invalid load', () => {
    expect(readMeasurement(input('', 'load'), 'load')).toBeNull()
    expect(readMeasurement(input('0', 'load'), 'load')).toBe(0)
    for (const text of ['.', '-1', 'Infinity', 'NaN']) expect(() => readMeasurement(input(text, 'load'), 'load')).toThrow()
  })
  it('retains raw decimal editing and converts only at an explicit switch', () => {
    const draft = input('160.')
    expect(readMeasurement(draft, 'weight')).toBe(160 * KG_PER_LB)
    expect(draft.text).toBe('160.')
    let switched = switchMeasurement(draft, 'weight', 'metric')
    expect(readMeasurement(switched, 'weight')).toBe(160 * KG_PER_LB)
    switched = switchMeasurement(switched, 'weight', 'imperial')
    expect(switched.text).toBe('160')
    expect(readMeasurement(switched, 'weight')).toBe(160 * KG_PER_LB)
  })
  it('keeps invalid partial text in its original unit, but invalidates changed source values', () => {
    const draft = input('.')
    expect(syncMeasurement(draft, 72, 'weight', 'metric')).toBe(draft)
    const replaced = syncMeasurement(draft, 80, 'weight', 'metric')
    expect(replaced.text).toBe('80')
    expect(replaced.unit).toBe('metric')
  })
})
