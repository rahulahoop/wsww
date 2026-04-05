import { Registry, Histogram, Counter, Gauge } from 'prom-client'

export const registry = new Registry()

export const watchlistScrapeDuration = new Histogram({
  name: 'wsww_watchlist_scrape_duration_seconds',
  help: 'End-to-end time to scrape a user watchlist',
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
})

export const proxyRequestDuration = new Histogram({
  name: 'wsww_proxy_request_duration_seconds',
  help: 'Latency of individual HTTP requests made through proxies',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 8],
  registers: [registry],
})

export const proxyRequestsTotal = new Counter({
  name: 'wsww_proxy_requests_total',
  help: 'Total proxy requests by outcome',
  labelNames: ['status'],
  registers: [registry],
})

export const proxyPoolGood = new Gauge({
  name: 'wsww_proxy_pool_good',
  help: 'Number of confirmed working proxies',
  registers: [registry],
})

export const proxyPoolBad = new Gauge({
  name: 'wsww_proxy_pool_bad',
  help: 'Number of proxies in the failure cooldown',
  registers: [registry],
})

export const proxyPoolTotal = new Gauge({
  name: 'wsww_proxy_pool_total',
  help: 'Total proxies loaded in the pool',
  registers: [registry],
})
