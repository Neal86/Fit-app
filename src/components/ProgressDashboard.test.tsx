// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ProgressDashboard from './ProgressDashboard'
import { freshState } from '../storage'
import { localDate } from '../session'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('progress UI', () => {
  it('shows a storage failure instead of a false weight-save result', () => {
    const onWeight = vi.fn(() => false)
    render(<ProgressDashboard state={freshState()} onDelete={() => {}} onWeight={onWeight} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(onWeight).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('not saved')
  })
  it('confirms replacing a daily entry and respects cancellation', () => {
    const state = freshState(); state.weightHistory = [{ id: 'existing', date: localDate(), weightKg: 70 }]
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onWeight = vi.fn(() => true)
    render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Replace the weight entry'))
    expect(onWeight).not.toHaveBeenCalled()
  })
  it('shows invalid date-range feedback and can reset filters', () => {
    render(<ProgressDashboard state={freshState()} onDelete={() => {}} onWeight={() => true} />)
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-15' } })
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-01' } })
    expect(screen.getByRole('alert')).toHaveTextContent('start date')
    fireEvent.click(screen.getByRole('button', { name: 'Show all history' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('progress measurement preference', () => {
  it.each([30, 300, 72.123456789])('saves untouched imperial %s kg exactly despite display rounding', weightKg => {
    const state = freshState(); state.profile.unit = 'imperial'; state.profile.weightKg = weightKg
    const onWeight = vi.fn(() => true)
    render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(onWeight).toHaveBeenCalledWith(expect.objectContaining({ weightKg }))
  })
  it('renders trends, highest load, totals and individual session volume in pounds, excluding warmups', () => {
    const state = freshState(); state.profile.unit = 'imperial'
    const kgPerLb = 0.45359237
    state.weightHistory = [{ id: 'one', date: '2026-10-01', weightKg: 150 * kgPerLb }, { id: 'two', date: '2026-10-02', weightKg: 155 * kgPerLb }]
    state.logs = [{ id: 'log', workoutId: state.workouts[0].id, title: 'Unit test session', startedAt: '2026-10-15T10:00:00Z', completedAt: '2026-10-15T10:10:00Z', duration: 10, calories: 20, completedExerciseIds: [], sets: [
      { id: 'working', exerciseId: state.workouts[0].exercises[0].id, setNumber: 1, reps: 10, weightKg: 100 * kgPerLb, seconds: null, rpe: null, warmup: false, completed: true },
      { id: 'warmup', exerciseId: state.workouts[0].exercises[0].id, setNumber: 2, reps: 10, weightKg: 200 * kgPerLb, seconds: null, rpe: null, warmup: true, completed: true },
    ] }]
    render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={() => true}/>)
    expect(screen.getByText('Recorded volume (lb × reps)').parentElement).toHaveTextContent('1,000')
    expect(screen.getByText('2026-10-01: 150 lb → 2026-10-02: 155 lb (5 lb change)')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Load (lb)' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '100' })).toBeInTheDocument()
    expect(screen.getByText('2/2 sets · 1,000 lb × reps')).toBeInTheDocument()
    expect(state.logs[0].sets![0].weightKg).toBe(100 * kgPerLb)
  })
  it.each(['', '.', '-1', 'Infinity', 'NaN', '661.39'])('rejects invalid imperial weight %j and keeps the draft', text => {
    const state = freshState(); state.profile.unit = 'imperial'
    const onWeight = vi.fn(() => true)
    render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight}/>)
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: text } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save entry' }).closest('form')!)
    expect(onWeight).not.toHaveBeenCalled(); expect(screen.getByLabelText('Weight (lb)')).toHaveValue(text)
    expect(screen.getByRole('status')).toHaveTextContent('lb')
  })
  it('retains failed-save text for retry and converts valid drafts once on preference changes', () => {
    const state = freshState(); state.profile.unit = 'imperial'
    const onWeight = vi.fn(() => false)
    const view = render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight}/>)
    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: '160.25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('160.25')
    view.rerender(<ProgressDashboard state={{ ...state, profile: { ...state.profile, unit: 'metric' } }} onDelete={() => {}} onWeight={onWeight}/>)
    view.rerender(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight}/>)
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('160.25')
    onWeight.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(onWeight).toHaveBeenLastCalledWith(expect.objectContaining({ weightKg: 160.25 * 0.45359237 }))
  })
  it('preserves the entry unit for an invalid draft and resets drafts for a replaced canonical profile', () => {
    const state = freshState(); const onWeight = vi.fn(() => true)
    const view = render(<ProgressDashboard state={state} onDelete={() => {}} onWeight={onWeight}/>)
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '.' } })
    const switched = { ...state, profile: { ...state.profile, unit: 'imperial' as const } }
    view.rerender(<ProgressDashboard state={switched} onDelete={() => {}} onWeight={onWeight}/>)
    expect(screen.getByLabelText('Weight (kg)')).toHaveValue('.')
    expect(screen.getByText('Finish this entry in kg. Your next entry will use lb.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(onWeight).toHaveBeenCalledWith(expect.objectContaining({ weightKg: 75 }))
    view.rerender(<ProgressDashboard state={{ ...switched, profile: { ...switched.profile, weightKg: 80 } }} onDelete={() => {}} onWeight={onWeight}/>)
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue('176.37')
  })
})
