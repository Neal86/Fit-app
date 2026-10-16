// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import Coaching from './Coaching'
import { CloudClient } from '../cloud'
import { COACHING_POLICY } from '../coaching'
import { freshState } from '../storage'
import { unknownCalories } from '../calorieEstimates'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('renders unavailable training estimates from the shared snapshot without changing numeric nutrition', async () => {
  const stamp = '2026-10-15T12:00:00.000Z'
  const state = freshState()
  state.workouts[0].calories = unknownCalories()
  state.workouts[1].calories = 0
  const snapshot = {
    relationshipId: 'relation-1', relationshipVersion: 1, revision: 3, updatedAt: stamp,
    categories: {
      training: {
        workouts: state.workouts,
        logs: [
          { id: 'unknown-log', workoutId: state.workouts[0].id, title: 'Unavailable historical session', startedAt: stamp, completedAt: stamp, duration: 1, calories: unknownCalories(), completedExerciseIds: [] },
          { id: 'zero-log', workoutId: state.workouts[1].id, title: 'Zero historical session', startedAt: stamp, completedAt: stamp, duration: 1, calories: 0, completedExerciseIds: [] },
        ],
        planHistory: [{ id: 'historical-plan', label: 'Unknown historical plan', savedAt: stamp, workouts: [{ ...state.workouts[0], title: 'Historical unknown workout' }] }],
      },
      nutrition: { ...state.nutrition, meals: [{ id: 'meal', date: '2026-10-15', mealType: 'Lunch', foodName: 'Synthetic meal', serving: '1 serving', calories: 123.45, protein: 10, carbs: 20, fat: 3 }] },
    },
  }
  const original = structuredClone(snapshot)
  const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ user: { id: 'coach', email: 'coach@example.test', emailVerified: true, createdAt: stamp }, csrfToken: 'synthetic', sessionExpiresAt: '2100-01-01T00:00:00.000Z' }))
    .mockResolvedValueOnce(response({ policyVersion: COACHING_POLICY, coachQualificationsVerified: false, relationships: [{ id: 'relation-1', role: 'coach', counterpart: { id: 'athlete', email: 'athlete@example.test' }, status: 'active', version: 1, scopes: ['training', 'nutrition'], policyVersion: COACHING_POLICY, consentUpdatedAt: stamp, createdAt: stamp, acceptedAt: stamp, revokedAt: null }], invitations: [] }))
    .mockResolvedValueOnce(response(snapshot))
  const client = new CloudClient('https://app.example.test/api/v1', fetcher)
  await client.login('coach@example.test', 'synthetic-password')
  render(<Coaching client={client} />)
  expect(fetcher).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Check collaboration availability' }))
  await screen.findByRole('heading', { name: 'Accepted relationships' })
  fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' }))
  await screen.findByRole('region', { name: 'Displayed collaborator data' })
  expect(screen.getByText('Calorie estimate unavailable')).toBeInTheDocument()
  expect(screen.getByText('0 estimated kcal')).toBeInTheDocument()
  expect(screen.getByText(/Historical unknown workout \(Calorie estimate unavailable\)/)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Unavailable historical session', hidden: true }).closest('article')).toHaveTextContent('Calorie estimate unavailable')
  expect(screen.getByRole('heading', { name: 'Zero historical session', hidden: true }).closest('article')).toHaveTextContent('0 estimated kcal')
  expect(screen.getByText(/Synthetic meal · 1 serving · 123.45 kcal/)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/NaN|\[object Object\]/)
  expect(snapshot).toEqual(original)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
