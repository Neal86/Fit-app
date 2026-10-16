import { measurementRange, measurementUnit } from '../units'
import type { MeasurementDraft, UnitSystem } from '../units'
import type { useProfileForm } from '../useProfileForm'

export default function ProfileMeasurements({ fields }: { fields: ReturnType<typeof useProfileForm> }) {
  return <>
    <label>Measurement units<select value={fields.form.unit} onChange={event => fields.changeUnit(event.target.value as UnitSystem)}><option value="metric">Metric (kg, cm)</option><option value="imperial">Imperial (lb, in)</option></select></label>
    <MeasurementField label="Height" kind="height" draft={fields.height} onChange={fields.setHeight} />
    <MeasurementField label="Weight" kind="weight" draft={fields.weight} onChange={fields.setWeight} />
    {fields.error && <p className="error-message" role="alert">{fields.error}</p>}
  </>
}
function MeasurementField({ label, kind, draft, onChange }: { label: string; kind: 'height' | 'weight'; draft: MeasurementDraft; onChange: (draft: MeasurementDraft) => void }) {
  return <label>{label} ({measurementUnit(kind, draft.unit)})<input aria-label={`${label} (${measurementUnit(kind, draft.unit)})`} required type="text" inputMode="decimal" autoComplete="off" maxLength={40} value={draft.text} onChange={event => onChange({ ...draft, text: event.target.value })} aria-describedby={`profile-${kind}-range`} /><small id={`profile-${kind}-range`}>Allowed: {measurementRange(kind, draft.unit)}</small></label>
}
