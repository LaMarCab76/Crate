import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // Two main-process entries: the app entry and the library worker, which
        // is forked as a utilityProcess. Rollup uses the object keys as the
        // output [name], so this emits out/main/index.js + out/main/library-worker.js.
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'library-worker': resolve(__dirname, 'electron/main/workers/library-worker.ts'),
        },
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
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          'interface-guest': resolve(__dirname, 'electron/preload/interface-guest.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
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
      host: '127.0.0.1',
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
