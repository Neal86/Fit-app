import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Droplets, Pencil, Plus, Trash2, Utensils } from 'lucide-react'
import { localDate } from '../session'
import {
  createNutritionId, deleteHydrationEntry, deleteMealEntry, emptyDailyTargets, isNutritionDate,
  MAX_NUTRITION_DATE, MEAL_TYPES, MIN_NUTRITION_DATE, NUTRITION_LIMITS, nutritionHistoryDates,
  nutritionTotals, parseNutritionNumber, saveDailyTargets, saveHydrationEntry, saveMealEntry, shiftNutritionDate,
  type DailyNutritionTargets, type HydrationEntry, type MealEntry, type MealType,
  type NutritionState, type NutritionUpdate,
} from '../nutrition'
import './Nutrition.css'

import { readNutritionDraft, saveNutritionDraft, type NutritionEditor as Editor, type NutritionMealForm as MealForm, type NutritionWaterForm as WaterForm, type NutritionValuesForm as ValuesForm } from '../nutritionDraft'

const blankValues = (): ValuesForm => ({ calories: '', protein: '', carbs: '', fat: '' })
const valueFields = [
  { key: 'calories', label: 'Calories', unit: 'kcal', max: NUTRITION_LIMITS.calories },
  { key: 'protein', label: 'Protein', unit: 'g', max: NUTRITION_LIMITS.grams },
  { key: 'carbs', label: 'Carbohydrates', unit: 'g', max: NUTRITION_LIMITS.grams },
  { key: 'fat', label: 'Fat', unit: 'g', max: NUTRITION_LIMITS.grams },
] as const
const display = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })

/** The parent persists the full AppState atomically before returning true from onUpdate. */
export default function Nutrition({ state, onUpdate }: { state: NutritionState; onUpdate: NutritionUpdate }) {
  const [restored] = useState(readNutritionDraft)
  const [date, setDate] = useState(() => restored.draft?.date ?? localDate())
  const [editor, setEditor] = useState<Editor | null>(() => restored.draft?.editor ?? null)
  const [restoredNotice, setRestoredNotice] = useState(!!restored.draft?.editor)
  const [draftError, setDraftError] = useState(restored.error)
  const originalView = useRef({ date, editor })
  const draftWriteStarted = useRef(!restored.error)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const editorKind = editor?.kind
  const editorId = editor && 'id' in editor ? editor.id : date
  const dirty = editor !== null && JSON.stringify(editor.form) !== JSON.stringify(editor.initial)
  const totals = nutritionTotals(state, date)
  const targets = state.targets.find(item => item.date === date) ?? emptyDailyTargets(date)
  const dates = nutritionHistoryDates(state)
  const meals = state.meals.filter(entry => entry.date === date)
  const hydration = state.hydration.filter(entry => entry.date === date)
  useEffect(() => {
    // Keep unreadable bytes until the user deliberately starts a form or changes date.
    if (!draftWriteStarted.current && date === originalView.current.date && editor === originalView.current.editor) return
    draftWriteStarted.current = true
    try {
      saveNutritionDraft({ version: 1, date, editor })
      setDraftError('')
    } catch {
      setDraftError('This tab cannot keep or clear nutrition drafts. Keep this page open until you finish; leaving may lose edits or restore an older draft. Your saved diary is separate.')
      setStatus('')
    }
  }, [date, editor, restored.error])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  useEffect(() => {
    if (editorKind) formRef.current?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')?.focus()
  }, [editorKind, editorId])
  const canLeave = () => !dirty || window.confirm('Discard unsaved nutrition changes?')
  const clearFeedback = () => { setError(''); setStatus(''); setRestoredNotice(false) }
  const chooseDate = (next: string) => {
    if (next === date) return
    if (!isNutritionDate(next)) { setError('Choose a valid diary date between 1900 and 2200.'); return }
    if (!canLeave()) return
    setDate(next); setEditor(null); clearFeedback()
  }
  const startMeal = (entry: MealEntry | null = null) => {
    if (!canLeave()) return
    const form: MealForm = entry ? { date: entry.date, mealType: entry.mealType, foodName: entry.foodName, serving: entry.serving, calories: String(entry.calories), protein: String(entry.protein), carbs: String(entry.carbs), fat: String(entry.fat) } : { ...blankValues(), date, mealType: 'Breakfast', foodName: '', serving: '' }
    setEditor({ kind: 'meal', id: entry?.id ?? createNutritionId(state), original: entry, initial: form, form }); clearFeedback()
  }
  const startWater = (entry: HydrationEntry | null = null) => {
    if (!canLeave()) return
    const form: WaterForm = entry ? { date: entry.date, milliliters: String(entry.milliliters), note: entry.note } : { date, milliliters: '', note: '' }
    setEditor({ kind: 'water', id: entry?.id ?? createNutritionId(state), original: entry, initial: form, form }); clearFeedback()
  }
  const startTargets = () => {
    if (!canLeave()) return
    const form = { calories: targets.calories ? String(targets.calories) : '', protein: targets.protein ? String(targets.protein) : '', carbs: targets.carbs ? String(targets.carbs) : '', fat: targets.fat ? String(targets.fat) : '', milliliters: targets.milliliters ? String(targets.milliliters) : '' }
    setEditor({ kind: 'targets', original: state.targets.find(item => item.date === date) ?? null, initial: form, form }); clearFeedback()
  }
  const persist = (change: (current: NutritionState) => NutritionState, message: string, savedDate = date) => {
    clearFeedback()
    let validationError = ''
    try {
      const saved = onUpdate(current => {
        try { return change(current) } catch (cause) { validationError = cause instanceof Error ? cause.message : 'Check the entered values.'; throw cause }
      })
      if (!saved) { setError(`Changes were not saved. ${validationError || 'Your saved diary and this form have been kept. Try again after checking device storage.'}`); return }
      setEditor(null); setDate(savedDate); setStatus(message)
    } catch (cause) { setError(`Changes were not saved. ${cause instanceof Error ? cause.message : 'Device storage is unavailable.'}`) }
  }
  const save = () => {
    if (!editor) return
    clearFeedback()
    try {
      if (editor.kind === 'water') {
        const entry: HydrationEntry = { id: editor.id, date: editor.form.date, note: editor.form.note.trim(), milliliters: parseNutritionNumber(editor.form.milliliters, 'Water (ml)', NUTRITION_LIMITS.milliliters, { positive: true }) }
        if (!isNutritionDate(entry.date)) throw new Error('Choose a valid entry date between 1900 and 2200.')
        if (editor.original && !window.confirm('Save changes to this water entry?')) return
        persist(current => saveHydrationEntry(current, entry, editor.original), `Water entry saved for ${dateLabel(entry.date)}.`, entry.date)
      } else {
        const values = {
          calories: parseNutritionNumber(editor.form.calories, 'Calories (kcal)', NUTRITION_LIMITS.calories, { optional: editor.kind === 'targets' }),
          protein: parseNutritionNumber(editor.form.protein, 'Protein (g)', NUTRITION_LIMITS.grams, { optional: editor.kind === 'targets' }),
          carbs: parseNutritionNumber(editor.form.carbs, 'Carbohydrates (g)', NUTRITION_LIMITS.grams, { optional: editor.kind === 'targets' }),
          fat: parseNutritionNumber(editor.form.fat, 'Fat (g)', NUTRITION_LIMITS.grams, { optional: editor.kind === 'targets' }),
        }
        if (editor.kind === 'meal') {
          const entry: MealEntry = { ...values, id: editor.id, date: editor.form.date, mealType: editor.form.mealType, foodName: editor.form.foodName.trim(), serving: editor.form.serving.trim() }
          if (!isNutritionDate(entry.date)) throw new Error('Choose a valid entry date between 1900 and 2200.')
          if (!entry.foodName || !entry.serving) throw new Error('Enter a food name and the amount or serving these values describe.')
          if (editor.original && !window.confirm(`Save changes to ${editor.original.foodName}?`)) return
          persist(current => saveMealEntry(current, entry, editor.original), `Food entry saved for ${dateLabel(entry.date)}.`, entry.date)
        } else {
          const target: DailyNutritionTargets = { ...values, date, milliliters: parseNutritionNumber(editor.form.milliliters, 'Water target (ml)', NUTRITION_LIMITS.milliliters, { optional: true }) }
          if (editor.original && !window.confirm(`Replace the manual targets for ${dateLabel(date)}? Blank or zero values remove that target.`)) return
          persist(current => saveDailyTargets(current, target, editor.original), `Manual targets saved for ${dateLabel(date)}.`)
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the entered values.') }
  }
  const cancel = () => { if (canLeave()) { setEditor(null); clearFeedback() } }
  const numberFields = (form: ValuesForm, update: (key: keyof ValuesForm, value: string) => void, target = false) => valueFields.map(field => <label key={field.key}>{target ? `${field.label} target` : field.label} ({field.unit})<input type="text" inputMode="decimal" maxLength={100} required={!target} value={form[field.key]} onChange={event => update(field.key, event.target.value)} /></label>)

  return <section className="nutrition-page">
    <header className="page-header"><span>Food & water diary</span><h1>Your nutrition diary</h1><p>Record what you choose to track. Enter the nutrition values for the full amount you ate, using your own label or other source.</p></header>
    <p className="notice">This diary is stored on this device and included in app backups and any cloud snapshot you explicitly upload. Targets are optional and entered by you; the app does not calculate nutrition needs or prescribe a diet.</p>
    <div className="panel nutrition-date-bar">
      <div className="nutrition-date-controls"><button type="button" className="secondary-button" aria-label="Previous diary day" disabled={date === MIN_NUTRITION_DATE} onClick={() => chooseDate(shiftNutritionDate(date, -1))}><ChevronLeft aria-hidden="true" /></button>
        <label>Diary date<input type="date" min={MIN_NUTRITION_DATE} max={MAX_NUTRITION_DATE} value={date} onChange={event => chooseDate(event.target.value)} /></label>
        <button type="button" className="secondary-button" aria-label="Next diary day" disabled={date === MAX_NUTRITION_DATE} onClick={() => chooseDate(shiftNutritionDate(date, 1))}><ChevronRight aria-hidden="true" /></button>
        <button type="button" className="secondary-button" disabled={date === localDate()} onClick={() => chooseDate(localDate())}>Today</button>
      </div>
      <label>Browse recorded dates<select value={dates.includes(date) ? date : ''} onChange={event => { if (event.target.value) chooseDate(event.target.value) }} disabled={!dates.length}><option value="">{dates.length ? 'Choose a recorded date' : 'No recorded dates yet'}</option>{dates.map(day => <option key={day} value={day}>{dateLabel(day)}</option>)}</select></label>
    </div>
    <h2 className="nutrition-day-heading">{dateLabel(date)}</h2>
    <p className="nutrition-caption">Totals from your entries only. Displayed values are rounded to two decimal places.</p>
    <dl className="nutrition-totals" aria-label="Daily nutrition totals">
      {valueFields.map(field => <div className="stat-card" key={field.key}><dt>{field.label} ({field.unit})</dt><dd data-testid={`nutrition-total-${field.key}`}>{display(totals[field.key])} <span>{field.unit}</span></dd><small>{targets[field.key] > 0 ? `Your target: ${display(targets[field.key])} ${field.unit}` : 'No target set'}</small></div>)}
      <div className="stat-card"><dt>Water (ml)</dt><dd data-testid="nutrition-total-water">{display(totals.milliliters)} <span>ml</span></dd><small>{targets.milliliters > 0 ? `Your target: ${display(targets.milliliters)} ml` : 'No target set'}</small></div>
    </dl>
    <div className="nutrition-actions"><button type="button" className="primary-button" onClick={() => startMeal()} disabled={state.meals.length >= NUTRITION_LIMITS.entries}><Plus aria-hidden="true" />Add food</button><button type="button" className="secondary-button" onClick={() => startWater()} disabled={state.hydration.length >= NUTRITION_LIMITS.entries}><Droplets aria-hidden="true" />Add water</button><button type="button" className="secondary-button" onClick={startTargets}>Edit daily targets</button></div>
    {(state.meals.length >= NUTRITION_LIMITS.entries || state.hydration.length >= NUTRITION_LIMITS.entries) && <p className="notice">This diary has reached a record limit. Export a backup before removing old entries to make space.</p>}
    {draftError && <p className="error-message" role="alert">{draftError}</p>}
    {restoredNotice && <p className="notice" role="status">Restored an unfinished nutrition form from this browser tab. Review it before saving; it is not a saved diary entry.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {status && <p className="notice" role="status">{status}</p>}
    {editor && <form ref={formRef} className="panel form nutrition-form" aria-label={editor.kind === 'meal' ? 'Food entry' : editor.kind === 'water' ? 'Water entry' : 'Daily targets'} onSubmit={event => { event.preventDefault(); save() }}>
      <h2>{editor.kind === 'targets' ? 'Your manual daily targets' : `${editor.original ? 'Edit' : 'Add'} ${editor.kind === 'meal' ? 'food' : 'water'}`}</h2>
      {dirty && <p className="nutrition-wide nutrition-caption" role="status">Unsaved changes. This form is kept in this browser tab when tab storage is available. Save to add it to your diary and backups; closing the tab may discard it.</p>}
      {editor.kind === 'meal' && <>
        <label>Food date<input required type="date" min={MIN_NUTRITION_DATE} max={MAX_NUTRITION_DATE} value={editor.form.date} onChange={event => setEditor({ ...editor, form: { ...editor.form, date: event.target.value } })} /></label>
        <label>Meal type<select value={editor.form.mealType} onChange={event => setEditor({ ...editor, form: { ...editor.form, mealType: event.target.value as MealType } })}>{MEAL_TYPES.map(type => <option key={type}>{type}</option>)}</select></label>
        <label>Food name<input autoComplete="off" required maxLength={NUTRITION_LIMITS.foodName} value={editor.form.foodName} onChange={event => setEditor({ ...editor, form: { ...editor.form, foodName: event.target.value } })} /></label>
        <label>Amount / serving note<input required maxLength={NUTRITION_LIMITS.serving} placeholder="e.g. 1 serving, 150 g" value={editor.form.serving} onChange={event => setEditor({ ...editor, form: { ...editor.form, serving: event.target.value } })} /></label>
        <p className="nutrition-wide nutrition-caption">Enter each value for the entire amount above. The app does not look up foods or multiply values by the serving note. Enter 0 only when your source says 0.</p>
        {numberFields(editor.form, (key, value) => setEditor({ ...editor, form: { ...editor.form, [key]: value } }))}
      </>}
      {editor.kind === 'water' && <>
        <label>Water date<input required type="date" min={MIN_NUTRITION_DATE} max={MAX_NUTRITION_DATE} value={editor.form.date} onChange={event => setEditor({ ...editor, form: { ...editor.form, date: event.target.value } })} /></label>
        <label>Water amount (ml)<input required type="text" inputMode="decimal" maxLength={100} value={editor.form.milliliters} onChange={event => setEditor({ ...editor, form: { ...editor.form, milliliters: event.target.value } })} /></label>
        <label className="nutrition-wide">Water note (optional)<input maxLength={NUTRITION_LIMITS.note} value={editor.form.note} onChange={event => setEditor({ ...editor, form: { ...editor.form, note: event.target.value } })} /></label>
      </>}
      {editor.kind === 'targets' && <>
        <p className="nutrition-wide nutrition-caption">For {dateLabel(date)} only. Enter targets you have chosen yourself. Leave a field blank or enter 0 to leave it unset. Other dates keep their own targets.</p>
        {numberFields(editor.form, (key, value) => setEditor({ ...editor, form: { ...editor.form, [key]: value } }), true)}
        <label>Water target (ml)<input type="text" inputMode="decimal" maxLength={100} value={editor.form.milliliters} onChange={event => setEditor({ ...editor, form: { ...editor.form, milliliters: event.target.value } })} /></label>
      </>}
      <div className="nutrition-wide nutrition-actions"><button type="submit" className="primary-button">{editor.kind === 'targets' ? 'Save daily targets' : editor.kind === 'meal' ? 'Save food entry' : 'Save water entry'}</button><button type="button" className="secondary-button" onClick={cancel}>Cancel</button></div>
    </form>}
    <div className="nutrition-lists">
      <section className="panel" aria-labelledby="nutrition-food-heading"><h2 id="nutrition-food-heading">Food entries ({meals.length})</h2>
        {!meals.length ? <div className="empty"><Utensils aria-hidden="true" /><strong>No food entries for this date</strong><span>Add the food and nutrition values you want to record.</span></div> : <ul className="nutrition-entry-list">{meals.map(entry => <li key={entry.id}><div><span className="eyebrow">{entry.mealType}</span><h3>{entry.foodName}</h3><p>{entry.serving}</p><p>{display(entry.calories)} kcal · Protein {display(entry.protein)} g · Carbohydrates {display(entry.carbs)} g · Fat {display(entry.fat)} g</p></div><div className="nutrition-entry-actions"><button type="button" className="secondary-button" aria-label={`Edit ${entry.foodName}`} onClick={() => startMeal(entry)}><Pencil aria-hidden="true" />Edit</button><button type="button" className="secondary-button danger" aria-label={`Delete ${entry.foodName}`} onClick={() => { if (canLeave() && window.confirm(`Delete ${entry.foodName} from ${dateLabel(entry.date)}? This cannot be undone.`)) persist(current => deleteMealEntry(current, entry), 'Food entry deleted.') }}><Trash2 aria-hidden="true" />Delete</button></div></li>)}</ul>}
      </section>
      <section className="panel" aria-labelledby="nutrition-water-heading"><h2 id="nutrition-water-heading">Water entries ({hydration.length})</h2>
        {!hydration.length ? <div className="empty"><Droplets aria-hidden="true" /><strong>No water entries for this date</strong><span>Record water in milliliters when you choose.</span></div> : <ul className="nutrition-entry-list">{hydration.map((entry, index) => <li key={entry.id}><div><h3>{display(entry.milliliters)} ml</h3>{entry.note && <p>{entry.note}</p>}</div><div className="nutrition-entry-actions"><button type="button" className="secondary-button" aria-label={`Edit water entry ${index + 1}`} onClick={() => startWater(entry)}><Pencil aria-hidden="true" />Edit</button><button type="button" className="secondary-button danger" aria-label={`Delete water entry ${index + 1}`} onClick={() => { if (canLeave() && window.confirm(`Delete this ${display(entry.milliliters)} ml water entry from ${dateLabel(entry.date)}? This cannot be undone.`)) persist(current => deleteHydrationEntry(current, entry), 'Water entry deleted.') }}><Trash2 aria-hidden="true" />Delete</button></div></li>)}</ul>}
      </section>
    </div>
  </section>
}
