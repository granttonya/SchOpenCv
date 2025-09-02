const CACHE_NAME = 'schematic-studio-v13';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './app.js?v=6',
  './cv-worker.js'
];
// Normalize to pathnames for match checks
const ASSET_PATHS = ASSETS.map(a => new URL(a, location).pathname);
const ROOT_PATH = new URL('./', location).pathname; // respects GitHub Pages subpath

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method!=='GET'){ return }
  const url = new URL(req.url);
  if(url.origin===location.origin){
    const OPENCV_PREFIX = new URL('./opencv/', location).pathname;
    const VENDOR_PREFIX = new URL('./vendor/', location).pathname;
    // Network-first for HTML entry to avoid stale app shell
    if(url.pathname===ROOT_PATH || url.pathname===(ROOT_PATH+'index.html')){
      e.respondWith(fetch(req).catch(()=>caches.match(req)));
      return;
    }
    // Cache-first for static assets
    if(ASSET_PATHS.includes(url.pathname)){
      e.respondWith(caches.match(req).then(r=>r||fetch(req)));
      return;
    }
    // Runtime cache for large OpenCV assets (cache on first use)
    if(url.pathname.startsWith(OPENCV_PREFIX)){
      e.respondWith(
        caches.match(req).then(r=>{
          if(r) return r;
          return fetch(req).then(resp=>{
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(c=>c.put(req, copy)).catch(()=>{});
            return resp;
          });
        })
      );
      return;
    }
    // Runtime cache for vendor libs (UTIF, etc.)
    if(url.pathname.startsWith(VENDOR_PREFIX)){
      e.respondWith(
        caches.match(req).then(r=>{
          if(r) return r;
          return fetch(req).then(resp=>{
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(c=>c.put(req, copy)).catch(()=>{});
            return resp;
          });
        })
      );
      return;
    }
  }
  // Default: network-first, fallback to cache
  e.respondWith(fetch(req).catch(()=>caches.match(req)));
});
