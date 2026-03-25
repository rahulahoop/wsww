<script setup lang="ts">
import { ref, computed } from 'vue'

interface Film {
  slug: string
  title: string
  letterboxdUrl: string
  lbxdRating?: number | null
  tmdbPoster?: string | null
  tmdbId?: string | null
  tmdbType?: string
}

interface PickResult extends Film {
  poster: string | null
  overview: string | null
  year: string | null
  tmdbVoteAverage: number | null
  genres: string[]
  overlap: Film[]
}

type Phase = 'idle' | 'checking' | 'awaiting-cap' | 'scraping' | 'enriching' | 'done'
type CapMode = 'first' | 'random'

// Module-level cache — survives re-renders, cleared on page refresh
const watchlistCache = new Map<string, Film[]>()

const users = ref<string[]>(['', ''])
const phase = ref<Phase>('idle')
const progress = ref('')
const error = ref('')
const result = ref<PickResult | null>(null)
const overlap = ref<Film[]>([])

// Cap warning state
const pageInfos = ref<Record<string, { filmCount: number; pageCount: number }>>({})
const capDecisions = ref<Record<string, CapMode>>({})

const capWarnings = computed(() =>
  Object.entries(pageInfos.value)
    .filter(([u, info]) => info.pageCount > 50 && !capDecisions.value[u])
    .map(([username, info]) => ({ username, ...info })),
)

function addUser() { users.value.push('') }
function removeUser(i: number) { if (users.value.length > 2) users.value.splice(i, 1) }

function setCapDecision(username: string, mode: CapMode) {
  capDecisions.value[username] = mode
  if (capWarnings.value.length === 0) {
    proceedWithScraping()
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function ssePromise(url: string, onProgress: (msg: string) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(url)
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'progress') onProgress(data.message)
      else if (data.type === 'result') { resolve(data); es.close() }
      else if (data.type === 'error') { reject(new Error(data.message)); es.close() }
    }
    es.onerror = () => { reject(new Error('Connection error. Is the server running?')); es.close() }
  })
}

async function fetchWatchlist(username: string, capMode: CapMode | 'all'): Promise<Film[]> {
  const key = username.toLowerCase()
  if (watchlistCache.has(key)) {
    progress.value = `Using cached watchlist for ${username}`
    return watchlistCache.get(key)!
  }
  const url = `/api/watchlist?username=${encodeURIComponent(username)}&capMode=${capMode}`
  const data = await ssePromise(url, (msg) => { progress.value = msg })
  watchlistCache.set(key, data.films)
  return data.films
}

// ── Main flow ──────────────────────────────────────────────────────────────

async function findMovie() {
  const activeUsers = users.value.map((u) => u.trim()).filter(Boolean)
  if (activeUsers.length < 2) return

  phase.value = 'checking'
  error.value = ''
  result.value = null
  overlap.value = []
  pageInfos.value = {}
  capDecisions.value = {}

  try {
    // Check page counts only for uncached users
    const uncached = activeUsers.filter((u) => !watchlistCache.has(u.toLowerCase()))

    await Promise.all(
      uncached.map(async (u) => {
        progress.value = `Checking ${u}…`
        const res = await fetch(`/api/watchlist-info?username=${encodeURIComponent(u)}`)
        const info = await res.json()
        if (info.error) throw new Error(info.error)
        pageInfos.value[u.toLowerCase()] = info
      }),
    )

    if (capWarnings.value.length > 0) {
      phase.value = 'awaiting-cap'
      return
    }

    await proceedWithScraping()
  } catch (err: any) {
    error.value = err.message
    phase.value = 'idle'
  }
}

async function proceedWithScraping() {
  phase.value = 'scraping'
  const activeUsers = users.value.map((u) => u.trim()).filter(Boolean)

  try {
    const capModeFor = (u: string): CapMode | 'all' =>
      capDecisions.value[u.toLowerCase()] ?? 'all'

    const filmLists = await Promise.all(
      activeUsers.map((u) => fetchWatchlist(u, capModeFor(u))),
    )

    progress.value = 'Finding overlap…'
    const slugSets = filmLists.map((films) => new Set(films.map((f) => f.slug)))
    const rawOverlap = filmLists[0].filter((f) => slugSets.slice(1).every((s) => s.has(f.slug)))

    if (rawOverlap.length === 0) {
      throw new Error(`No movies in common between ${activeUsers.join(', ')}`)
    }

    // Enrich all overlap films with LbxD ratings + TMDB ids
    phase.value = 'enriching'
    progress.value = `Fetching ratings for ${rawOverlap.length} films…`
    const enrichRes = await fetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: rawOverlap.map((f) => f.slug) }),
    })
    const details: Record<string, { tmdbId: string | null; tmdbType: string; lbxdRating: number | null; tmdbPoster: string | null }> =
      await enrichRes.json()

    // Merge ratings + sort by LbxD rating descending (unrated last)
    overlap.value = rawOverlap
      .map((f) => ({ ...f, ...details[f.slug] }))
      .sort((a, b) => (b.lbxdRating ?? -1) - (a.lbxdRating ?? -1))

    await pickFrom(overlap.value)
    phase.value = 'done'
  } catch (err: any) {
    error.value = err.message
    phase.value = 'idle'
  }
}

async function pickFrom(candidates: Film[]) {
  const pick = candidates[Math.floor(Math.random() * candidates.length)]
  progress.value = `Getting details for "${pick.title}"…`

  let tmdb: Partial<PickResult> = { poster: null, overview: null, year: null, tmdbVoteAverage: null, genres: [] }
  if (pick.tmdbId) {
    const res = await fetch(`/api/tmdb-details?tmdbId=${pick.tmdbId}&tmdbType=${pick.tmdbType ?? 'movie'}`)
    const data = await res.json()
    if (!data.error) tmdb = { poster: data.poster, overview: data.overview, year: data.year, tmdbVoteAverage: data.voteAverage, genres: data.genres }
  }

  result.value = { ...pick, ...tmdb, overlap: overlap.value } as PickResult
}

async function pickAnother() {
  if (!overlap.value.length || !result.value) return
  const candidates = overlap.value.filter((f) => f.slug !== result.value!.slug)
  await pickFrom(candidates)
}

function formatRating(r: number | null | undefined) {
  return r != null ? r.toFixed(2) : null
}
</script>

<template>
  <div class="min-h-screen bg-[#14181C] text-gray-100 flex flex-col items-center px-4 py-12 sm:py-20">

    <!-- Header -->
    <header class="text-center mb-10">
      <h1 class="text-6xl sm:text-7xl font-black tracking-tighter text-white leading-none">wsww</h1>
      <p class="mt-2 text-sm text-gray-500 tracking-widest uppercase">what should we watch</p>
      <p class="mt-4 text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">
        Add two or more <a href="https://letterboxd.com" target="_blank" class="text-gray-400 hover:text-white transition-colors underline underline-offset-2">Letterboxd</a> usernames,
        find the films on all your watchlists, and get a random pick — sorted by community rating.
      </p>
    </header>

    <!-- Form -->
    <form @submit.prevent="findMovie" class="w-full max-w-md flex flex-col gap-3">
      <div v-for="(_, i) in users" :key="i" class="flex gap-2">
        <input v-model="users[i]" :placeholder="`Letterboxd username ${i + 1}`"
          :disabled="phase !== 'idle' && phase !== 'done'"
          class="flex-1 bg-[#1e2429] border border-[#2c3440] rounded-lg px-4 py-3 text-gray-100 placeholder-gray-600 text-base outline-none focus:border-[#00c030] transition-colors disabled:opacity-40" />
        <button v-if="users.length > 2" type="button" @click="removeUser(i)"
          :disabled="phase !== 'idle' && phase !== 'done'"
          class="shrink-0 w-11 bg-[#1e2429] border border-[#2c3440] rounded-lg text-gray-500 hover:text-red-400 hover:border-red-800 transition-colors disabled:opacity-40 cursor-pointer text-lg">
          ×
        </button>
      </div>
      <button type="button" @click="addUser"
        :disabled="phase !== 'idle' && phase !== 'done'"
        class="w-full border border-dashed border-[#2c3440] hover:border-[#00c030]/50 text-gray-600 hover:text-[#00c030] text-sm py-2.5 rounded-lg transition-colors disabled:opacity-40 cursor-pointer">
        + Add user
      </button>
      <button type="submit"
        :disabled="(phase !== 'idle' && phase !== 'done') || users.filter(u => u.trim()).length < 2"
        class="w-full bg-[#00c030] hover:bg-[#00a828] text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
        {{ ['checking', 'scraping', 'enriching'].includes(phase) ? 'Searching…' : 'Find a movie' }}
      </button>
    </form>

    <!-- Progress -->
    <p v-if="['checking','scraping','enriching'].includes(phase)"
      class="mt-6 text-sm text-gray-500 animate-pulse text-center">{{ progress }}</p>

    <!-- Error -->
    <p v-if="error"
      class="mt-6 text-sm text-red-400 bg-red-950/40 border border-red-800/40 rounded-lg px-4 py-3 w-full max-w-md text-center">
      {{ error }}
    </p>

    <!-- Cap warnings -->
    <div v-if="phase === 'awaiting-cap'" class="w-full max-w-md mt-8 flex flex-col gap-4">
      <div v-for="warn in capWarnings" :key="warn.username"
        class="bg-[#1e2429] border border-yellow-700/40 rounded-2xl p-5">
        <p class="text-yellow-400 font-semibold mb-1">Large watchlist detected</p>
        <p class="text-gray-400 text-sm mb-4">
          <span class="text-white font-medium">{{ warn.username }}</span> has
          ~{{ warn.filmCount.toLocaleString() }} films across {{ warn.pageCount }} pages.
          Scraping all of them would take a while — choose how to sample:
        </p>
        <div class="flex gap-2">
          <button @click="setCapDecision(warn.username, 'first')"
            class="flex-1 bg-[#2c3440] hover:bg-[#363f4d] text-gray-200 text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer">
            First 50 pages
          </button>
          <button @click="setCapDecision(warn.username, 'random')"
            class="flex-1 bg-[#00c030]/15 hover:bg-[#00c030]/25 border border-[#00c030]/30 text-[#00c030] text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer">
            Random 50 pages
          </button>
        </div>
      </div>
    </div>

    <!-- Results -->
    <div v-if="result" class="w-full max-w-md mt-10 flex flex-col gap-6">

      <!-- Pick card -->
      <div class="bg-[#1e2429] border border-[#2c3440] rounded-2xl overflow-hidden shadow-xl shadow-black/40">

        <!-- Poster + info layout -->
        <div class="flex gap-0">
          <!-- Poster -->
          <div v-if="result.poster" class="shrink-0 w-32 sm:w-40">
            <img :src="result.poster" :alt="result.title" class="w-full h-full object-cover" />
          </div>

          <!-- Info -->
          <div class="flex-1 p-5 sm:p-6 flex flex-col justify-between min-w-0">
            <div>
              <p class="text-xs uppercase tracking-widest text-gray-500 mb-1">tonight's pick</p>
              <h2 class="text-xl sm:text-2xl font-bold text-white leading-tight">{{ result.title }}</h2>
              <p v-if="result.year" class="text-gray-500 text-sm mt-0.5">{{ result.year }}</p>

              <!-- Ratings row -->
              <div class="flex flex-wrap gap-2 mt-3">
                <span v-if="result.lbxdRating" class="text-xs bg-[#2c3440] text-[#00c030] px-2.5 py-1 rounded-full font-medium">
                  ★ {{ formatRating(result.lbxdRating) }} LbxD
                </span>
                <span v-if="result.tmdbVoteAverage" class="text-xs bg-[#2c3440] text-blue-400 px-2.5 py-1 rounded-full font-medium">
                  {{ result.tmdbVoteAverage.toFixed(1) }} TMDB
                </span>
              </div>

              <!-- Genres -->
              <div v-if="result.genres?.length" class="flex flex-wrap gap-1.5 mt-2">
                <span v-for="g in result.genres.slice(0, 3)" :key="g"
                  class="text-xs text-gray-500 bg-[#14181C] px-2 py-0.5 rounded-full">{{ g }}</span>
              </div>
            </div>

            <!-- Links -->
            <div class="flex gap-2 mt-4">
              <a :href="result.letterboxdUrl" target="_blank"
                class="text-xs bg-[#00c030]/10 text-[#00c030] border border-[#00c030]/30 px-3 py-1.5 rounded-full no-underline hover:bg-[#00c030]/20 transition-colors">
                Letterboxd ↗
              </a>
            </div>
          </div>
        </div>

        <!-- Overview -->
        <p v-if="result.overview"
          class="px-5 pb-4 sm:px-6 sm:pb-5 text-sm text-gray-400 leading-relaxed line-clamp-3 border-t border-[#2c3440] pt-4">
          {{ result.overview }}
        </p>

        <!-- Pick another -->
        <div class="px-5 pt-3 pb-5 sm:px-6 sm:pb-6">
          <button @click="pickAnother"
            class="w-full bg-[#2c3440] hover:bg-[#363f4d] text-gray-300 font-medium text-sm py-2.5 rounded-lg transition-colors cursor-pointer">
            Pick another
          </button>
        </div>
      </div>

      <!-- Overlap list -->
      <div>
        <p class="text-xs uppercase tracking-widest text-gray-500 mb-3">
          {{ result.overlap.length }} movies {{ users.filter(u => u.trim()).length > 2 ? 'you all' : 'you both' }} want to watch
        </p>
        <ul class="bg-[#1e2429] border border-[#2c3440] rounded-2xl overflow-y-auto max-h-[320px] divide-y divide-[#2c3440]">
          <li v-for="film in result.overlap" :key="film.slug"
            :class="film.slug === result.slug ? 'bg-[#00c030]/10' : ''">
            <a :href="film.letterboxdUrl" target="_blank"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm no-underline transition-colors',
                film.slug === result.slug
                  ? 'text-[#00c030] font-semibold'
                  : 'text-gray-400 hover:text-gray-100 hover:bg-white/5'
              ]">
              <!-- Poster thumbnail -->
              <div class="shrink-0 w-7 h-10 rounded overflow-hidden bg-[#2c3440]">
                <img v-if="film.tmdbPoster" :src="film.tmdbPoster" :alt="film.title"
                  class="w-full h-full object-cover" />
              </div>
              <span class="flex-1 truncate">{{ film.title }}</span>
              <span v-if="film.lbxdRating" class="shrink-0 text-xs text-gray-500">
                ★ {{ formatRating(film.lbxdRating) }}
              </span>
            </a>
          </li>
        </ul>
      </div>

    </div>
    <!-- Footer -->
    <footer class="mt-16 text-center text-xs text-gray-600">
      <img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
        alt="TMDB" class="h-3 inline-block opacity-40 mr-1.5 align-middle" />
      <span class="align-middle">This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
    </footer>

  </div>
</template>
