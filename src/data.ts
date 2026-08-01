import type { AppState } from './types'

export const initialState: AppState = {
  version: 2,
  profile: {
    name: 'Alex', goal: 'Build muscle', level: 'Intermediate', weeklyTarget: 4,
    weightKg: 72, heightCm: 178, birthYear: 1992, unit: 'metric', onboardingComplete: false,
  },
  preferences: { reducedMotion: false, soundEnabled: true, remindersEnabled: false },
  workouts: [
    {
      id: 'upper-power', title: 'Upper Body Power', day: 'Monday', duration: 50, calories: 420,
      difficulty: 'Intermediate', description: 'A strength-focused upper-body session built around compound lifts.',
      exercises: [
        { id: 'bench', name: 'Bench Press', sets: 4, reps: '6–8', restSeconds: 120, category: 'Chest', notes: 'Keep shoulder blades retracted.' },
        { id: 'row', name: 'Barbell Row', sets: 4, reps: '8–10', restSeconds: 90, category: 'Back' },
        { id: 'ohp', name: 'Overhead Press', sets: 3, reps: '8–10', restSeconds: 90, category: 'Shoulders' },
        { id: 'pullup', name: 'Pull-ups', sets: 3, reps: 'AMRAP', restSeconds: 90, category: 'Back' },
        { id: 'curl', name: 'Dumbbell Curl', sets: 3, reps: '10–12', restSeconds: 60, category: 'Arms' },
      ],
    },
    {
      id: 'lower-strength', title: 'Lower Body Strength', day: 'Wednesday', duration: 55, calories: 470,
      difficulty: 'Intermediate', description: 'Build leg strength and posterior-chain capacity with controlled reps.',
      exercises: [
        { id: 'squat', name: 'Back Squat', sets: 4, reps: '5–8', restSeconds: 150, category: 'Legs' },
        { id: 'rdl', name: 'Romanian Deadlift', sets: 3, reps: '8–10', restSeconds: 120, category: 'Hamstrings' },
        { id: 'lunge', name: 'Walking Lunge', sets: 3, reps: '10 / side', restSeconds: 75, category: 'Legs' },
        { id: 'calf', name: 'Standing Calf Raise', sets: 4, reps: '12–15', restSeconds: 60, category: 'Calves' },
        { id: 'plank', name: 'Front Plank', sets: 3, reps: '45 sec', restSeconds: 45, category: 'Core' },
      ],
    },
    {
      id: 'conditioning', title: 'Full Body Conditioning', day: 'Friday', duration: 40, calories: 380,
      difficulty: 'Intermediate', description: 'A fast-moving session to improve work capacity and total-body fitness.',
      exercises: [
        { id: 'deadlift', name: 'Trap Bar Deadlift', sets: 4, reps: '6', restSeconds: 120, category: 'Full body' },
        { id: 'dbpress', name: 'Dumbbell Press', sets: 3, reps: '10', restSeconds: 75, category: 'Chest' },
        { id: 'cable', name: 'Cable Row', sets: 3, reps: '12', restSeconds: 75, category: 'Back' },
        { id: 'goblet', name: 'Goblet Squat', sets: 3, reps: '12', restSeconds: 60, category: 'Legs' },
        { id: 'bike', name: 'Bike Intervals', sets: 8, reps: '30 sec', restSeconds: 30, category: 'Cardio' },
      ],
    },
    {
      id: 'mobility', title: 'Mobility & Recovery', day: 'Sunday', duration: 25, calories: 120,
      difficulty: 'Beginner', description: 'Restore range of motion and reduce stiffness between training days.',
      exercises: [
        { id: 'catcow', name: 'Cat–Cow', sets: 2, reps: '10', restSeconds: 20, category: 'Spine' },
        { id: 'hip90', name: '90/90 Hip Switch', sets: 3, reps: '8 / side', restSeconds: 30, category: 'Hips' },
        { id: 'thoracic', name: 'Open Book Rotation', sets: 2, reps: '10 / side', restSeconds: 20, category: 'Upper back' },
        { id: 'couch', name: 'Couch Stretch', sets: 2, reps: '45 sec / side', restSeconds: 20, category: 'Hip flexors' },
      ],
    },
  ],
  logs: [],
  weightHistory: [{ id: 'weight-start', date: new Date().toISOString().slice(0, 10), weightKg: 72 }],
}
