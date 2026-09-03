/* Offline shell for 3D Core Studio. CDN Three.js is not cached here. */
const CACHE = '3dcore-shell-v1';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/app.js', '/js/mesh_tools.js', '/js/bim_kit.js', '/js/format_io.js', '/js/zip_store.js', '/js/render_adapter.js', '/manifest.json', '/icons/logo.svg'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;
    event.respondWith(
        caches.match(req).then(hit => hit || fetch(req).then(res => {
            if (res.ok && url.pathname.startsWith('/js/')) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy));
            }
            return res;
        }).catch(() => caches.match('/index.html')))
    );
});
