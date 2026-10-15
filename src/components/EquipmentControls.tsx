import { EQUIPMENT_OPTIONS, equipmentMatch, equipmentSummary } from '../equipment'
import type { EquipmentId } from '../equipment'
import type { Exercise } from '../types'
import './EquipmentControls.css'

export type EquipmentSelection = { enabled: boolean; available: EquipmentId[] }

type AvailableProps = { value: EquipmentSelection; onChange: (value: EquipmentSelection) => void }
export function AvailableEquipment({ value, onChange }: AvailableProps) {
  return <fieldset className="equipment-controls"><legend>Temporary available equipment</legend>
    <label className="equipment-check"><input type="checkbox" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />Compare with equipment available now</label>
    <p>This optional selection is only for this page. It starts off, resets when you leave, and is not saved in backups or cloud copies. Saved exercise requirements are included in backups and cloud copies.</p>
    {value.enabled && <><p>Select all available categories. An empty selection means no equipment available.</p><div className="equipment-options">{EQUIPMENT_OPTIONS.map(option => <label className="equipment-check" key={option.id}><input type="checkbox" checked={value.available.includes(option.id)} onChange={event => onChange({ ...value, available: EQUIPMENT_OPTIONS.filter(item => item.id === option.id ? event.target.checked : value.available.includes(item.id)).map(item => item.id) })} />{option.label}</label>)}</div></>}
    <p>Category matching only checks the requirements you recorded. A category match does not confirm that a particular machine or setup meets the exercise’s needs. It does not assess suitability, safety, loads, or technique, or replace exercises.</p>
  </fieldset>
}

export function EquipmentRequirements({ label, requirements, listedEmpty, onChange }: { label: string; requirements: EquipmentId[] | undefined; listedEmpty: boolean; onChange: (requirements: EquipmentId[] | undefined, listedEmpty: boolean) => void }) {
  const mode = listedEmpty ? 'listed' : requirements === undefined ? 'unknown' : requirements.length ? 'listed' : 'none'
  return <div className="equipment-requirements"><label>{label} equipment requirements<select value={mode} onChange={event => {
    if (event.target.value === 'none') onChange([], false)
    else if (event.target.value === 'unknown') onChange(undefined, false)
    else onChange(requirements?.length ? requirements : undefined, !requirements?.length)
  }}><option value="unknown">Unknown / not specified</option><option value="none">No equipment required</option><option value="listed">Listed equipment categories</option></select></label>
    {mode === 'listed' && <><p>All checked categories are required.</p><div className="equipment-options">{EQUIPMENT_OPTIONS.map(option => <label className="equipment-check" key={option.id}><input type="checkbox" aria-label={`${label} requires ${option.label}`} checked={requirements?.includes(option.id) ?? false} onChange={event => {
      const next = EQUIPMENT_OPTIONS.filter(item => item.id === option.id ? event.target.checked : requirements?.includes(item.id)).map(item => item.id)
      onChange(next.length ? next : undefined, !next.length)
    }} />{option.label}</label>)}</div>{listedEmpty && <p className="error-message">Select at least one category, or explicitly choose unknown or no equipment before saving.</p>}</>}
  </div>
}

export function EquipmentStatus({ requirements, available }: { requirements: readonly EquipmentId[] | undefined; available?: readonly EquipmentId[] }) {
  const match = available === undefined ? null : equipmentMatch(requirements, available)
  return <span className={`equipment-status${match ? ` equipment-${match.status}` : ''}`}>
    <span>Equipment: {equipmentSummary(requirements)}</span>
    {match && <strong>{match.status === 'unknown' ? 'Unknown requirements: cannot confirm a match' : match.status === 'missing' ? `Missing: ${equipmentSummary(match.missing)}` : 'Equipment matched'}</strong>}
  </span>
}

export function EquipmentOverview({ exercises, available, details = false }: { exercises: Exercise[]; available?: readonly EquipmentId[]; details?: boolean }) {
  const unknown = exercises.filter(exercise => exercise.equipment === undefined).length
  const matched = available === undefined ? 0 : exercises.filter(exercise => equipmentMatch(exercise.equipment, available).status === 'matched').length
  const missing = available === undefined ? 0 : exercises.length - unknown - matched
  return <div className="equipment-overview">
    <p>{available === undefined ? `${exercises.length - unknown} exercises with explicit requirements · ${unknown} with unknown requirements` : `${matched} equipment matched · ${missing} missing equipment · ${unknown} with unknown requirements`}</p>
    {details && <ul>{exercises.map((exercise, index) => <li key={exercise.id}><strong>{index + 1}. {exercise.name}</strong><EquipmentStatus requirements={exercise.equipment} available={available} /></li>)}</ul>}
  </div>
}
