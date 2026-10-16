import type { NutritionState } from './nutrition.js'
import type { EquipmentId } from './equipment.js'
export type Goal = 'Build muscle' | 'Lose fat' | 'Improve endurance' | 'Stay active'
export type Level = 'Beginner' | 'Intermediate' | 'Advanced'
export type Exercise = {
  id: string; name: string; sets: number; reps: string; restSeconds: number; category: string; notes?: string; equipment?: EquipmentId[]
}
export type Workout = {
  id: string; title: string; day: string; duration: number; calories: number; difficulty: Level; description: string; exercises: Exercise[]; plannedGrouping?: PlannedGrouping
}
export type PlannedGroupMember = { exerciseId: string; setNumber: number }
export type PlannedGroupRound = { id: string; members: PlannedGroupMember[] }
export type PlannedGroup = { id: string; name: string; restSeconds: number; rounds: PlannedGroupRound[] }
export type PlannedGrouping = { version: 1; groups: PlannedGroup[] }
export type ExerciseSet = {
  id: string; exerciseId: string; setNumber: number; reps: number | null; weightKg: number | null;
  seconds: number | null; rpe: number | null; warmup: boolean; completed: boolean
}
export type SessionGroupRound = { id: string; setIds: string[] }
export type SessionGroup = { id: string; name: string; restSeconds: number; rounds: SessionGroupRound[] }
export type SessionGrouping = { version: 1; groups: SessionGroup[] }
export type ActiveSession = {
  id: string; workout: Workout; startedAt: string; elapsedSeconds: number; runningSince: number | null;
  sets: ExerciseSet[]; notes: string; restUntil: number | null; grouping?: SessionGrouping
}
export type WorkoutLog = {
  id: string; workoutId: string; title: string; startedAt: string; completedAt: string; duration: number;
  durationSeconds?: number; calories: number; completedExerciseIds: string[]; notes?: string; sets?: ExerciseSet[];
  exerciseSnapshots?: Pick<Exercise, 'id' | 'name' | 'category'>[]; grouping?: SessionGrouping
}
export type WeightEntry = { id: string; date: string; weightKg: number }
export type Profile = {
  name: string; goal: Goal; level: Level; weeklyTarget: number; weightKg: number; heightCm: number;
  birthYear: number; unit: 'metric' | 'imperial'; onboardingComplete: boolean
}
export type Preferences = { reducedMotion: boolean; soundEnabled: boolean; remindersEnabled: boolean }
export type PlanRevision = { id: string; savedAt: string; label: string; workouts: Workout[] }
export type AppState = {
  version: 4; profile: Profile; preferences: Preferences; workouts: Workout[]; logs: WorkoutLog[];
  weightHistory: WeightEntry[]; activeSession: ActiveSession | null; planHistory: PlanRevision[]; nutrition: NutritionState
}
