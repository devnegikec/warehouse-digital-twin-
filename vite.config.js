import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    /**
     * three.js is ~920 kB and is a fixed third-party artefact: it cannot be split further
     * without giving up the features both modes use. Leaving the default 500 kB warning in
     * place would mean shipping a build that always warns, which trains people to ignore
     * warnings. The limit is raised for that chunk, deliberately and with a number that
     * would still fail if the *application* chunk grew to match it.
     */
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        /**
         * Split the vendor libraries into their own chunks.
         *
         * Both modes render 3D, so three/drei is needed by either one entering the app —
         * splitting does not make first paint cheaper, and claiming otherwise would just
         * be a smaller number on a report. What it does buy is caching: a change to
         * application code no longer invalidates the ~1 MB of three.js, which is the file
         * least likely to change and most expensive to re-download.
         *
         * A function, not the object form: this Vite runs rolldown, which requires it.
         */
        manualChunks(id) {
          // Checked before react, because `@react-three/*` sits under a name that would
          // otherwise be captured by the react match.
          if (id.includes('node_modules/three') || id.includes('node_modules/@react-three')) {
            return 'three'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react'
          }
          return undefined
        },
      },
    },
  },
})
