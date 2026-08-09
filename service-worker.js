const CACHE='notes-v41';
const ASSETS=['./','./index.html','./styles.css?v=41','./app.js?v=41','./dropbox.js?v=5','./manifest.webmanifest','./icon-192.png','./icon-512.png','./favicon-32.png?v=41','./favicon.ico?v=41'];

self.addEventListener('install',e=>e.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
));

self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  if(url.origin!==location.origin) return;

  e.respondWith(
    fetch(e.request).then(resp=>{
      const copy=resp.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy));
      return resp;
    }).catch(()=>
      caches.match(e.request).then(r=>r || caches.match('./index.html'))
    )
  );
});
