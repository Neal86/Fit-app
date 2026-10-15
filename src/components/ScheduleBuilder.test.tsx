// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import ScheduleBuilder from './ScheduleBuilder'
import PlanHistory from './PlanHistory'
import { freshState } from '../storage'
import { savePlanRevision } from '../planning'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('schedule review and plan recovery', () => {
  it('requires a preview and explicit confirmation before applying a schedule', () => {
    const update = vi.fn(() => true)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MemoryRouter><ScheduleBuilder state={freshState()} update={update} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Apply this schedule' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply this schedule' }))
    expect(update).not.toHaveBeenCalled()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Replace your plan'))
  })
  it('invalidates a preview after changing the time limit', () => {
    render(<MemoryRouter><ScheduleBuilder state={freshState()} update={() => true} /></MemoryRouter>)
    fireEvent.click(screen.getByLabelText('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    fireEvent.change(screen.getByLabelText('Maximum planned minutes per session'), { target: { value: '20' } })
    expect(screen.queryByRole('button', { name: 'Apply this schedule' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    expect(screen.getByRole('alert')).toHaveTextContent('exceeds')
  })
  it('does not clear the editor when storing a restored version fails', () => {
    const state = freshState(); const changed = savePlanRevision(state, [{ ...state.workouts[0], title: 'Edited' }], 'Before edit')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onRestore = vi.fn()
    render(<PlanHistory state={changed} update={() => false} onRestore={onRestore} />)
    fireEvent.click(screen.getByText(/Previous plan versions/))
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' }))
    expect(onRestore).not.toHaveBeenCalled()
  })
})
