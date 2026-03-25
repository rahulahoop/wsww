import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { getWatchlistInfo, scrapeWatchlist, enrichFilms, getTmdbDetails } from './scraper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001
const LETTERBOXD_BASE = 'https://letterboxd.com'
const IS_PROD = process.env.NODE_ENV === 'production'

// In dev, allow Vite dev server origin; in prod, API and static are same origin
if (!IS_PROD) app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json())

// Fast check — fetches page 1 only to return film/page count
app.get('/api/watchlist-info', async (req, res) => {
  const { username } = req.query
  if (!username) return res.status(400).json({ error: 'username required' })
  try {
    res.json(await getWatchlistInfo(username))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// SSE — scrape one user's full watchlist
app.get('/api/watchlist', async (req, res) => {
  const { username, capMode = 'all' } = req.query
  if (!username) return res.status(400).json({ error: 'username required' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)

  try {
    const filmsMap = await scrapeWatchlist(
      username,
      (msg) => send('progress', { message: msg }),
      capMode,
    )
    const films = [...filmsMap.entries()].map(([slug, title]) => ({
      slug,
      title,
      letterboxdUrl: `${LETTERBOXD_BASE}/film/${slug}/`,
    }))
    send('result', { films })
  } catch (err) {
    send('error', { message: err.message })
  } finally {
    res.end()
  }
})

// Batch-enrich overlap slugs with LbxD ratings + TMDB ids
app.post('/api/enrich', async (req, res) => {
  const { slugs } = req.body
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs array required' })
  }
  try {
    res.json(await enrichFilms(slugs, null, process.env.TMDB_ACCESS_TOKEN ?? null))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// TMDB API — poster, overview, year, vote average for one film
app.get('/api/tmdb-details', async (req, res) => {
  const { tmdbId, tmdbType = 'movie' } = req.query
  const accessToken = process.env.TMDB_ACCESS_TOKEN
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' })
  if (!accessToken) return res.status(503).json({ error: 'TMDB_ACCESS_TOKEN not set in .env' })
  try {
    res.json(await getTmdbDetails(tmdbId, tmdbType, accessToken))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Serve built Vue frontend in production
const distDir = join(__dirname, '..', 'dist')
if (IS_PROD && existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')))
}

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
