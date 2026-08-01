export type Goal = 'Build muscle' | 'Lose fat' | 'Improve endurance' | 'Stay active'
export type Level = 'Beginner' | 'Intermediate' | 'Advanced'

export type Exercise = {
  id: string
  name: string
  sets: number
  reps: string
  restSeconds: number
  category: string
  notes?: string
}

export type Workout = {
  id: string
  title: string
  day: string
  duration: number
  calories: number
  difficulty: Level
  description: string
  exercises: Exercise[]
}

export type WorkoutLog = {
  id: string
  workoutId: string
  title: string
  startedAt: string
  completedAt: string
  duration: number
  calories: number
  completedExerciseIds: string[]
  notes?: string
}

export type WeightEntry = { id: string; date: string; weightKg: number }

export type Profile = {
  name: string
  goal: Goal
  level: Level
  weeklyTarget: number
  weightKg: number
  heightCm: number
  birthYear: number
  unit: 'metric' | 'imperial'
  onboardingComplete: boolean
}

export type Preferences = {
  reducedMotion: boolean
  soundEnabled: boolean
  remindersEnabled: boolean
}

export type AppState = {
  version: 2
  profile: Profile
  preferences: Preferences
  workouts: Workout[]
  logs: WorkoutLog[]
  weightHistory: WeightEntry[]
}
