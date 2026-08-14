const CACHE='notes-v47';
const ASSETS=['./','./index.html','./styles.css?v=47','./app.js?v=47','./dropbox.js?v=7','./manifest.webmanifest','./notes-icon.svg?v=47','./apple-touch-icon.png?v=47','./icon-192.png?v=47','./icon-512.png?v=47','./favicon-32.png?v=47','./favicon.ico?v=47'];

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
