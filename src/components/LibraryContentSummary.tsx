import type { Exercise } from '../types'
import { EquipmentStatus } from './EquipmentControls'

export default function LibraryContentSummary({ exercise }: { exercise: Pick<Exercise, 'name' | 'category' | 'sets' | 'reps' | 'restSeconds' | 'notes' | 'equipment'> }) {
  return <><dl className="library-content-summary"><dt>Name</dt><dd>{exercise.name}</dd><dt>Category</dt><dd>{exercise.category || 'Uncategorized'}</dd><dt>Set count</dt><dd>{exercise.sets}</dd><dt>Target reps or seconds</dt><dd>{exercise.reps}</dd><dt>Rest between sets</dt><dd>{exercise.restSeconds} seconds</dd><dt>Notes</dt><dd>{exercise.notes || 'No notes'}</dd></dl><EquipmentStatus requirements={exercise.equipment} /></>
}
