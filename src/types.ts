export type Exercise = { id: string; name: string; sets: number; reps: string; rest: string; category: string }
export type Workout = { id: string; title: string; day: string; duration: number; calories: number; exercises: Exercise[]; completed?: boolean }
export type WorkoutLog = { id: string; workoutId: string; title: string; date: string; duration: number; calories: number }
export type Profile = { name: string; goal: string; level: string; weeklyTarget: number; weightKg: number }
export type AppState = { profile: Profile; workouts: Workout[]; logs: WorkoutLog[] }
