import type { AppState } from './types'

export const initialState: AppState = {
  profile: { name: 'Alex', goal: 'Build muscle', level: 'Intermediate', weeklyTarget: 4, weightKg: 72 },
  workouts: [
    { id: 'push', title: 'Upper Body Power', day: 'Monday', duration: 50, calories: 420, exercises: [
      { id: 'bench', name: 'Bench Press', sets: 4, reps: '6–8', rest: '120 sec', category: 'Chest' },
      { id: 'row', name: 'Barbell Row', sets: 4, reps: '8–10', rest: '90 sec', category: 'Back' },
      { id: 'ohp', name: 'Overhead Press', sets: 3, reps: '8–10', rest: '90 sec', category: 'Shoulders' },
      { id: 'pullup', name: 'Pull-ups', sets: 3, reps: 'AMRAP', rest: '90 sec', category: 'Back' }
    ]},
    { id: 'legs', title: 'Lower Body Strength', day: 'Wednesday', duration: 55, calories: 470, exercises: [
      { id: 'squat', name: 'Back Squat', sets: 4, reps: '5–8', rest: '150 sec', category: 'Legs' },
      { id: 'rdl', name: 'Romanian Deadlift', sets: 3, reps: '8–10', rest: '120 sec', category: 'Hamstrings' },
      { id: 'lunge', name: 'Walking Lunge', sets: 3, reps: '10 / side', rest: '75 sec', category: 'Legs' },
      { id: 'calf', name: 'Standing Calf Raise', sets: 4, reps: '12–15', rest: '60 sec', category: 'Calves' }
    ]},
    { id: 'full', title: 'Full Body Conditioning', day: 'Friday', duration: 40, calories: 380, exercises: [
      { id: 'deadlift', name: 'Trap Bar Deadlift', sets: 4, reps: '6', rest: '120 sec', category: 'Full body' },
      { id: 'dbpress', name: 'Dumbbell Press', sets: 3, reps: '10', rest: '75 sec', category: 'Chest' },
      { id: 'cable', name: 'Cable Row', sets: 3, reps: '12', rest: '75 sec', category: 'Back' },
      { id: 'bike', name: 'Bike Intervals', sets: 8, reps: '30 sec', rest: '30 sec', category: 'Cardio' }
    ]}
  ],
  logs: [
    { id: 'l1', workoutId: 'push', title: 'Upper Body Power', date: '2026-07-21', duration: 48, calories: 405 },
    { id: 'l2', workoutId: 'legs', title: 'Lower Body Strength', date: '2026-07-23', duration: 57, calories: 482 },
    { id: 'l3', workoutId: 'full', title: 'Full Body Conditioning', date: '2026-07-25', duration: 41, calories: 392 },
    { id: 'l4', workoutId: 'push', title: 'Upper Body Power', date: '2026-07-28', duration: 51, calories: 431 }
  ]
}
