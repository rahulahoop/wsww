import * as cheerio from 'cheerio'
import { TMDB } from 'tmdb-ts'
import { ProxyAgent } from 'undici'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  watchlistScrapeDuration,
  proxyRequestDuration,
  proxyRequestsTotal,
  proxyPoolGood,
  proxyPoolBad,
  proxyPoolTotal,
} from './metrics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LETTERBOXD_BASE = 'https://letterboxd.com'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_DELAY_MS = 150
const MAX_PAGES = 50
const ENRICH_CONCURRENCY = 10

const PROXY_LIST_URLS = [
  'https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
]
const PROXY_REFRESH_MS = 60 * 60 * 1000   // refresh list every hour
const PROXY_FAIL_COOLDOWN = 10 * 60 * 1000 // retry failed proxy after 10 min
const PROXY_TIMEOUT_MS = 8000
const MAX_PROXY_ATTEMPTS = 10
const CANARY_URL = `${LETTERBOXD_BASE}/films/`
const CANARY_TARGET = 10  // stop once this many good proxies confirmed
const CANARY_CONCURRENCY = 20

const GOOD_PROXIES_FILE = process.env.GOOD_PROXIES_FILE || '/data/good_proxies.txt'

function loadBundledProxies() {
  try {
    const txt = readFileSync(join(__dirname, '..', 'proxies.txt'), 'utf8')
    const proxies = txt.trim().split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
    log(`Loaded ${proxies.length} proxies from bundled file`)
    return proxies
  } catch {
    return []
  }
}

function loadPersistedGoodProxies() {
  try {
    const txt = readFileSync(GOOD_PROXIES_FILE, 'utf8')
    const proxies = txt.trim().split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
    log(`Loaded ${proxies.length} persisted good proxies from ${GOOD_PROXIES_FILE}`)
    return proxies
  } catch {
    return []
  }
}

let _saveTimer = null
function scheduleGoodProxiesSave() {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(GOOD_PROXIES_FILE), { recursive: true })
      writeFileSync(GOOD_PROXIES_FILE, [...proxyState.good].join('\n') + '\n', 'utf8')
      log(`Saved ${proxyState.good.size} good proxies to ${GOOD_PROXIES_FILE}`)
    } catch (err) {
      log(`Failed to save good proxies: ${err.message}`)
    }
  }, 5000)
}

function updateProxyGauges() {
  proxyPoolGood.set(proxyState.good.size)
  proxyPoolBad.set(proxyState.bad.size)
  proxyPoolTotal.set(proxyState.all.length)
}

const _persistedGood = loadPersistedGoodProxies()
const _bundled = loadBundledProxies()

const proxyState = {
  all: [...new Set([..._persistedGood, ..._bundled])],
  good: new Set(),       // confirmed working this session
  bad: new Map(),        // proxy -> timestamp of failure
  lastFetch: 0,
}

export function getProxyStats() {
  return {
    total: proxyState.all.length,
    good: proxyState.good.size,
    bad: proxyState.bad.size,
    lastFetch: proxyState.lastFetch,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...args) {
  console.log('[scraper]', ...args)
}

async function refreshProxies() {
  if (Date.now() - proxyState.lastFetch < PROXY_REFRESH_MS && proxyState.all.length > 0) return
  for (const url of PROXY_LIST_URLS) {
    try {
      const res = await fetch(url)
      const text = await res.text()
      const proxies = text
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
      proxyState.all = proxies
      proxyState.lastFetch = Date.now()
      log(`Loaded ${proxies.length} proxies from ${url}`)
      return
    } catch (err) {
      log(`Failed to fetch proxy list from ${url}: ${err.message}`)
    }
  }
}

/**
 * Test proxies against a real Letterboxd page in the background.
 * Stops once CANARY_TARGET good proxies are confirmed.
 * Safe to call without awaiting — logs progress, never throws.
 */
export async function warmProxies() {
  if (IS_DEV) {
    log('Canary: skipped in dev mode')
    return
  }
  await refreshProxies()
  if (proxyState.all.length === 0) {
    log('Canary: no proxies to warm')
    return
  }

  log(`Canary: warming proxy pool, targeting ${CANARY_TARGET} good proxies…`)
  const candidates = shuffle([...proxyState.all])

  for (let i = 0; i < candidates.length; i += CANARY_CONCURRENCY) {
    if (proxyState.good.size >= CANARY_TARGET) break
    const batch = candidates.slice(i, i + CANARY_CONCURRENCY)
    await Promise.all(
      batch.map(async (proxy) => {
        if (proxyState.good.size >= CANARY_TARGET) return
        try {
          await fetchWithProxy(CANARY_URL, proxy)
          proxyState.good.add(proxy)
          proxyState.bad.delete(proxy)
          updateProxyGauges()
          scheduleGoodProxiesSave()
          log(`Canary: ${proxy} OK (${proxyState.good.size}/${CANARY_TARGET})`)
        } catch {
          proxyState.bad.set(proxy, Date.now())
          updateProxyGauges()
        }
      }),
    )
  }

  log(`Canary: done — ${proxyState.good.size} good proxies ready`)
}

function pickProxy() {
  const now = Date.now()
  // Prefer known-good proxies
  if (proxyState.good.size > 0) {
    const arr = [...proxyState.good]
    return arr[Math.floor(Math.random() * arr.length)]
  }
  // Fall back to untested or cooled-down bad proxies
  const candidates = proxyState.all.filter((p) => {
    const failedAt = proxyState.bad.get(p)
    return !failedAt || now - failedAt >= PROXY_FAIL_COOLDOWN
  })
  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

// Fetches a Letterboxd URL through a rotating proxy.
// TMDB calls use tmdb-ts directly and are never proxied.
async function fetchWithProxy(url, proxy) {
  const endTimer = proxyRequestDuration.startTimer()
  try {
    const dispatcher = new ProxyAgent(`http://${proxy}`, {
      connectTimeout: PROXY_TIMEOUT_MS,
      headersTimeout: PROXY_TIMEOUT_MS,
      bodyTimeout: PROXY_TIMEOUT_MS,
    })
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      dispatcher,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    endTimer()
    proxyRequestsTotal.inc({ status: 'success' })
    return html
  } catch (err) {
    endTimer()
    proxyRequestsTotal.inc({ status: 'failure' })
    throw err
  }
}

const IS_DEV = process.env.NODE_ENV !== 'production'

async function fetchLetterboxd(url) {
  log(`GET ${url}`)

  if (IS_DEV) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  await refreshProxies()

  let lastErr
  for (let attempt = 0; attempt < MAX_PROXY_ATTEMPTS; attempt++) {
    const proxy = pickProxy()
    if (!proxy) {
      const msg = proxyState.all.length === 0
        ? 'Proxy list is empty — failed to load from GitHub. Please try again shortly.'
        : 'All proxies are currently exhausted. Please try again in a few minutes.'
      throw new Error(msg)
    }

    try {
      const html = await fetchWithProxy(url, proxy)
      proxyState.good.add(proxy)
      proxyState.bad.delete(proxy)
      updateProxyGauges()
      scheduleGoodProxiesSave()
      log(`  → proxy ${proxy} OK`)
      return html
    } catch (err) {
      log(`  → proxy ${proxy} failed (${err.message})`)
      proxyState.good.delete(proxy)
      proxyState.bad.set(proxy, Date.now())
      updateProxyGauges()
      scheduleGoodProxiesSave()
      lastErr = err
    }
  }
  throw new Error(`Unable to reach Letterboxd after ${MAX_PROXY_ATTEMPTS} attempts — proxies may be temporarily unavailable. Please try again shortly.`)
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Fetch page 1 only to get total film/page count.
 */
export async function getWatchlistInfo(username) {
  const url = `${LETTERBOXD_BASE}/${username}/watchlist/`
  const html = await fetchLetterboxd(url)
  const $ = cheerio.load(html)

  const countText = $('.js-watchlist-count').text().replace(/[^\d]/g, '')
  const filmCount = parseInt(countText) || 0

  if (filmCount === 0 && !$('div.react-component[data-component-class="LazyPoster"]').length) {
    throw new Error(`No watchlist found for user "${username}"`)
  }

  const pageCount = Math.ceil(filmCount / 28)
  log(`Watchlist info for ${username}: ${filmCount} films, ${pageCount} pages`)
  return { filmCount, pageCount }
}

/**
 * Scrape a user's watchlist.
 * capMode: 'all' | 'first' | 'random'
 *   'first'  → pages 1..50
 *   'random' → 50 randomly sampled pages
 *   'all'    → every page (no cap)
 */
export async function scrapeWatchlist(username, onProgress, capMode = 'all') {
  const endScrape = watchlistScrapeDuration.startTimer({ username })
  const { filmCount, pageCount } = await getWatchlistInfo(username)

  let pagesToScrape
  if (capMode === 'random') {
    const all = Array.from({ length: pageCount }, (_, i) => i + 1)
    pagesToScrape = shuffle(all).slice(0, MAX_PAGES).sort((a, b) => a - b)
  } else if (capMode === 'first') {
    pagesToScrape = Array.from({ length: Math.min(pageCount, MAX_PAGES) }, (_, i) => i + 1)
  } else {
    pagesToScrape = Array.from({ length: pageCount }, (_, i) => i + 1)
  }

  log(`Scraping ${username}: ${pagesToScrape.length} pages (capMode=${capMode}, total=${pageCount})`)
  const films = new Map()

  for (const page of pagesToScrape) {
    const msg = `Scraping ${username} page ${page} of ${pageCount}…`
    log(msg)
    onProgress?.(msg)

    let html
    try {
      html = await fetchLetterboxd(`${LETTERBOXD_BASE}/${username}/watchlist/page/${page}/`)
    } catch (err) {
      log(`  → skipping page ${page}: ${err.message}`)
      continue
    }

    const $ = cheerio.load(html)
    $('div.react-component[data-component-class="LazyPoster"]').each((_, el) => {
      const slug = $(el).attr('data-item-slug')
      const title = $(el).attr('data-item-name')
      if (slug) films.set(slug, title)
    })

    await sleep(PAGE_DELAY_MS)
  }

  log(`Finished ${username}: ${films.size} films from ${pagesToScrape.length} pages`)
  endScrape()
  return films
}

/**
 * Fetch a single film page → TMDB id/type + LbxD average rating.
 */
export async function getFilmDetails(slug) {
  const html = await fetchLetterboxd(`${LETTERBOXD_BASE}/film/${slug}/`)
  const $ = cheerio.load(html)
  const body = $('body')

  const tmdbId = body.attr('data-tmdb-id') ?? null
  const tmdbType = body.attr('data-tmdb-type') ?? 'movie'

  const ratingContent = $('meta[name="twitter:data2"]').attr('content') ?? ''
  const match = ratingContent.match(/^([\d.]+)\s+out of 5/)
  const lbxdRating = match ? parseFloat(match[1]) : null

  log(`Film details ${slug}: tmdb=${tmdbId} lbxd=${lbxdRating}`)
  return { tmdbId, tmdbType, lbxdRating }
}

/**
 * Batch-fetch film details for an array of slugs, ENRICH_CONCURRENCY at a time.
 * If accessToken is provided, also fetches TMDB poster for each film.
 * Returns { [slug]: { tmdbId, tmdbType, lbxdRating, tmdbPoster } }
 */
export async function enrichFilms(slugs, onProgress, accessToken = null) {
  const tmdbClient = accessToken ? new TMDB(accessToken) : null
  const results = {}

  for (let i = 0; i < slugs.length; i += ENRICH_CONCURRENCY) {
    const batch = slugs.slice(i, i + ENRICH_CONCURRENCY)
    const msg = `Fetching ratings ${i + 1}–${Math.min(i + ENRICH_CONCURRENCY, slugs.length)} of ${slugs.length}…`
    log(msg)
    onProgress?.(msg)

    const batchResults = await Promise.all(
      batch.map(async (slug) => {
        try {
          const details = await getFilmDetails(slug)
          let tmdbPoster = null
          if (tmdbClient && details.tmdbId) {
            try {
              const id = parseInt(details.tmdbId, 10)
              const data = details.tmdbType === 'tv'
                ? await tmdbClient.tvSeries.details(id)
                : await tmdbClient.movies.details(id)
              tmdbPoster = data.poster_path
                ? `https://image.tmdb.org/t/p/w154${data.poster_path}`
                : null
            } catch { /* no poster */ }
          }
          return { ...details, tmdbPoster }
        } catch {
          return { tmdbId: null, tmdbType: 'movie', lbxdRating: null, tmdbPoster: null }
        }
      }),
    )

    batch.forEach((slug, j) => { results[slug] = batchResults[j] })
  }
  return results
}

/**
 * Fetch poster, overview, year, vote average from the TMDB API.
 * Requires a v4 access token (the long Bearer JWT from TMDB settings).
 */
export async function getTmdbDetails(tmdbId, tmdbType, accessToken) {
  const tmdb = new TMDB(accessToken)
  const id = parseInt(tmdbId, 10)

  if (tmdbType === 'tv') {
    const show = await tmdb.tvSeries.details(id)
    return {
      poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
      overview: show.overview ?? null,
      year: show.first_air_date?.slice(0, 4) ?? null,
      voteAverage: show.vote_average ?? null,
      genres: show.genres?.map((g) => g.name) ?? [],
    }
  }

  const movie = await tmdb.movies.details(id)
  return {
    poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
    overview: movie.overview ?? null,
    year: movie.release_date?.slice(0, 4) ?? null,
    voteAverage: movie.vote_average ?? null,
    genres: movie.genres?.map((g) => g.name) ?? [],
  }
}
