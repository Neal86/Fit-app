import type { Profile } from './types'

export type UnitSystem = Profile['unit']
export type Measurement = 'weight' | 'height' | 'load'
export const KG_PER_LB = 0.45359237
export const CM_PER_IN = 2.54
const limits = { weight: [30, 300], height: [120, 230], load: [0, 1000] } as const
const factor = (kind: Measurement, unit: UnitSystem) => unit === 'metric' ? 1 : kind === 'height' ? CM_PER_IN : KG_PER_LB
export const measurementUnit = (kind: Measurement, unit: UnitSystem) => kind === 'height' ? unit === 'metric' ? 'cm' : 'in' : unit === 'metric' ? 'kg' : 'lb'
export const displayMeasurement = (canonical: number, kind: Measurement, unit: UnitSystem) => canonical / factor(kind, unit)
export const formatMeasurement = (canonical: number, kind: Measurement, unit: UnitSystem) => displayMeasurement(canonical, kind, unit).toLocaleString(undefined, { maximumFractionDigits: 2 })
export function measurementRange(kind: Measurement, unit: UnitSystem) {
  const [min, max] = limits[kind]
  const range = `${formatMeasurement(min, kind, unit)}–${formatMeasurement(max, kind, unit)} ${measurementUnit(kind, unit)}`
  return unit === 'metric' ? range : `about ${range} (${min}–${max} ${measurementUnit(kind, 'metric')})`
}

/** Text is deliberately independent of canonical storage. Rounded displays are never
 * parsed back for unchanged fields, including after repeated preference switches. */
export type MeasurementDraft = { source: number | null; canonical: number | null; text: string; initialText: string; unit: UnitSystem }
export function measurementDraft(canonical: number | null, kind: Measurement, unit: UnitSystem): MeasurementDraft {
  const text = canonical === null ? '' : String(Number(displayMeasurement(canonical, kind, unit).toFixed(2)))
  return { source: canonical, canonical, text, initialText: text, unit }
}
export function readMeasurement(draft: MeasurementDraft, kind: Measurement): number | null {
  const text = draft.text.trim()
  if (kind === 'load' && text === '') return null // No external load, distinct from explicit zero.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(`Enter ${kind === 'height' ? 'a height' : 'a weight'} from ${measurementRange(kind, draft.unit)}.${kind === 'load' ? ' Leave blank for bodyweight.' : ''}`)
  const input = Number(text)
  const canonical = draft.initialText !== '' && input === Number(draft.initialText) ? draft.canonical : input * factor(kind, draft.unit)
  const [min, max] = limits[kind]
  // Only compensate for IEEE-754 noise at an exact converted endpoint, not display rounding.
  const epsilon = Number.EPSILON * Math.max(1, max) * 4
  if (canonical === null || !Number.isFinite(canonical) || canonical < min - epsilon || canonical > max + epsilon) throw new Error(`Enter ${kind === 'height' ? 'a height' : 'a weight'} from ${measurementRange(kind, draft.unit)}.`)
  return Math.max(min, Math.min(max, canonical))
}
export function switchMeasurement(draft: MeasurementDraft, kind: Measurement, unit: UnitSystem): MeasurementDraft {
  if (draft.unit === unit) return draft
  return { ...measurementDraft(readMeasurement(draft, kind), kind, unit), source: draft.source }
}
/** External source changes discard stale drafts. A preference change converts a
 * valid draft once; invalid partial text stays clearly labelled in its entry unit. */
export function syncMeasurement(draft: MeasurementDraft, canonical: number | null, kind: Measurement, unit: UnitSystem): MeasurementDraft {
  if (draft.source !== canonical) return measurementDraft(canonical, kind, unit)
  try { return switchMeasurement(draft, kind, unit) } catch { return draft }
}
