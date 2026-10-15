import type { NutritionState } from './nutrition.js'
export type Goal = 'Build muscle' | 'Lose fat' | 'Improve endurance' | 'Stay active'
export type Level = 'Beginner' | 'Intermediate' | 'Advanced'
export type Exercise = {
  id: string; name: string; sets: number; reps: string; restSeconds: number; category: string; notes?: string
}
export type Workout = {
  id: string; title: string; day: string; duration: number; calories: number; difficulty: Level; description: string; exercises: Exercise[]
}
export type ExerciseSet = {
  id: string; exerciseId: string; setNumber: number; reps: number | null; weightKg: number | null;
  seconds: number | null; rpe: number | null; warmup: boolean; completed: boolean
}
export type ActiveSession = {
  id: string; workout: Workout; startedAt: string; elapsedSeconds: number; runningSince: number | null;
  sets: ExerciseSet[]; notes: string; restUntil: number | null
}
export type WorkoutLog = {
  id: string; workoutId: string; title: string; startedAt: string; completedAt: string; duration: number;
  durationSeconds?: number; calories: number; completedExerciseIds: string[]; notes?: string; sets?: ExerciseSet[];
  exerciseSnapshots?: Pick<Exercise, 'id' | 'name' | 'category'>[]
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
