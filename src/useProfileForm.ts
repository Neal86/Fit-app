import { useState } from 'react'
import type { Profile } from './types'
import { measurementDraft, readMeasurement, switchMeasurement } from './units'
import type { UnitSystem } from './units'

export function useProfileForm(profile: Profile) {
  const [source, setSource] = useState(profile)
  const [form, setForm] = useState(profile)
  const [height, setHeight] = useState(() => measurementDraft(profile.heightCm, 'height', profile.unit))
  const [weight, setWeight] = useState(() => measurementDraft(profile.weightKg, 'weight', profile.unit))
  const [error, setError] = useState('')
  // Restores/imports replace the source profile; unrelated preference saves do not.
  if (profile !== source) {
    setSource(profile); setForm(profile)
    setHeight(measurementDraft(profile.heightCm, 'height', profile.unit))
    setWeight(measurementDraft(profile.weightKg, 'weight', profile.unit)); setError('')
  }
  function changeUnit(unit: UnitSystem) {
    try {
      const nextHeight = switchMeasurement(height, 'height', unit)
      const nextWeight = switchMeasurement(weight, 'weight', unit)
      setHeight(nextHeight); setWeight(nextWeight); setForm({ ...form, unit }); setError('')
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : 'Check your measurements.'} Finish that entry before changing units.`) }
  }
  function values(): Profile | null {
    try {
      const heightCm = readMeasurement(height, 'height')
      const weightKg = readMeasurement(weight, 'weight')
      if (heightCm === null || weightKg === null) throw new Error('Enter your height and weight.')
      setError('')
      return { ...form, heightCm, weightKg }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check your measurements.'); return null }
  }
  return { form, setForm, height, setHeight, weight, setWeight, error, changeUnit, values }
}
