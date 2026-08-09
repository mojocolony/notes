(() => {
  'use strict';

  const DROPBOX_KEY = 'notes.dropbox.v1';
  const PKCE_KEY = 'notes.dropbox.pkce.v1';
  const ROOT = '/Notes';
  const INDEX_PATH = `${ROOT}/.notes-index.json`;
  const SYNC_DELAY = 1200;

  const $ = id => document.getElementById(id);
  const els = {
    settingsBtn: $('settingsBtn'), settingsDialog: $('settingsDialog'), settingsCloseBtn: $('settingsCloseBtn'),
    dropboxStatus: $('dropboxStatus'), dropboxSetup: $('dropboxSetup'), dropboxConnected: $('dropboxConnected'),
    dropboxAppKey: $('dropboxAppKey'), redirectUriText: $('redirectUriText'), copyRedirectButton: $('copyRedirectButton'),
    connectDropboxButton: $('connectDropboxButton'), syncNowButton: $('syncNowButton'), disconnectDropboxButton: $('disconnectDropboxButton'),
    dropboxLastSync: $('dropboxLastSync'), saveStatus: $('saveStatus')
  };

  let dbx = loadDropbox();
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;
  let suppressLocalSave = false;
  let mainSyncState = dbx.connected ? (dbx.lastSync ? 'synced' : 'connected') : 'disconnected';

  function bridge(){ return window.NotesBridge; }
  function clone(v){ return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  function now(){ return new Date().toISOString(); }

  function loadDropbox(){
    try{
      const parsed=JSON.parse(localStorage.getItem(DROPBOX_KEY));
      return parsed && typeof parsed==='object' ? {connected:false,...parsed} : {connected:false};
    }catch{return {connected:false};}
  }
  function saveDropbox(){
    localStorage.setItem(DROPBOX_KEY,JSON.stringify(dbx));
    updateUI();
  }
  function redirectUri(){ return location.origin + location.pathname; }
  function relativeTime(iso){
    if(!iso) return 'Not yet synced';
    const ms=Date.now()-new Date(iso).getTime();
    if(ms<60000) return 'Synced just now';
    if(ms<3600000) return `Synced ${Math.max(1,Math.floor(ms/60000))}m ago`;
    if(ms<86400000) return `Synced ${Math.floor(ms/3600000)}h ago`;
    return `Synced ${Math.floor(ms/86400000)}d ago`;
  }
  function publishMainStatus(state=mainSyncState){
    mainSyncState=state;
    window.NotesDropboxStatus={connected:!!dbx.connected,state:mainSyncState,lastSync:dbx.lastSync||null};
    window.dispatchEvent(new CustomEvent('notes-dropbox-status',{detail:window.NotesDropboxStatus}));
  }
  function updateUI(){
    if(els.redirectUriText) els.redirectUriText.textContent=redirectUri();
    if(els.dropboxAppKey) els.dropboxAppKey.value=dbx.appKey||'';
    const connected=!!dbx.connected;
    if(els.dropboxSetup) els.dropboxSetup.hidden=connected;
    if(els.dropboxConnected) els.dropboxConnected.hidden=!connected;
    if(els.dropboxStatus) els.dropboxStatus.textContent=connected?'Connected':'Not connected';
    if(els.dropboxLastSync) els.dropboxLastSync.textContent=connected?relativeTime(dbx.lastSync):'';
    if(els.settingsBtn){
      els.settingsBtn.classList.toggle('dropbox-connected',connected);
      els.settingsBtn.title=connected?'Settings · Dropbox connected':'Settings';
    }
    if(!connected) mainSyncState='disconnected';
    publishMainStatus(mainSyncState);
  }
  function setSyncLabel(text){
    if(els.dropboxLastSync) els.dropboxLastSync.textContent=text;
  }
  function toast(msg){ bridge()?.toast?.(msg); }

  function base64Url(bytes){
    let binary=''; new Uint8Array(bytes).forEach(b=>binary+=String.fromCharCode(b));
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function randomString(size=64){ const bytes=new Uint8Array(size); crypto.getRandomValues(bytes); return base64Url(bytes); }
  async function sha256(text){ return crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)); }

  async function connectDropbox(){
    const appKey=els.dropboxAppKey?.value.trim();
    if(!appKey){ toast('Paste your Dropbox App Key first'); return; }
    dbx.appKey=appKey; mainSyncState='connecting'; saveDropbox(); publishMainStatus('connecting');
    const verifier=randomString(64);
    const challenge=base64Url(await sha256(verifier));
    const stateValue=randomString(24);
    localStorage.setItem(PKCE_KEY,JSON.stringify({verifier,state:stateValue,appKey,startedAt:Date.now()}));
    const params=new URLSearchParams({
      client_id:appKey,
      response_type:'code',
      redirect_uri:redirectUri(),
      code_challenge:challenge,
      code_challenge_method:'S256',
      token_access_type:'offline',
      state:stateValue
    });
    location.assign(`https://www.dropbox.com/oauth2/authorize?${params.toString()}`);
  }

  async function handleOAuthReturn(){
    const params=new URLSearchParams(location.search);
    const code=params.get('code');
    const returnedState=params.get('state');
    const error=params.get('error_description')||params.get('error');
    if(error){ history.replaceState({},'',redirectUri()); toast(`Dropbox: ${error}`); return false; }
    if(!code) return false;
    let pkce;
    try{ pkce=JSON.parse(localStorage.getItem(PKCE_KEY)); }catch{}
    if(!pkce?.verifier || !pkce?.appKey || returnedState!==pkce.state){
      history.replaceState({},'',redirectUri()); toast('Dropbox connection could not be verified'); return true;
    }
    setSyncLabel('Connecting…');
    try{
      const body=new URLSearchParams({code,grant_type:'authorization_code',redirect_uri:redirectUri(),client_id:pkce.appKey,code_verifier:pkce.verifier});
      const response=await fetch('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
      if(!response.ok) throw new Error(await response.text());
      const token=await response.json();
      dbx={connected:true,appKey:pkce.appKey,accessToken:token.access_token,refreshToken:token.refresh_token||null,expiresAt:Date.now()+((token.expires_in||14400)*1000)-60000,accountId:token.account_id||null,lastSync:null};
      saveDropbox(); localStorage.removeItem(PKCE_KEY); history.replaceState({},'',redirectUri());
      await syncWithDropbox({announce:true});
    }catch(err){
      console.error(err); history.replaceState({},'',redirectUri()); dbx.connected=false; mainSyncState='disconnected'; saveDropbox(); setSyncLabel('Connection failed'); publishMainStatus('disconnected'); toast('Could not connect Dropbox. Check the app key and redirect URI.');
    }
    return true;
  }

  async function validAccessToken(){
    if(!dbx.connected||!dbx.accessToken) throw new Error('Dropbox is not connected');
    if(!dbx.expiresAt || Date.now()<dbx.expiresAt) return dbx.accessToken;
    if(!dbx.refreshToken) throw new Error('Dropbox authorization expired. Reconnect Dropbox.');
    const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:dbx.refreshToken,client_id:dbx.appKey});
    const response=await fetch('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    if(!response.ok) throw new Error(await response.text());
    const token=await response.json();
    dbx.accessToken=token.access_token; dbx.expiresAt=Date.now()+((token.expires_in||14400)*1000)-60000; saveDropbox();
    return dbx.accessToken;
  }

  async function apiJson(route,arg,{allowConflict=false}={}){
    const token=await validAccessToken();
    const response=await fetch(`https://api.dropboxapi.com/2/${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(arg||{})});
    if(allowConflict && response.status===409) return null;
    if(!response.ok) throw new Error(`${route}: ${await response.text()}`);
    return response.status===204?null:response.json();
  }
  async function download(path,as='text'){
    const token=await validAccessToken();
    const response=await fetch('https://content.dropboxapi.com/2/files/download',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Dropbox-API-Arg':JSON.stringify({path})}});
    if(response.status===409) return null;
    if(!response.ok) throw new Error(`download ${path}: ${await response.text()}`);
    if(as==='blob') return response.blob();
    return response.text();
  }
  async function upload(path,body){
    const token=await validAccessToken();
    const response=await fetch('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify({path,mode:'overwrite',autorename:false,mute:true})},body});
    if(!response.ok) throw new Error(`upload ${path}: ${await response.text()}`);
    return response.json();
  }
  async function ensureFolder(path){
    if(!path||path==='/') return;
    const parts=path.split('/').filter(Boolean); let built='';
    for(const part of parts){ built+=`/${part}`; await apiJson('files/create_folder_v2',{path:built,autorename:false},{allowConflict:true}); }
  }
  async function removeRemote(path){ if(!path) return; await apiJson('files/delete_v2',{path},{allowConflict:true}); }

  function safeSegment(value,max=72){
    let s=String(value||'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
    s=s.replace(/[. ]+$/,'').replace(/^\.+/,'');
    return (s||'Untitled').slice(0,max);
  }
  function idSuffix(id){ return String(id||'note').replace(/^n-/,'').replace(/[^a-zA-Z0-9]/g,'').slice(0,8)||'note'; }
  function folderNameFor(state,note){ return state.folders?.find(f=>f.id===note.folderId)?.name||''; }
  function noteDirectory(state,note){
    if(note.trashed) return `${ROOT}/Trash`;
    if(note.archived) return `${ROOT}/Archive`;
    if(note.folderId) return `${ROOT}/Folders/${safeSegment(folderNameFor(state,note)||'Folder',60)}`;
    return `${ROOT}/Inbox`;
  }
  function desiredNotePath(state,note){ return `${noteDirectory(state,note)}/${safeSegment(bridge()?.displayTitle?.(note)||'Untitled',64)}--${idSuffix(note.id)}.md`; }
  function dirname(path){ return path.slice(0,path.lastIndexOf('/'))||'/'; }
  function basenameNoExt(path){ const b=path.slice(path.lastIndexOf('/')+1); return b.replace(/\.md$/i,''); }
  function assetsDirForPath(path){ return `${dirname(path)}/${basenameNoExt(path)}.assets`; }

  function remoteBodyFor(note,path){
    const assetBase=`${basenameNoExt(path)}.assets`;
    return String(note.body||'').replace(/(\]\()attachments\/([^\)]+)(\))/g,(_,a,name,z)=>`${a}${assetBase}/${name}${z}`);
  }
  function localBodyFromRemote(body,path){
    const assetBase=basenameNoExt(path).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\.assets';
    return String(body||'').replace(new RegExp(`(\\]\\()${assetBase}\\/([^\\)]+)(\\))`,'g'),'$1attachments/$2$3');
  }
  function serializeNote(state,note,path){
    const meta={
      id:note.id,
      title:bridge()?.displayTitle?.(note)||'Untitled',
      customTitle:typeof note.customTitle==='string'?note.customTitle:null,
      created:note.created||now(), updated:note.updated||now(),
      folderId:note.folderId||null, folder:folderNameFor(state,note)||null,
      tags:Array.isArray(note.tags)?note.tags:[], pinned:!!note.pinned, archived:!!note.archived, trashed:!!note.trashed,
      deletedAt:note.deletedAt||null, attachments:Array.isArray(note.attachments)?note.attachments:[]
    };
    const lines=['---',...Object.entries(meta).map(([k,v])=>`${k}: ${JSON.stringify(v)}`),'---','',remoteBodyFor(note,path)];
    return lines.join('\n');
  }
  function parseNote(text,path){
    const raw=String(text||'');
    const lines=raw.split(/\r?\n/); const meta={}; let bodyStart=0;
    if(lines[0]==='---'){
      let i=1;
      for(;i<lines.length;i++){
        if(lines[i]==='---'){ bodyStart=i+1; if(lines[bodyStart]==='') bodyStart++; break; }
        const m=lines[i].match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/); if(!m) continue;
        try{ meta[m[1]]=JSON.parse(m[2]); }catch{ meta[m[1]]=m[2]; }
      }
    }
    const body=localBodyFromRemote(lines.slice(bodyStart).join('\n'),path);
    return {
      id:String(meta.id||`n-${crypto.randomUUID()}`), body,
      customTitle:Object.prototype.hasOwnProperty.call(meta,'customTitle') ? (typeof meta.customTitle==='string'?meta.customTitle:null) : (typeof meta.title==='string'?meta.title:null),
      tags:Array.isArray(meta.tags)?meta.tags:[], folderId:meta.folderId||null,
      pinned:!!meta.pinned, archived:!!meta.archived, trashed:!!meta.trashed, deletedAt:meta.deletedAt||null,
      created:meta.created||now(), updated:meta.updated||meta.created||now(), attachments:Array.isArray(meta.attachments)?meta.attachments:[]
    };
  }

  function latestTombstones(...lists){
    const map=new Map();
    for(const list of lists){ for(const d of (list||[])){ if(!d?.id||!d?.deletedAt) continue; const old=map.get(d.id); if(!old||new Date(d.deletedAt)>new Date(old.deletedAt)) map.set(d.id,{id:d.id,deletedAt:d.deletedAt}); } }
    const cutoff=Date.now()-180*86400000;
    return [...map.values()].filter(d=>new Date(d.deletedAt).getTime()>=cutoff);
  }
  function dateMs(v){ const n=new Date(v||0).getTime(); return Number.isFinite(n)?n:0; }
  function configFromState(state){
    return {savedAt:state.savedAt||now(),folders:clone(state.folders||[]),sortPrefs:clone(state.sortPrefs||{}),manualOrders:clone(state.manualOrders||{}),tagSettings:clone(state.tagSettings||{}),tagGroups:clone(state.tagGroups||[]),tagGroupOrder:clone(state.tagGroupOrder||[]),tagGroupByTag:clone(state.tagGroupByTag||{}),tagManualOrders:clone(state.tagManualOrders||{}),settings:clone(state.settings||{}),ui:clone(state.ui||{})};
  }
  function mergeConfig(local,remoteConfig){
    if(!remoteConfig||dateMs(remoteConfig.savedAt)<=dateMs(local.savedAt)) return local;
    for(const key of ['folders','sortPrefs','manualOrders','tagSettings','tagGroups','tagGroupOrder','tagGroupByTag','tagManualOrders','settings','ui']) if(remoteConfig[key]!==undefined) local[key]=clone(remoteConfig[key]);
    return local;
  }
  function isPristinePlaceholder(n){ return n && !String(n.body||'').trim() && !(typeof n.customTitle==='string'&&n.customTitle.trim()) && !(n.tags||[]).length && !(n.attachments||[]).length && !n.folderId && !n.pinned && !n.archived && !n.trashed; }

  async function downloadRemoteNote(entry,localExisting){
    const text=await download(entry.path,'text'); if(text==null) return null;
    const note=parseNote(text,entry.path);
    if(localExisting) await bridge().deleteAttachments(localExisting).catch(()=>{});
    const assetDir=assetsDirForPath(entry.path);
    for(const name of (note.attachments||[])){
      const blob=await download(`${assetDir}/${safeSegment(name,100)}`,'blob');
      if(blob) await bridge().putAttachment(note.id,name,blob);
    }
    return note;
  }
  async function uploadLocalNote(state,note,oldEntry){
    const path=desiredNotePath(state,note); await ensureFolder(dirname(path));
    await upload(path,serializeNote(state,note,path));
    const assetDir=assetsDirForPath(path);
    if((note.attachments||[]).length){
      await ensureFolder(assetDir);
      for(const name of note.attachments){ const blob=await bridge().getAttachment(note.id,name); if(blob) await upload(`${assetDir}/${safeSegment(name,100)}`,blob); }
    }
    if(oldEntry?.path && oldEntry.path!==path){
      await removeRemote(oldEntry.path);
      await removeRemote(assetsDirForPath(oldEntry.path));
    }
    return {id:note.id,path,updated:note.updated||now(),created:note.created||now()};
  }

  async function readIndex(){
    const text=await download(INDEX_PATH,'text');
    if(text==null) return null;
    try{ const parsed=JSON.parse(text); return parsed&&Array.isArray(parsed.notes)?parsed:null; }catch{return null;}
  }
  async function writeIndex(state,entries,tombstones){
    await ensureFolder(ROOT);
    const payload={version:1,syncedAt:now(),config:configFromState(state),notes:entries,deletedNotes:tombstones};
    await upload(INDEX_PATH,JSON.stringify(payload,null,2));
    return payload;
  }

  function scheduleSync(){
    if(!dbx.connected||suppressLocalSave) return;
    clearTimeout(syncTimer); setSyncLabel('Saving to Dropbox…'); publishMainStatus('syncing');
    syncTimer=setTimeout(()=>syncWithDropbox(),SYNC_DELAY);
  }

  async function syncWithDropbox({announce=false}={}){
    if(!dbx.connected||!bridge()) return;
    if(syncing){ syncAgain=true; return; }
    syncing=true; syncAgain=false; clearTimeout(syncTimer); setSyncLabel('Syncing…'); publishMainStatus('syncing');
    try{
      bridge().flushPendingSave();
      let local=bridge().getState();
      const remote=await readIndex();
      let needsApply=false;
      const freshPlaceholder=!!(remote?.notes?.length && local.notes?.length===1 && isPristinePlaceholder(local.notes[0]) && !(local.folders||[]).length);
      if(freshPlaceholder){ local.notes=[]; local.savedAt='1970-01-01T00:00:00.000Z'; needsApply=true; }
      const remoteConfigIsNewer=!!(remote?.config && dateMs(remote.config.savedAt)>dateMs(local.savedAt));
      local=mergeConfig(local,remote?.config);
      if(remoteConfigIsNewer) needsApply=true;
      const tombstones=latestTombstones(local.deletedNotes,remote?.deletedNotes);
      if(JSON.stringify(tombstones)!==JSON.stringify(local.deletedNotes||[])) needsApply=true;
      const tombById=new Map(tombstones.map(d=>[d.id,d]));
      const localById=new Map((local.notes||[]).map(n=>[n.id,n]));
      const remoteEntries=new Map((remote?.notes||[]).map(e=>[e.id,e]));

      // Apply newer remote notes, and honor permanent-delete tombstones.
      for(const [id,entry] of remoteEntries){
        const tomb=tombById.get(id);
        if(tomb && dateMs(tomb.deletedAt)>=dateMs(entry.updated)){ localById.delete(id); continue; }
        const current=localById.get(id);
        if(!current || dateMs(entry.updated)>dateMs(current.updated)){
          const note=await downloadRemoteNote(entry,current);
          if(note){ localById.set(id,note); needsApply=true; }
        }
      }
      for(const [id,note] of [...localById]){
        const tomb=tombById.get(id);
        if(tomb && dateMs(tomb.deletedAt)>=dateMs(note.updated)){ localById.delete(id); needsApply=true; }
      }
      local.notes=[...localById.values()]; local.deletedNotes=tombstones;
      if(local.selectedId && !localById.has(local.selectedId)) local.selectedId=local.notes[0]?.id||null;

      // Routine local saves only need to upload in the background. Re-render
      // Notes solely when Dropbox actually supplied newer state; otherwise the
      // editor (and its caret) is left completely untouched.
      if(needsApply){
        suppressLocalSave=true;
        bridge().applyState(local);
        suppressLocalSave=false;
        local=bridge().getState();
      }

      const finalEntries=[];
      for(const note of local.notes){
        const old=remoteEntries.get(note.id);
        const desired=desiredNotePath(local,note);
        const localNewer=!old || dateMs(note.updated)>dateMs(old.updated);
        const pathChanged=!!old && old.path!==desired;
        if(localNewer||pathChanged){ finalEntries.push(await uploadLocalNote(local,note,old)); }
        else finalEntries.push({id:old.id,path:old.path,updated:old.updated,created:old.created||note.created});
      }
      const finalIds=new Set(finalEntries.map(e=>e.id));
      for(const [id,old] of remoteEntries){
        if(finalIds.has(id)) continue;
        const tomb=tombById.get(id);
        if(tomb){ await removeRemote(old.path); await removeRemote(assetsDirForPath(old.path)); }
      }
      await writeIndex(local,finalEntries,tombstones);
      dbx.lastSync=now(); mainSyncState='synced'; saveDropbox(); setSyncLabel(relativeTime(dbx.lastSync)); publishMainStatus('synced');
      if(announce) toast('Dropbox connected and synced');
    }catch(err){
      console.error('Notes Dropbox sync',err); setSyncLabel('Sync problem · local copy is safe'); publishMainStatus('offline'); toast('Dropbox sync failed. Your notes are still saved on this device.');
    }finally{
      suppressLocalSave=false; syncing=false;
      if(syncAgain){ syncAgain=false; scheduleSync(); }
    }
  }

  function disconnectDropbox(){
    if(!confirm('Disconnect Dropbox on this device? Your local notes will remain.')) return;
    const appKey=dbx.appKey||''; dbx={connected:false,appKey}; mainSyncState='disconnected'; saveDropbox(); setSyncLabel(''); publishMainStatus('disconnected'); toast('Dropbox disconnected');
  }

  function openSettings(){ updateUI(); els.settingsDialog?.showModal?.(); }
  async function copyRedirect(){
    try{ await navigator.clipboard.writeText(redirectUri()); toast('Redirect URI copied'); }
    catch{ toast('Copy the redirect URI manually'); }
  }

  els.settingsBtn?.addEventListener('click',openSettings);
  els.settingsCloseBtn?.addEventListener('click',()=>els.settingsDialog?.close());
  els.copyRedirectButton?.addEventListener('click',copyRedirect);
  els.connectDropboxButton?.addEventListener('click',connectDropbox);
  els.syncNowButton?.addEventListener('click',()=>syncWithDropbox({announce:true}));
  els.disconnectDropboxButton?.addEventListener('click',disconnectDropbox);
  window.addEventListener('notes-local-save',scheduleSync);
  window.addEventListener('focus',()=>{ if(dbx.connected) syncWithDropbox(); });
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&dbx.connected) syncWithDropbox(); });

  updateUI();
  let started=false;
  async function startDropboxAfterNotesReady(){
    if(started) return; started=true;
    const oauthReturning=new URLSearchParams(location.search).has('code')||new URLSearchParams(location.search).has('error');
    const handled=await handleOAuthReturn();
    if(!handled && dbx.connected && !oauthReturning) syncWithDropbox();
  }
  window.addEventListener('notes-ready',startDropboxAfterNotesReady,{once:true});
  // In case a future build initializes synchronously before this module loads.
  setTimeout(()=>{ if(window.NotesBridge && document.readyState!=='loading') startDropboxAfterNotesReady(); },0);
})();
