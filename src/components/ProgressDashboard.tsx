import { useMemo, useState } from 'react'
import { CalendarDays, Plus, Scale, Trash2 } from 'lucide-react'
import { activityMonth, filteredLogs, rangeError, recordedBests, setVolume, summarizeLogs, weightTrend } from '../analytics'
import { localDate, uid } from '../session'
import type { AppState, WeightEntry } from '../types'
import './ProgressDashboard.css'

export default function ProgressDashboard({ state, onDelete, onWeight }: { state: AppState; onDelete: (id: string) => void; onWeight: (entry: WeightEntry) => boolean }) {
  const [range, setRange] = useState({ from: '', to: '' })
  const [query, setQuery] = useState('')
  const [month, setMonth] = useState(localDate().slice(0, 7))
  const [weight, setWeight] = useState(String(state.profile.weightKg))
  const [weightDate, setWeightDate] = useState(localDate())
  const [message, setMessage] = useState('')
  const logs = useMemo(() => filteredLogs(state.logs, range, query), [state.logs, range, query])
  const totals = useMemo(() => summarizeLogs(logs), [logs])
  const weights = useMemo(() => weightTrend(state.weightHistory, range), [state.weightHistory, range])
  const bests = useMemo(() => recordedBests(logs, state.workouts), [logs, state.workouts])
  const days = useMemo(() => activityMonth(logs, month), [logs, month])
  const firstWeekday = days.length ? (new Date(`${days[0].date}T12:00:00`).getDay() + 6) % 7 : 0
  const rangeProblem = rangeError(range)
  const formatNumber = (number: number) => number.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return <section className="progress-dashboard">
    <header className="page-header"><span>Training history</span><h1>Your progress</h1><p>Explore your recorded activity and weight. Load totals exclude warm-up and unfinished sets; calorie values are estimates.</p></header>
    <div className="panel progress-filters">
      <label>From date<input type="date" value={range.from} onChange={event => setRange({ ...range, from: event.target.value })} /></label>
      <label>To date<input type="date" value={range.to} onChange={event => setRange({ ...range, to: event.target.value })} /></label>
      <label>Search workout history<input type="search" maxLength={200} value={query} placeholder="Title or notes" onChange={event => setQuery(event.target.value)} /></label>
      <button className="secondary-button" onClick={() => { setRange({ from: '', to: '' }); setQuery('') }}>Show all history</button>
    </div>
    {rangeProblem && <p role="alert" className="error-message">{rangeProblem}</p>}
    <dl className="stats-grid progress-totals">
      {[['Sessions', totals.sessions], ['Training minutes', formatNumber(totals.seconds / 60)], ['Recorded volume (kg × reps)', formatNumber(totals.volumeKg)], ['Training days', totals.trainingDays]].map(([label, value]) => <div className="stat-card" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <p className="safety-note">{totals.sets} completed working sets · {formatNumber(totals.calories)} estimated kcal. {totals.measuredSessions} of {totals.sessions} sessions have measured elapsed time; older records retain their original duration. Recorded load is what you entered, not a strength test or medical assessment.</p>
    <div className="progress-layout">
      <div className="panel"><h2><CalendarDays size={20} /> Activity calendar</h2><label className="month-label">Calendar month<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label><p>Shows sessions matching the date and history filters.</p>
        <div className="activity-calendar" role="list" aria-label="Training days in selected month">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span className="weekday" key={day} aria-hidden="true">{day}</span>)}{Array.from({ length: firstWeekday }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}{days.map(day => <div key={day.date} role="listitem" className={day.sessions ? 'activity-day trained' : 'activity-day'} aria-label={`${day.date}: ${day.sessions} ${day.sessions === 1 ? 'session' : 'sessions'}`}><span>{Number(day.date.slice(-2))}</span><small>{day.sessions ? `${day.sessions} ×` : '–'}</small></div>)}</div>
      </div>
      <form className="panel weight-card" onSubmit={event => {
        event.preventDefault(); setMessage('')
        const weightKg = Number(weight)
        if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 300 || !weightDate || rangeError({ from: weightDate, to: weightDate })) { setMessage('Enter a valid date and a weight from 30 to 300 kg.'); return }
        if (state.weightHistory.some(entry => entry.date === weightDate) && !window.confirm(`Replace the weight entry for ${weightDate}?`)) return
        if (onWeight({ id: uid(), date: weightDate, weightKg })) setMessage('Weight entry saved.')
        else setMessage('Weight entry was not saved. Your previous data is unchanged.')
      }}><Scale /><h2>Log your weight</h2><label>Weight entry date<input required type="date" value={weightDate} onChange={event => setWeightDate(event.target.value)} /></label><label>Weight (kg)<input required type="number" min="30" max="300" step=".1" value={weight} onChange={event => setWeight(event.target.value)} /></label><button className="primary-button" type="submit"><Plus />Save entry</button>{message && <p role="status">{message}</p>}</form>
    </div>
    <div className="panel"><h2>Weight trend</h2><p>Date filters apply. Search filters only affect workouts. Values are your entries and do not imply a target.</p>{weights.length ? <><p>{weights[0].date}: {formatNumber(weights[0].weightKg)} kg → {weights[weights.length - 1].date}: {formatNumber(weights[weights.length - 1].weightKg)} kg{weights.length > 1 && ` (${formatNumber(weights[weights.length - 1].weightKg - weights[0].weightKg)} kg change)`}</p><div className="progress-table-wrap"><table><caption>Weight entries in selected date range</caption><thead><tr><th scope="col">Date</th><th scope="col">Weight (kg)</th></tr></thead><tbody>{weights.slice().reverse().map(entry => <tr key={entry.id}><td>{entry.date}</td><td>{formatNumber(entry.weightKg)}</td></tr>)}</tbody></table></div></> : <p>No weight entries in this date range.</p>}</div>
    <div className="panel"><h2>Highest recorded loads</h2><p>Completed working sets in the filtered workouts, grouped by exercise identity. Ties use the greater rep count. This does not estimate your one-rep maximum.</p>{bests.length ? <div className="progress-table-wrap"><table><caption>Highest load per recorded exercise</caption><thead><tr><th scope="col">Exercise</th><th scope="col">Load (kg)</th><th scope="col">Reps</th><th scope="col">Date</th></tr></thead><tbody>{bests.map(best => <tr key={best.exerciseId}><th scope="row">{best.name}</th><td>{formatNumber(best.weightKg)}</td><td>{best.reps}</td><td>{localDate(new Date(best.completedAt))}</td></tr>)}</tbody></table></div> : <p>No completed working sets with both reps and weight in this range.</p>}</div>
    <div className="panel"><h2>Workout history</h2><p>{logs.length} matching sessions out of {state.logs.length} saved sessions</p>{logs.length ? <ol className="progress-history">{logs.map(log => <li key={log.id}><div><h3>{log.title}</h3><p>{new Date(log.completedAt).toLocaleString()} · {formatNumber((log.durationSeconds ?? log.duration * 60) / 60)} min · ~{formatNumber(log.calories)} kcal</p>{log.notes && <p>{log.notes}</p>}<p>{log.sets?.filter(set => set.completed).length ?? 0}/{log.sets?.length ?? 0} sets · {formatNumber(setVolume(log.sets))} kg × reps</p></div><button className="icon-button danger" aria-label={`Delete ${log.title}`} onClick={() => onDelete(log.id)}><Trash2 /></button></li>)}</ol> : <p>No workouts match these filters.</p>}</div>
  </section>
}
