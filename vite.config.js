import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Use relative asset paths in production so the same build runs on any
// host — GitHub Pages (https://12ez.github.io/Word-Guesser/),
// CrazyGames (https://files.crazygames.com/<game>/), or anywhere else.
// Local dev (`npm run dev`) still serves from /.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? './' : '/',
}))
