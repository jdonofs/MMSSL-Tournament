import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { trackerPreviewViteProxy } from './scripts/tracker_preview_vite_proxy.mjs'
import { gameControlVitePlugin } from './scripts/game_control_service.mjs'

export default defineConfig({
  plugins: [
    react(),
    trackerPreviewViteProxy({
      port: Number(process.env.TRACKER_PREVIEW_PORT || 4317),
    }),
    gameControlVitePlugin(),
  ],
  build: {
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        trackerPreview: resolve(import.meta.dirname, 'tracker-preview.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  }
})
