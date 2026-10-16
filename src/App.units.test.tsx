// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { startSession } from './session'
import { CM_PER_IN, KG_PER_LB } from './units'
import type { AppState } from './types'

const open = (path = '/profile') => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
const saved = (): AppState => JSON.parse(localStorage.getItem(STORAGE_KEY)!)
const ready = (patch: Partial<AppState['profile']> = {}) => {
  const state = freshState(); state.profile = { ...state.profile, onboardingComplete: true, ...patch }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const units = (unit: string) => fireEvent.change(screen.getByLabelText('Measurement units'), { target: { value: unit } })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('saved measurement preferences', () => {
  it('onboards using pounds and decimal inches and reloads canonical data', () => {
    open('/'); units('imperial')
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: '150.5' } })
    fireEvent.change(screen.getByLabelText('Height (in)'), { target: { value: '70.25' } })
    fireEvent.click(screen.getByRole('button', { name: /Start training/ }))
    expect(saved().profile).toMatchObject({ unit: 'imperial', weightKg: 150.5 * KG_PER_LB, heightCm: 70.25 * CM_PER_IN })
    expect(saved().weightHistory[0].weightKg).toBe(150.5 * KG_PER_LB)
    cleanup(); open()
    expect(screen.getByLabelText('Measurement units')).toHaveValue('imperial')
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('150.5')
    expect(screen.getByLabelText('Height (in)')).toHaveValue('70.25')
  })
  it.each([[30, 120], [300, 230], [72.123456789, 178.987654321]])('keeps exact stored values %s kg / %s cm on unrelated imperial profile saves', (weightKg, heightCm) => {
    ready({ unit: 'imperial', weightKg, heightCm }); open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saved().profile.weightKg).toBe(weightKg); expect(saved().profile.heightCm).toBe(heightCm)
    for (let count = 0; count < 6; count++) { units('metric'); units('imperial') }
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saved().profile.weightKg).toBe(weightKg); expect(saved().profile.heightCm).toBe(heightCm)
    expect(parseBackup(JSON.stringify(saved())).profile).toEqual(saved().profile)
  })
  it('changes the preference without rewriting history, active loads or nutrition', () => {
    const state = ready(); state.activeSession = startSession(state.workouts[0]); state.activeSession.sets[0].weightKg = 23.456789
    state.weightHistory = [{ id: 'weight-old', date: '2026-10-01', weightKg: 72.123456789 }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); open(); units('imperial')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saved()).toEqual({ ...state, profile: { ...state.profile, unit: 'imperial' } })
    fireEvent.click(screen.getAllByRole('link', { name: 'Nutrition' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Add water' }))
    expect(screen.getByLabelText('Water amount (ml)')).toBeInTheDocument()
  })
  it('retains decimal text through unrelated edits and converts an edited value only once', () => {
    ready({ unit: 'imperial' }); open()
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: '160.' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other edit' } })
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('160.')
    units('metric'); units('imperial')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saved().profile.weightKg).toBe(160 * KG_PER_LB)
  })
  it('does not relabel an invalid draft when changing units and blocks invalid profile saves', () => {
    ready(); open()
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '.' } })
    units('imperial')
    expect(screen.getByLabelText('Measurement units')).toHaveValue('metric')
    expect(screen.getByLabelText('Weight (kg)')).toHaveValue('.')
    expect(screen.getByRole('alert')).toHaveTextContent('before changing units')
    fireEvent.submit(screen.getByRole('button', { name: 'Save profile' }).closest('form')!)
    expect(saved().profile.weightKg).toBe(72)
  })
  it.each(['', '-2', 'Infinity', 'NaN', '661.39'])('rejects invalid or out-of-bounds profile weight %j', value => {
    ready({ unit: 'imperial' }); open()
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save profile' }).closest('form')!)
    expect(saved().profile.weightKg).toBe(72)
    expect(screen.getByRole('alert')).toHaveTextContent('lb')
  })
  it('keeps measurement text and selection on save failure, then retries and reloads', () => {
    ready(); open(); units('imperial')
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: '165.25' } })
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('165.25')
    expect(saved().profile.unit).toBe('metric')
    failure.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saved().profile.weightKg).toBe(165.25 * KG_PER_LB)
    cleanup(); open(); expect(screen.getByLabelText('Weight (lb)')).toHaveValue('165.25')
  })
  it('replaces unsaved measurement drafts only after a successful backup import', async () => {
    ready(); const view = open()
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '.' } })
    const replacement = freshState(); replacement.profile.onboardingComplete = true; replacement.profile.unit = 'imperial'; replacement.profile.weightKg = 100 * KG_PER_LB
    const file = new File([JSON.stringify(replacement)], 'backup.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(replacement)) })
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('Weight (lb)')).toHaveValue('100'))
    expect(saved()).toEqual(replacement)
  })
})

it('saves a load on blur before route navigation and resumes it in pounds after reload', () => {
  ready({ unit: 'imperial' }); open('/workouts/upper-power')
  fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
  const load = screen.getByLabelText('Bench Press set 1 weight')
  fireEvent.change(load, { target: { value: '95.25' } }); fireEvent.blur(load)
  expect(saved().activeSession!.sets[0].weightKg).toBe(95.25 * KG_PER_LB)
  fireEvent.click(screen.getAllByRole('link', { name: 'Profile' })[0]); units('metric')
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  expect(saved().activeSession!.sets[0].weightKg).toBe(95.25 * KG_PER_LB)
  units('imperial'); fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  cleanup(); open('/workouts/upper-power')
  expect(screen.getByLabelText('Bench Press set 1 weight')).toHaveValue('95.25')
  expect(saved().activeSession!.sets[0].weightKg).toBe(95.25 * KG_PER_LB)
})
