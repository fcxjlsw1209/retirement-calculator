import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      // Proxy API calls to FastAPI during local development
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
