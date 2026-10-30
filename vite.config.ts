import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    proxy: {
      // 前端一律透過同源 /ws 連線，開發時由 Vite 轉發到後端
      '/ws': {
        target: 'ws://localhost:4001',
        ws: true,
      },
      '/upload': {
        target: 'http://localhost:4001',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
})
