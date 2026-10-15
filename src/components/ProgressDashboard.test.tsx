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
