import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { include: ['src/**/*.test.{ts,tsx}'], maxWorkers: 4 },
  server: { port: 5173 },
  preview: { port: 4173 },
})
