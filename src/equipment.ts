// User-supplied categories only: these do not establish exercise safety or exact machine fit.
export const EQUIPMENT_OPTIONS = [
  { id: 'barbell', label: 'Barbell' },
  { id: 'weight-plates', label: 'Weight plates' },
  { id: 'dumbbells', label: 'Dumbbells' },
  { id: 'kettlebell', label: 'Kettlebell' },
  { id: 'resistance-bands', label: 'Resistance bands' },
  { id: 'cable-machine', label: 'Cable machine' },
  { id: 'weight-machine', label: 'Weight machine' },
  { id: 'bench', label: 'Bench' },
  { id: 'squat-rack', label: 'Squat rack' },
  { id: 'pull-up-bar', label: 'Pull-up bar' },
  { id: 'step-platform', label: 'Step platform' },
  { id: 'stability-ball', label: 'Stability ball' },
  { id: 'exercise-mat', label: 'Exercise mat' },
  { id: 'stationary-bike', label: 'Stationary bike' },
  { id: 'treadmill', label: 'Treadmill' },
  { id: 'rower', label: 'Rower' },
  { id: 'elliptical', label: 'Elliptical' },
] as const

export type EquipmentId = typeof EQUIPMENT_OPTIONS[number]['id']
const supported = new Set<string>(EQUIPMENT_OPTIONS.map(option => option.id))

export function isEquipmentList(value: unknown): value is EquipmentId[] {
  return Array.isArray(value) && value.length <= EQUIPMENT_OPTIONS.length &&
    Array.from(value).every((id, index) => Object.prototype.hasOwnProperty.call(value, index) && typeof id === 'string' && supported.has(id)) &&
    new Set(value).size === value.length
}

// Every listed category is required. Unknown requirements never count as a match.
export function equipmentMatch(requirements: readonly EquipmentId[] | undefined, available: readonly EquipmentId[]): { status: 'unknown' | 'missing' | 'matched'; missing: EquipmentId[] } {
  if (!isEquipmentList(requirements) || !isEquipmentList(available)) return { status: 'unknown', missing: [] }
  const missing = EQUIPMENT_OPTIONS.filter(option => requirements.includes(option.id) && !available.includes(option.id)).map(option => option.id)
  return { status: missing.length ? 'missing' : 'matched', missing }
}

export function equipmentSummary(requirements: readonly EquipmentId[] | undefined): string {
  if (!isEquipmentList(requirements)) return 'Equipment not specified'
  if (!requirements.length) return 'No equipment'
  return EQUIPMENT_OPTIONS.filter(option => requirements.includes(option.id)).map(option => option.label).join(', ')
}
