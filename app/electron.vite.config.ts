import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: { outDir: 'out/main' }
  },
  preload: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    publicDir: resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          signin: resolve(__dirname, 'src/renderer/signin.html')
        }
      }
    }
  }
})
