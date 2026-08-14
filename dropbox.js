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
    dropboxLastSync: $('dropboxLastSync'), dropboxErrorDetail: $('dropboxErrorDetail'), saveStatus: $('saveStatus')
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
    window.NotesDropboxStatus={connected:!!dbx.connected,state:mainSyncState,lastSync:dbx.lastSync||null,lastError:dbx.lastError||null};
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
    if(els.dropboxErrorDetail){
      const e=dbx.lastError;
      els.dropboxErrorDetail.hidden=!connected||!e;
      els.dropboxErrorDetail.textContent=e ? `${e.stage?`${e.stage}: `:''}${e.message||'Unknown sync error'}` : '';
    }
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
  function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
  function headerSafeJson(value){
    // Dropbox content endpoints put route arguments in an HTTP header.
    // Escape non-ASCII code units so browser header construction cannot fail
    // on note/folder names containing smart punctuation, accents, emoji, etc.
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g,ch=>`\\u${ch.charCodeAt(0).toString(16).padStart(4,'0')}`);
  }
  function makeHttpError(label,response,body=''){
    const err=new Error(`${label}: HTTP ${response.status}${body?` · ${body}`:''}`);
    err.status=response.status; err.body=body; err.retryAfter=response.headers.get('Retry-After')||''; err.stage=label;
    return err;
  }
  function makeNetworkError(label,cause){
    const msg=String(cause?.message||cause||'Network request failed');
    const err=new Error(`${label}: ${msg}`);
    err.name='DropboxNetworkError'; err.isDropboxNetworkError=true; err.stage=label; err.causeName=cause?.name||null;
    return err;
  }
  async function fetchWithRetry(url,options={},label='Dropbox request',maxAttempts=4){
    let lastErr;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      let response;
      try{
        response=await fetch(url,options);
      }catch(cause){
        lastErr=makeNetworkError(label,cause);
        if(attempt<maxAttempts){
          setSyncLabel(`Retrying Dropbox · ${label}`);
          await sleep(450*Math.pow(2,attempt-1));
          continue;
        }
        throw lastErr;
      }
      if(response.status===429 || response.status>=500){
        const body=await response.clone().text().catch(()=> '');
        lastErr=makeHttpError(label,response,body);
        if(attempt<maxAttempts){
          const retryHeader=Number(response.headers.get('Retry-After'));
          const delay=Number.isFinite(retryHeader) && retryHeader>0 ? retryHeader*1000 : 450*Math.pow(2,attempt-1);
          setSyncLabel(response.status===429?'Dropbox busy · retrying…':'Dropbox temporarily unavailable · retrying…');
          await sleep(delay);
          continue;
        }
      }
      return response;
    }
    throw lastErr||new Error(`${label}: request failed`);
  }

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
      const response=await fetchWithRetry('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body},'OAuth token exchange');
      if(!response.ok){ const text=await response.text(); throw makeHttpError('OAuth token exchange',response,text); }
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
    const response=await fetchWithRetry('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body},'OAuth refresh');
    if(!response.ok){ const text=await response.text(); throw makeHttpError('OAuth refresh',response,text); }
    const token=await response.json();
    dbx.accessToken=token.access_token; dbx.expiresAt=Date.now()+((token.expires_in||14400)*1000)-60000; saveDropbox();
    return dbx.accessToken;
  }

  async function apiJson(route,arg,{allowConflict=false}={}){
    const token=await validAccessToken();
    const response=await fetchWithRetry(`https://api.dropboxapi.com/2/${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(arg||{})},route);
    if(allowConflict && response.status===409) return null;
    if(!response.ok){ const text=await response.text(); throw makeHttpError(route,response,text); }
    return response.status===204?null:response.json();
  }
  async function download(path,as='text'){
    const token=await validAccessToken();
    const response=await fetchWithRetry('https://content.dropboxapi.com/2/files/download',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Dropbox-API-Arg':headerSafeJson({path})}},`download ${path}`);
    if(response.status===409) return null;
    if(!response.ok){ const text=await response.text(); throw makeHttpError(`download ${path}`,response,text); }
    if(as==='blob') return response.blob();
    return response.text();
  }
  async function upload(path,body){
    const token=await validAccessToken();
    const response=await fetchWithRetry('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Dropbox-API-Arg':headerSafeJson({path,mode:'overwrite',autorename:false,mute:true})},body},`upload ${path}`);
    if(!response.ok){ const text=await response.text(); throw makeHttpError(`upload ${path}`,response,text); }
    return response.json();
  }
  const knownFolders=new Set(['/']);
  async function ensureFolder(path){
    if(!path||path==='/'||knownFolders.has(path)) return;
    const parts=path.split('/').filter(Boolean); let built='';
    for(const part of parts){
      built+=`/${part}`;
      if(knownFolders.has(built)) continue;
      await apiJson('files/create_folder_v2',{path:built,autorename:false},{allowConflict:true});
      knownFolders.add(built);
    }
  }
  async function removeRemote(path){ if(!path) return; await apiJson('files/delete_v2',{path},{allowConflict:true}); }

  function safeSegment(value,max=72){
    let s=String(value||'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
    s=s.replace(/[. ]+$/,'').replace(/^\.+/,'');
    return (s||'Untitled').slice(0,max);
  }
  function idSuffix(id){ return String(id||'note').replace(/^n-/,'').replace(/[^a-zA-Z0-9]/g,'').slice(0,8)||'note'; }
  function folderNameFor(state,note){ return state.folders?.find(f=>f.id===note.folderId)?.name||''; }
  function folderPathFor(state,folderId){
    if(!folderId) return '';
    const byId=new Map((state.folders||[]).map(f=>[f.id,f]));
    const parts=[]; const seen=new Set(); let cursor=byId.get(folderId);
    while(cursor && !seen.has(cursor.id)){ parts.unshift(cursor.name); seen.add(cursor.id); cursor=cursor.parentId?byId.get(cursor.parentId):null; }
    return parts.join(' / ');
  }
  function folderDirectoryFor(state,folderId){
    const path=folderPathFor(state,folderId);
    if(!path) return `${ROOT}/Folders/Folder`;
    return `${ROOT}/Folders/${path.split(' / ').map(part=>safeSegment(part,60)).join('/')}`;
  }
  function noteDirectory(state,note){
    if(note.trashed) return `${ROOT}/Trash`;
    if(note.archived) return `${ROOT}/Archive`;
    if(note.folderId) return folderDirectoryFor(state,note.folderId);
    return `${ROOT}/Inbox`;
  }
  function desiredNotePath(state,note){ return `${noteDirectory(state,note)}/${safeSegment(bridge()?.displayTitle?.(note)||'Untitled',64)}--${idSuffix(note.id)}.md`; }
  function dirname(path){ return path.slice(0,path.lastIndexOf('/'))||'/'; }
  function basenameNoExt(path){ const b=path.slice(path.lastIndexOf('/')+1); return b.replace(/\.md$/i,''); }
  // v40+: keep every note's image files under one tidy top-level _assets folder.
  // A stable note-id subfolder means moving/renaming the Markdown file never moves its images.
  function assetKey(noteOrId){
    const raw=typeof noteOrId==='object'?noteOrId?.id:noteOrId;
    return safeSegment(String(raw||'note').replace(/^n-/,''),100);
  }
  function assetsDirForNote(noteOrId){ return `${ROOT}/_assets/${assetKey(noteOrId)}`; }
  // v39 compatibility: older builds created a sibling "Note name.assets" folder.
  function legacyAssetsDirForPath(path){ return `${dirname(path)}/${basenameNoExt(path)}.assets`; }
  function relativeDropboxPath(fromDir,toPath){
    const from=String(fromDir||'/').split('/').filter(Boolean);
    const to=String(toPath||'/').split('/').filter(Boolean);
    let common=0;
    while(common<from.length && common<to.length && from[common]===to[common]) common++;
    const up=Array(Math.max(0,from.length-common)).fill('..');
    return [...up,...to.slice(common)].join('/')||'.';
  }

  function remoteBodyFor(note,path){
    const relAssetDir=relativeDropboxPath(dirname(path),assetsDirForNote(note));
    return String(note.body||'').replace(/(\]\()attachments\/([^\)]+)(\))/g,(_,a,name,z)=>{
      let decoded=name; try{ decoded=decodeURIComponent(name); }catch{}
      return `${a}${relAssetDir}/${encodeURIComponent(decoded)}${z}`;
    });
  }
  function localBodyFromRemote(body,path,noteId){
    let out=String(body||'');
    // Current grouped-asset layout.
    const relAssetDir=relativeDropboxPath(dirname(path),assetsDirForNote(noteId)).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    out=out.replace(new RegExp(`(\\]\\()${relAssetDir}\\/([^\\)]+)(\\))`,'g'),(_,a,name,z)=>{ let decoded=name; try{ decoded=decodeURIComponent(name); }catch{} return `${a}attachments/${decoded}${z}`; });
    // Legacy v39 sibling .assets layout, so existing Dropbox notes still import cleanly.
    const legacyBase=basenameNoExt(path).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\.assets';
    out=out.replace(new RegExp(`(\\]\\()${legacyBase}\\/([^\\)]+)(\\))`,'g'),(_,a,name,z)=>{ let decoded=name; try{ decoded=decodeURIComponent(name); }catch{} return `${a}attachments/${decoded}${z}`; });
    return out;
  }
  function serializeNote(state,note,path){
    const meta={
      id:note.id,
      title:bridge()?.displayTitle?.(note)||'Untitled',
      customTitle:typeof note.customTitle==='string'?note.customTitle:null,
      created:note.created||now(), updated:note.updated||now(),
      folderId:note.folderId||null, folder:folderPathFor(state,note.folderId)||null,
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
    const noteId=String(meta.id||`n-${crypto.randomUUID()}`);
    const body=localBodyFromRemote(lines.slice(bodyStart).join('\n'),path,noteId);
    return {
      id:noteId, body,
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
    const assetDir=assetsDirForNote(note);
    const legacyAssetDir=legacyAssetsDirForPath(entry.path);
    for(const name of (note.attachments||[])){
      const safeName=safeSegment(name,100);
      let blob=await download(`${assetDir}/${safeName}`,'blob');
      if(!blob) blob=await download(`${legacyAssetDir}/${safeName}`,'blob');
      if(blob) await bridge().putAttachment(note.id,name,blob);
    }
    return note;
  }
  async function uploadLocalNote(state,note,oldEntry){
    const path=desiredNotePath(state,note); await ensureFolder(dirname(path));
    await upload(path,serializeNote(state,note,path));
    const assetDir=assetsDirForNote(note);
    if((note.attachments||[]).length){
      await ensureFolder(assetDir);
      for(const name of note.attachments){ const blob=await bridge().getAttachment(note.id,name); if(blob) await upload(`${assetDir}/${safeSegment(name,100)}`,blob); }
    }
    // Once the grouped copy is safely written, clean up the old v39 sibling asset folder.
    if(oldEntry?.path) await removeRemote(legacyAssetsDirForPath(oldEntry.path));
    if(oldEntry?.path && oldEntry.path!==path){
      await removeRemote(oldEntry.path);
    }
    return {id:note.id,path,updated:note.updated||now(),created:note.created||now(),attachments:[...(note.attachments||[])]};
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
        const localAttachments=[...(note.attachments||[])].sort();
        const remoteAttachments=Array.isArray(old?.attachments)?[...old.attachments].sort():[];
        const attachmentsChanged=localAttachments.join('\u0000')!==remoteAttachments.join('\u0000');
        if(localNewer||pathChanged||attachmentsChanged){ finalEntries.push(await uploadLocalNote(local,note,old)); }
        else finalEntries.push({id:old.id,path:old.path,updated:old.updated,created:old.created||note.created,attachments:localAttachments});
      }
      const finalIds=new Set(finalEntries.map(e=>e.id));
      for(const [id,old] of remoteEntries){
        if(finalIds.has(id)) continue;
        const tomb=tombById.get(id);
        if(tomb){
          await removeRemote(old.path);
          await removeRemote(assetsDirForNote(id));
          await removeRemote(legacyAssetsDirForPath(old.path));
        }
      }
      await writeIndex(local,finalEntries,tombstones);
      dbx.lastSync=now(); dbx.lastError=null; mainSyncState='synced'; saveDropbox(); setSyncLabel(relativeTime(dbx.lastSync)); publishMainStatus('synced');
      if(announce) toast('Dropbox connected and synced');
    }catch(err){
      console.error('Notes Dropbox sync',err);
      const status=Number(err?.status)||0;
      const body=String(err?.body||err?.message||'');
      const stage=String(err?.stage||'Dropbox sync');
      dbx.lastError={at:now(),status:status||null,name:err?.name||'Error',stage,message:body.slice(0,500)}; saveDropbox();
      if(status===401){
        setSyncLabel('Dropbox authorization needs attention'); publishMainStatus('auth'); toast('Dropbox authorization failed. Reconnect Dropbox.');
      }else if(status===429 || /too_many_write_operations/i.test(body)){
        setSyncLabel('Dropbox busy · sync will retry'); publishMainStatus('busy'); toast('Dropbox is temporarily busy. Your local copy is safe and Notes will retry.');
        setTimeout(()=>{ if(dbx.connected&&!syncing) syncWithDropbox(); },5000);
      }else if(err?.isDropboxNetworkError===true){
        setSyncLabel(`Unable to reach Dropbox · ${stage}`); publishMainStatus('offline'); toast(`Dropbox request could not be reached: ${stage}. Your local copy is safe.`);
      }else{
        const short=body.replace(/\s+/g,' ').slice(0,140);
        setSyncLabel(`Dropbox sync error${status?` · ${status}`:''}`); publishMainStatus('error');
        toast(`Dropbox sync error · ${stage}${short?`: ${short}`:''}`);
      }
    }finally{
      suppressLocalSave=false; syncing=false;
      if(syncAgain){ syncAgain=false; scheduleSync(); }
    }
  }

  window.NotesDropboxDebug=()=>({
    connected:!!dbx.connected,
    lastSync:dbx.lastSync||null,
    lastError:dbx.lastError||null,
    state:mainSyncState,
    redirectUri:redirectUri()
  });

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
  window.addEventListener('notes-attachment-added',scheduleSync);
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
