import * as cheerio from 'cheerio'
import { TMDB } from 'tmdb-ts'

const LETTERBOXD_BASE = 'https://letterboxd.com'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const PAGE_DELAY_MS = 150
const MAX_PAGES = 50
const ENRICH_CONCURRENCY = 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...args) {
  console.log('[scraper]', ...args)
}

async function fetchHtml(url) {
  log(`GET ${url}`)
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
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
  const html = await fetchHtml(url)
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
      html = await fetchHtml(`${LETTERBOXD_BASE}/${username}/watchlist/page/${page}/`)
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
  return films
}

/**
 * Fetch a single film page → TMDB id/type + LbxD average rating.
 */
export async function getFilmDetails(slug) {
  const html = await fetchHtml(`${LETTERBOXD_BASE}/film/${slug}/`)
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
