import type { Workout } from '../types'
import './SessionGrouping.css'

import { plannedCompatibility, plannedRest, plannedRowLabel, plannedSlotKey, plannedSlots } from './plannedGroupLabels'

export default function PlannedGroupSummary({ workout, onRemove, draft = false }: { workout: Workout; onRemove?: (id: string) => void; draft?: boolean }) {
  if (!workout.plannedGrouping) return null
  const grouped = new Set(workout.plannedGrouping.groups.flatMap(group => group.rounds.flatMap(round => round.members.map(plannedSlotKey))))
  const remaining = plannedSlots(workout).filter(member => !grouped.has(plannedSlotKey(member)))
  return <section className="session-groups" aria-label={`${draft ? 'Draft' : 'Saved'} plan groups for ${workout.title}`}>
    <h2>{draft ? 'Groups in this draft' : 'Saved plan groups'}</h2><p>{draft ? 'Save this workout plan to use these exact planned rows as fresh groups in future sessions.' : 'These exact planned rows will become fresh session groups when this workout starts.'} No rows are paired or added automatically. Existing duration and calorie estimates stay unchanged.</p>
    {workout.plannedGrouping.groups.map(group => <article className="panel" key={group.id} aria-label={`Planned group ${group.name}`}>
      <h3>{group.name}</h3><p>{group.rounds[0].members.length === 2 ? 'Superset' : 'Circuit'} · {group.restSeconds}s round rest · {group.rounds.length} rounds</p>
      <ol className="group-rounds" aria-label={`Exact planned rounds for ${group.name}`}>{group.rounds.map((round, index) => <li key={round.id}><strong>Round {index + 1}</strong><ol>{round.members.map(member => <li key={plannedSlotKey(member)}>{plannedRowLabel(workout, member)}</li>)}</ol></li>)}</ol>
      {onRemove && <button type="button" className="secondary-button" onClick={() => onRemove(group.id)}>Review removal of {group.name}</button>}
    </article>)}
    <details><summary>{remaining.length} planned rows remain ungrouped</summary><ul aria-label="Saved ungrouped planned rows">{remaining.map(member => <li key={plannedSlotKey(member)}>{plannedRowLabel(workout, member)}</li>)}</ul></details>
    <p>{plannedRest}</p><p>{plannedCompatibility}</p>
  </section>
}
