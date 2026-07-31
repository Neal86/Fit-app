import { useMemo, useState } from 'react'
import { Activity, CalendarDays, CheckCircle2, Dumbbell, Flame, Home, Play, Settings, Target, TrendingUp, UserRound } from 'lucide-react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { initialState } from './data'
import type { AppState, Profile, Workout } from './types'

const STORAGE_KEY = 'fit-app-state-v1'

function loadState(): AppState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) as AppState : initialState
  } catch {
    return initialState
  }
}

function App() {
  const [state, setState] = useState<AppState>(loadState)
  const update = (next: AppState) => {
    setState(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  const completeWorkout = (workout: Workout) => {
    const today = new Date().toISOString().slice(0, 10)
    update({
      ...state,
      logs: [{ id: crypto.randomUUID(), workoutId: workout.id, title: workout.title, date: today, duration: workout.duration, calories: workout.calories }, ...state.logs],
    })
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard state={state} />} />
          <Route path="/workouts" element={<Workouts workouts={state.workouts} />} />
          <Route path="/workouts/:id" element={<WorkoutDetail workouts={state.workouts} onComplete={completeWorkout} />} />
          <Route path="/progress" element={<Progress state={state} />} />
          <Route path="/profile" element={<ProfilePage profile={state.profile} onSave={(profile) => update({ ...state, profile })} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <MobileNav />
    </div>
  )
}

const nav = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/workouts', label: 'Workouts', icon: Dumbbell },
  { to: '/progress', label: 'Progress', icon: TrendingUp },
  { to: '/profile', label: 'Profile', icon: UserRound },
]

function Sidebar() {
  const location = useLocation()
  return <aside className="sidebar"><div className="brand"><span className="brand-mark"><Activity size={22} /></span><span>Fit</span></div><nav>{nav.map(({ to, label, icon: Icon }) => <Link key={to} className={location.pathname === to ? 'nav-link active' : 'nav-link'} to={to}><Icon size={19} />{label}</Link>)}</nav><div className="sidebar-footer"><Settings size={18} /> v1.0</div></aside>
}

function MobileNav() {
  const location = useLocation()
  return <nav className="mobile-nav">{nav.map(({ to, label, icon: Icon }) => <Link key={to} className={location.pathname === to ? 'active' : ''} to={to}><Icon size={20} /><span>{label}</span></Link>)}</nav>
}

function Dashboard({ state }: { state: AppState }) {
  const thisWeek = state.logs.filter((log) => Date.now() - new Date(log.date).getTime() < 7 * 86400000)
  const calories = thisWeek.reduce((sum, log) => sum + log.calories, 0)
  const minutes = thisWeek.reduce((sum, log) => sum + log.duration, 0)
  const nextWorkout = state.workouts[thisWeek.length % state.workouts.length]
  return <section><PageHeader eyebrow="Welcome back" title={`${state.profile.name}, ready to move?`} subtitle="Small, consistent sessions create lasting results." />
    <div className="hero-card"><div><span className="pill">Next workout</span><h2>{nextWorkout.title}</h2><p>{nextWorkout.exercises.length} exercises · {nextWorkout.duration} min</p><Link className="primary-button" to={`/workouts/${nextWorkout.id}`}><Play size={17} fill="currentColor" /> Start workout</Link></div><div className="hero-art"><Dumbbell size={70} /></div></div>
    <div className="stats-grid"><Stat icon={<CheckCircle2 />} label="Workouts" value={`${thisWeek.length}/${state.profile.weeklyTarget}`} /><Stat icon={<Flame />} label="Calories" value={calories.toLocaleString()} /><Stat icon={<CalendarDays />} label="Minutes" value={minutes.toString()} /><Stat icon={<Target />} label="Current goal" value={state.profile.goal} /></div>
    <div className="section-heading"><div><h2>Your program</h2><p>Balanced sessions built around your goal.</p></div><Link to="/workouts">View all</Link></div>
    <div className="cards-grid">{state.workouts.slice(0, 3).map((workout) => <WorkoutCard key={workout.id} workout={workout} />)}</div>
  </section>
}

function Workouts({ workouts }: { workouts: Workout[] }) {
  return <section><PageHeader eyebrow="Training plan" title="Your workouts" subtitle="Follow the plan or choose the session that fits your day." /><div className="cards-grid">{workouts.map((workout) => <WorkoutCard key={workout.id} workout={workout} />)}</div></section>
}

function WorkoutCard({ workout }: { workout: Workout }) {
  return <Link to={`/workouts/${workout.id}`} className="workout-card"><div className="card-icon"><Dumbbell /></div><span>{workout.day}</span><h3>{workout.title}</h3><p>{workout.exercises.length} exercises</p><div className="card-meta"><span>{workout.duration} min</span><span>{workout.calories} kcal</span></div></Link>
}

function WorkoutDetail({ workouts, onComplete }: { workouts: Workout[]; onComplete: (workout: Workout) => void }) {
  const { id } = useParams(); const navigate = useNavigate(); const workout = workouts.find((item) => item.id === id)
  const [done, setDone] = useState<string[]>([])
  if (!workout) return <Navigate to="/workouts" replace />
  const finish = () => { onComplete(workout); navigate('/progress') }
  return <section><PageHeader eyebrow={workout.day} title={workout.title} subtitle={`${workout.duration} minutes · ${workout.calories} estimated calories`} />
    <div className="exercise-list">{workout.exercises.map((exercise, index) => { const checked = done.includes(exercise.id); return <button key={exercise.id} className={checked ? 'exercise-row done' : 'exercise-row'} onClick={() => setDone(checked ? done.filter((item) => item !== exercise.id) : [...done, exercise.id])}><span className="exercise-number">{checked ? <CheckCircle2 /> : index + 1}</span><span className="exercise-main"><strong>{exercise.name}</strong><small>{exercise.category}</small></span><span><strong>{exercise.sets} × {exercise.reps}</strong><small>{exercise.rest} rest</small></span></button> })}</div>
    <button className="primary-button finish-button" disabled={done.length !== workout.exercises.length} onClick={finish}><CheckCircle2 size={18} /> Complete workout</button>
  </section>
}

function Progress({ state }: { state: AppState }) {
  const totalCalories = state.logs.reduce((sum, log) => sum + log.calories, 0)
  const totalMinutes = state.logs.reduce((sum, log) => sum + log.duration, 0)
  const max = Math.max(...state.logs.map((log) => log.calories), 1)
  return <section><PageHeader eyebrow="Analytics" title="Your progress" subtitle="See the work adding up over time." /><div className="stats-grid"><Stat icon={<Dumbbell />} label="Total sessions" value={String(state.logs.length)} /><Stat icon={<Flame />} label="Calories burned" value={totalCalories.toLocaleString()} /><Stat icon={<CalendarDays />} label="Training minutes" value={totalMinutes.toLocaleString()} /><Stat icon={<TrendingUp />} label="Consistency" value={`${Math.min(100, state.logs.length * 12)}%`} /></div>
    <div className="panel"><h2>Recent activity</h2><div className="chart">{state.logs.slice(0, 8).reverse().map((log) => <div className="chart-column" key={log.id}><div className="chart-bar" style={{ height: `${Math.max(18, (log.calories / max) * 150)}px` }} title={`${log.calories} kcal`} /><span>{new Date(log.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div>)}</div></div>
    <div className="panel"><h2>Workout history</h2><div className="history-list">{state.logs.map((log) => <div key={log.id}><span className="history-icon"><CheckCircle2 /></span><span><strong>{log.title}</strong><small>{new Date(log.date).toLocaleDateString()}</small></span><span>{log.duration} min · {log.calories} kcal</span></div>)}</div></div>
  </section>
}

function ProfilePage({ profile, onSave }: { profile: Profile; onSave: (profile: Profile) => void }) {
  const [form, setForm] = useState(profile); const [saved, setSaved] = useState(false)
  const bmi = useMemo(() => (form.weightKg / (1.78 * 1.78)).toFixed(1), [form.weightKg])
  return <section><PageHeader eyebrow="Account" title="Profile & goals" subtitle="Keep your plan aligned with your current target." /><div className="profile-layout"><form className="panel form" onSubmit={(event) => { event.preventDefault(); onSave(form); setSaved(true); setTimeout(() => setSaved(false), 2000) }}><label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label>Goal<select value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })}><option>Build muscle</option><option>Lose fat</option><option>Improve endurance</option><option>Stay active</option></select></label><label>Experience<select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label><label>Weekly target<input type="number" min="1" max="7" value={form.weeklyTarget} onChange={(e) => setForm({ ...form, weeklyTarget: Number(e.target.value) })} /></label><label>Weight (kg)<input type="number" min="30" max="250" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: Number(e.target.value) })} /></label><button className="primary-button" type="submit">{saved ? 'Saved' : 'Save changes'}</button></form><aside className="panel profile-summary"><div className="avatar">{form.name.slice(0, 1).toUpperCase()}</div><h2>{form.name}</h2><p>{form.level}</p><div><span>Current goal</span><strong>{form.goal}</strong></div><div><span>Weekly target</span><strong>{form.weeklyTarget} workouts</strong></div><div><span>Estimated BMI</span><strong>{bmi}</strong></div></aside></div></section>
}

function PageHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) { return <header className="page-header"><span>{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></header> }
function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="stat-card"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div> }

export default App
