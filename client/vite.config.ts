import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web client talks to the gitdaemon Rust server at
// http://127.0.0.1:4789 (overridable with ?server=<url> or localStorage).
export default defineConfig({
  plugins: [react()],
})
