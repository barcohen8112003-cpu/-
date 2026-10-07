import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  plugins: [react()],
  // In development the API runs separately (npm run api).
  server: { proxy: { '/api': 'http://localhost:3001' } },
})
