// Build replaces the asset list and cache version with this release's exact files.
const CACHE_NAME = 'fitflow-shell-__BUILD_ID__'
const APP_SHELL = __PRECACHE_ASSETS__
const allowedPaths = new Set(APP_SHELL)

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)))
  // Activate after existing clients close, so an in-progress workout is not reloaded.
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('fitflow-shell-') || key === 'fitflow-v2') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(CACHE_NAME)).match('/index.html').then(response => response || Response.error())))
    return
  }
  // Never cache API calls, user uploads, account responses, or third-party data.
  if (!allowedPaths.has(url.pathname)) return
  event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)))
})
