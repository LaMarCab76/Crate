import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'electron/main'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'electron/renderer'),
    server: {
      port: 6100,
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'electron/renderer/index.html'),
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'electron/renderer/src'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
})
