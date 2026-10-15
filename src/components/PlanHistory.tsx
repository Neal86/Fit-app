import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Workout } from '../types'
import type { UpdateState } from './WorkoutSession'
import { restorePlanRevision } from '../planning'
import { clearPlanDraft } from '../planDraft'

export default function PlanHistory({ state, update, onRestore }: { state: AppState; update: UpdateState; onRestore: (workout: Workout, restored: AppState) => void }) {
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const current = useRef({ state, update })
  current.current = { state, update }
  const renderedEpoch = epoch.current
  const snapshot = useMemo(() => JSON.stringify({ workouts: state.workouts, planHistory: state.planHistory }), [state.workouts, state.planHistory])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderedEpoch && current.current.state === state && current.current.update === update
  return <details className="panel plan-history"><summary>Previous plan versions ({state.planHistory?.length ?? 0})</summary><p>The 20 most recent versions are retained on this device and included in backups. Restoring a plan keeps workout history and your current session.</p>{state.planHistory?.length ? <ol>{state.planHistory.map(revision => <li key={revision.id}><div><strong>{revision.label}</strong><small>{new Date(revision.savedAt).toLocaleString()} · {revision.workouts.length} sessions</small><span>{revision.workouts.map(workout => `${workout.day}: ${workout.title}`).join(' · ')}</span></div><button className="secondary-button" onClick={() => {
    if (!valid()) return
    if (!window.confirm('Restore this plan version? Any unfinished editor draft will be discarded. Your current plan will be kept as a previous version.')) return
    let next: AppState | undefined
    let invoked = false
    let settled = false
    try {
      if (!valid()) throw new Error('The plan or draft changed. Review the current version before restoring.')
      if (update(value => {
        if (settled || invoked || !valid() || value !== state || JSON.stringify({ workouts: value.workouts, planHistory: value.planHistory }) !== snapshot) throw new Error('The plan or draft changed. Review the current version before restoring.')
        invoked = true
        next = restorePlanRevision(value, revision.id)
        return next
      }, 'Plan version restored')) {
        epoch.current += 1; clearPlanDraft(); setError(''); onRestore(next?.workouts[0] ?? revision.workouts[0], next ?? state)
      } else setError('Plan version was not restored. Your draft is kept; retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Plan version was not restored. Your draft is kept.') }
    finally { settled = true }
  }}>Restore version</button></li>)}</ol> : <p>Previous versions will appear when you save a changed plan.</p>}{error && <p role="alert" className="error-message">{error}</p>}</details>
}
