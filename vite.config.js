import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Local dev (`npm run dev`) serves from /. Production build (`npm run build`)
// uses /Word-Guesser/ so asset URLs resolve correctly under GitHub Pages,
// which serves the repo at https://<user>.github.io/Word-Guesser/.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/Word-Guesser/' : '/',
}))
