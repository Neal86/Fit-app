import { useEffect, useReducer, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import type { AppState } from '../types'
import type { UpdateState } from './WorkoutSession'

// Fence retained handlers before React commits, across navigation, and across
// restore-to-identical-data. Each form also fences its unsaved input snapshot.
export function usePlanningGuard(state: AppState, readGeneration?: () => number) {
  const location = useLocation()
  const route = `${location.key}:${location.pathname}:${location.search}:${location.hash}`
  const mounted = useRef(true)
  const epoch = useRef(0)
  const sourceEpoch = useRef(0)
  const library = state.exerciseLibrary
  const librarySnapshot = JSON.stringify(library)
  const generation = readGeneration?.()
  const current = useRef({ state, route, readGeneration, generation, library: state.exerciseLibrary, librarySnapshot })
  if (current.current.route !== route || current.current.state !== state || current.current.generation !== generation || current.current.library !== state.exerciseLibrary || current.current.librarySnapshot !== librarySnapshot) { epoch.current += 1; sourceEpoch.current += 1 }
  current.current = { state, route, readGeneration, generation, library: state.exerciseLibrary, librarySnapshot }
  const renderedEpoch = epoch.current
  const [, render] = useReducer(value => value + 1, 0)
  const snapshot = JSON.stringify(state.workouts)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = () => mounted.current && epoch.current === renderedEpoch && current.current.route === route && current.current.state === state && current.current.readGeneration?.() === generation && JSON.stringify(current.current.state.workouts) === snapshot && current.current.library === library && current.current.state.exerciseLibrary === library && JSON.stringify(current.current.state.exerciseLibrary) === librarySnapshot
  const invalidate = () => { epoch.current += 1; if (mounted.current) render() }
  const commit = (update: UpdateState, change: (value: AppState) => AppState, message: string, valid = () => true) => {
    let invoked = false
    let settled = false
    try {
      if (!isCurrent() || !valid()) throw new Error('This page or its data changed. Review your latest choices before saving.')
      return update(value => {
        if (settled || invoked || !isCurrent() || !valid() || value !== state || JSON.stringify(value.workouts) !== snapshot || JSON.stringify(value.exerciseLibrary) !== librarySnapshot) throw new Error('This page or its data changed. Review your latest choices before saving.')
        invoked = true
        return change(value)
      }, message)
    } finally { settled = true; if (mounted.current) render() }
  }
  return { isCurrent, invalidate, commit, generation, route, snapshot, sourceEpoch: sourceEpoch.current }
}
