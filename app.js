(() => {
  const STORAGE_KEY = 'notes_app_state_v1';
  const DB_NAME = 'notes_app_attachments';
  const DB_VERSION = 2;
  const ATT_STORE = 'attachments';
  const STATE_STORE = 'state';
  const HISTORY_STORE = 'history';
  const HISTORY_LIMIT_PER_NOTE = 100;
  const AUTO_SNAPSHOT_DELAY = 5000;
  const WRITING_DEFAULTS = { font: 'system', size: 17 };
  const FONT_STACKS = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    avenir: 'Avenir,"Avenir Next","Helvetica Neue",Helvetica,Arial,sans-serif',
    georgia: 'Georgia,"Times New Roman",serif',
    charter: 'Charter,"Bitstream Charter",Georgia,serif',
    times: '"Times New Roman",Times,serif',
    mono: 'Menlo,Monaco,"Courier New",monospace'
  };
  const FONT_SIZES = [15,16,17,18,20,22,24];
  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $('sidebar'), scrim: $('scrim'), sidebarOpen: $('sidebarOpen'), sidebarClose: $('sidebarClose'),
    newNoteBtn: $('newNoteBtn'), newNoteMobile: $('newNoteMobile'), searchInput: $('searchInput'), notesList: $('notesList'), inboxDropZone: $('inboxDropZone'),
    folderList: $('folderList'), addFolderBtn: $('addFolderBtn'), folderDialog: $('folderDialog'), folderForm: $('folderForm'), folderNameInput: $('folderNameInput'), folderSaveBtn: $('folderSaveBtn'),
    tagList: $('tagList'), tagsToggleBtn: $('tagsToggleBtn'), tagsChevron: $('tagsChevron'), tagSortSelect: $('tagSortSelect'), addTagGroupBtn: $('addTagGroupBtn'), manageTagsBtn: $('manageTagsBtn'), tagManagerDialog: $('tagManagerDialog'), tagManagerGroups: $('tagManagerGroups'), tagManagerList: $('tagManagerList'), tagManagerNewGroupBtn: $('tagManagerNewGroupBtn'), tagManagerCloseBtn: $('tagManagerCloseBtn'), tagManagerCloseX: $('tagManagerCloseX'),
    viewTitle: $('viewTitle'), viewSubtitle: $('viewSubtitle'), sortSelect: $('sortSelect'), inboxCount: $('inboxCount'), pinnedCount: $('pinnedCount'), archiveCount: $('archiveCount'), trashCount: $('trashCount'),
    noteTitle: $('noteTitle'), saveStatus: $('saveStatus'), folderSelect: $('folderSelect'), tagsInput: $('tagsInput'), editor: $('editor'), preview: $('preview'), reorderPanel: $('reorderPanel'), blocksList: $('blocksList'),
    previewBtn: $('previewBtn'), reorderBtn: $('reorderBtn'), reorderDone: $('reorderDone'), toolbar: $('toolbar'), imageInput: $('imageInput'), pinBtn: $('pinBtn'), historyBtn: $('historyBtn'), shareBtn: $('shareBtn'), downloadBtn: $('downloadBtn'), archiveBtn: $('archiveBtn'), deleteBtn: $('deleteBtn'),
    writingSettingsBtn: $('writingSettingsBtn'), writingSettingsDialog: $('writingSettingsDialog'), writingSettingsForm: $('writingSettingsForm'), fontSelect: $('fontSelect'), fontSizeSelect: $('fontSizeSelect'), fontSample: $('fontSample'),
    backupBtn: $('backupBtn'), restoreBtn: $('restoreBtn'), restoreInput: $('restoreInput'),
    historyDialog: $('historyDialog'), historyList: $('historyList'), historyPreview: $('historyPreview'), historyPreviewMeta: $('historyPreviewMeta'), historyPreviewText: $('historyPreviewText'), historyPreviewClose: $('historyPreviewClose'), saveVersionBtn: $('saveVersionBtn'), historyCloseBtn: $('historyCloseBtn'), historyCloseX: $('historyCloseX'),
    toast: $('toast')
  };

  let localStateValid = false;
  let state = loadState();
  let currentView = 'inbox';
  let currentFolder = null;
  let currentTag = null;
  let selectedId = state.selectedId || null;
  let saveTimer = null;
  let previewMode = false;
  let reorderMode = false;
  let sortable = null;
  let noteListSortable = null;
  let folderDropSortables = [];
  let tagItemSortables = [];
  let tagGroupSortable = null;
  let objectUrls = [];
  let cmEditor = null;
  let syncingEditor = false;
  let taskMarks = [];
  let taskMarkTimer = null;
  let linkMarks = [];
  let linkMarkTimer = null;
  let mirrorTimer = null;
  let primarySaveOk = true;
  const autoSnapshotTimers = new Map();
  const permanentlyDeletedNoteIds = new Set();

  if (window.CodeMirror) {
    cmEditor = CodeMirror.fromTextArea(els.editor, {
      mode: 'markdown',
      lineWrapping: true,
      viewportMargin: Infinity,
      spellcheck: true,
      autocorrect: true,
      autocapitalize: true,
      extraKeys: {
        'Cmd-B': () => toolbarAction('bold'), 'Ctrl-B': () => toolbarAction('bold'),
        'Cmd-I': () => toolbarAction('italic'), 'Ctrl-I': () => toolbarAction('italic'),
        'Enter': (cm) => continueMarkdownListCodeMirror(cm) ? undefined : CodeMirror.Pass
      }
    });
    cmEditor.on('change', () => {
      if (syncingEditor) return;
      capturePreEditVersion();
      els.editor.value = cmEditor.getValue();
      scheduleSave();
      scheduleTaskCheckboxRefresh();
      scheduleLiveLinkRefresh();
    });
    cmEditor.on('mousedown',openLiveLinkAtMouse);
    scheduleTaskCheckboxRefresh();
    scheduleLiveLinkRefresh();
  }
  applyWritingPreferences();

  function editorValue(){ return cmEditor ? cmEditor.getValue() : els.editor.value; }
  function setEditorValue(value){
    value = value || '';
    if (cmEditor) {
      if (cmEditor.getValue() === value) return;
      syncingEditor = true; cmEditor.setValue(value); syncingEditor = false;
      els.editor.value = value;
      scheduleTaskCheckboxRefresh();
      scheduleLiveLinkRefresh();
    } else els.editor.value = value;
  }
  function editorHasFocus(){ return cmEditor ? cmEditor.hasFocus() : document.activeElement === els.editor; }
  function editorWrapper(){ return cmEditor ? cmEditor.getWrapperElement() : els.editor; }
  function showEditor(show){ editorWrapper().hidden = !show; }

  function scheduleTaskCheckboxRefresh(){
    if(!cmEditor) return;
    clearTimeout(taskMarkTimer);
    taskMarkTimer=setTimeout(refreshTaskCheckboxes,0);
  }
  function clearTaskMarks(){
    taskMarks.forEach(mark=>{ try{ mark.clear(); }catch{} });
    taskMarks=[];
  }
  function refreshTaskCheckboxes(){
    if(!cmEditor) return;
    clearTaskMarks();
    let inFence=false;
    for(let lineNo=0;lineNo<cmEditor.lineCount();lineNo++){
      const line=cmEditor.getLine(lineNo)||'';
      if(/^\s*```/.test(line)){ inFence=!inFence; continue; }
      if(inFence) continue;
      const m=line.match(/^(\s*[-*+]\s+)\[([ xX])\](?=\s|$)/);
      if(!m) continue;
      const start=m[1].length;
      const checked=m[2].toLowerCase()==='x';
      const box=document.createElement('input');
      box.type='checkbox';
      box.className='live-task-checkbox';
      box.checked=checked;
      box.setAttribute('aria-label',checked?'Mark task incomplete':'Mark task complete');
      box.title=checked?'Mark incomplete':'Mark complete';
      box.addEventListener('mousedown',e=>e.stopPropagation());
      box.addEventListener('click',e=>{
        e.stopPropagation();
        const current=cmEditor.getRange({line:lineNo,ch:start},{line:lineNo,ch:start+3});
        cmEditor.replaceRange(/^\[[xX]\]$/.test(current)?'[ ]':'[x]',{line:lineNo,ch:start},{line:lineNo,ch:start+3},'+task-toggle');
        scheduleTaskCheckboxRefresh();
      });
      const mark=cmEditor.markText(
        {line:lineNo,ch:start},
        {line:lineNo,ch:start+3},
        {replacedWith:box,atomic:true,clearOnEnter:false,handleMouseEvents:true}
      );
      taskMarks.push(mark);
      if(checked && line.length > start+3){
        // Start the strike at the first actual task character, not the
        // separating whitespace after the Markdown checkbox marker.
        let textStart=start+3;
        while(textStart < line.length && /\s/.test(line.charAt(textStart))) textStart++;
        if(textStart < line.length){
          const textMark=cmEditor.markText(
            {line:lineNo,ch:textStart},
            {line:lineNo,ch:line.length},
            {className:'task-complete-text'}
          );
          taskMarks.push(textMark);
        }
      }
    }
  }
  function scheduleLiveLinkRefresh(){
    if(!cmEditor) return;
    clearTimeout(linkMarkTimer);
    linkMarkTimer=setTimeout(refreshLiveLinks,0);
  }
  function clearLinkMarks(){
    linkMarks.forEach(mark=>{ try{ mark.clear(); }catch{} });
    linkMarks=[];
  }
  function normalizeOpenUrl(raw){
    if(!raw) return null;
    let url=String(raw).trim();
    if(/^www\./i.test(url)) url=`https://${url}`;
    try{
      const parsed=new URL(url,location.href);
      if(!['http:','https:','mailto:','tel:'].includes(parsed.protocol)) return null;
      return parsed.href;
    }catch{return null;}
  }
  function lineLinkTargets(line){
    const hits=[];
    const occupied=[];
    const overlaps=(start,end)=>occupied.some(r=>start<r.end && end>r.start);
    const add=(start,end,url,iconCh,wholeStart=start,wholeEnd=end)=>{
      const href=normalizeOpenUrl(url);
      if(!href || start>=end) return;
      hits.push({start,end,href,iconCh});
      occupied.push({start:wholeStart,end:wholeEnd});
    };

    // Standard Markdown links: [label](https://example.com). Images are left alone.
    const md=/(?<!!)\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/gi;
    let m;
    while((m=md.exec(line))){
      const labelStart=m.index+1;
      const labelEnd=labelStart+m[1].length;
      add(labelStart,labelEnd,m[2],m.index+m[0].length,m.index,m.index+m[0].length);
    }

    // Angle-bracket autolinks.
    const angle=/<((?:https?:\/\/|mailto:|tel:)[^>\s]+)>/gi;
    while((m=angle.exec(line))){
      if(overlaps(m.index,m.index+m[0].length)) continue;
      add(m.index+1,m.index+1+m[1].length,m[1],m.index+m[0].length,m.index,m.index+m[0].length);
    }

    // Bare web URLs, including www.example.com.
    const bare=/(?:https?:\/\/|www\.)[^\s<>{}\[\]]+/gi;
    while((m=bare.exec(line))){
      let raw=m[0];
      let end=m.index+raw.length;
      while(/[.,;:!?]$/.test(raw)){ raw=raw.slice(0,-1); end--; }
      // Trim an unmatched trailing right parenthesis, common in prose.
      while(raw.endsWith(')') && (raw.match(/\(/g)||[]).length < (raw.match(/\)/g)||[]).length){ raw=raw.slice(0,-1); end--; }
      if(!raw || overlaps(m.index,end)) continue;
      add(m.index,end,raw,end,m.index,end);
    }
    return hits;
  }
  function makeOpenLinkWidget(href){
    const a=document.createElement('a');
    a.className='live-link-open';
    a.href=href;
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.textContent='↗';
    a.title='Open link';
    a.setAttribute('aria-label','Open link');
    a.addEventListener('mousedown',e=>e.stopPropagation());
    a.addEventListener('click',e=>e.stopPropagation());
    return a;
  }
  function refreshLiveLinks(){
    if(!cmEditor) return;
    clearLinkMarks();
    let inFence=false;
    for(let lineNo=0;lineNo<cmEditor.lineCount();lineNo++){
      const line=cmEditor.getLine(lineNo)||'';
      if(/^\s*```/.test(line)){ inFence=!inFence; continue; }
      if(inFence) continue;
      for(const hit of lineLinkTargets(line)){
        const textMark=cmEditor.markText(
          {line:lineNo,ch:hit.start},
          {line:lineNo,ch:hit.end},
          {className:'live-clickable-link'}
        );
        linkMarks.push(textMark);
        const bookmark=cmEditor.setBookmark(
          {line:lineNo,ch:hit.iconCh},
          {widget:makeOpenLinkWidget(hit.href),insertLeft:false}
        );
        linkMarks.push(bookmark);
      }
    }
  }
  function openLiveLinkAtMouse(cm,e){
    if(!(e.metaKey||e.ctrlKey)) return;
    const pos=cm.coordsChar({left:e.clientX,top:e.clientY},'window');
    const line=cm.getLine(pos.line)||'';
    const hit=lineLinkTargets(line).find(x=>pos.ch>=x.start && pos.ch<=x.end);
    if(!hit) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(hit.href,'_blank','noopener,noreferrer');
  }

  function markdownListContinuation(line){
    let m=line.match(/^(\s*[-*+]\s+)\[([ xX])\](\s*)(.*)$/);
    if(m){
      return {
        body:m[4]||'',
        prefix:`${m[1]}[ ] `,
        contentStart:m[1].length+3+m[3].length,
        task:true
      };
    }
    m=line.match(/^(\s*)([-*+])\s+(.*)$/);
    if(m){
      const prefix=`${m[1]}${m[2]} `;
      return {body:m[3]||'',prefix,contentStart:prefix.length,task:false};
    }
    m=line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
    if(m){
      const next=Number(m[2])+1;
      const currentPrefix=`${m[1]}${m[2]}${m[3]} `;
      return {
        body:m[4]||'',
        prefix:`${m[1]}${next}${m[3]} `,
        contentStart:currentPrefix.length,
        task:false
      };
    }
    return null;
  }
  function continueMarkdownListCodeMirror(cm){
    if(cm.somethingSelected()) return false;
    const cur=cm.getCursor();
    const line=cm.getLine(cur.line)||'';
    const info=markdownListContinuation(line);
    if(!info) return false;
    if(!info.body.trim() && cur.ch>=info.contentStart){
      cm.replaceRange('',{line:cur.line,ch:0},{line:cur.line,ch:line.length},'+markdown-list');
      cm.setCursor({line:cur.line,ch:0});
      if(info.task) scheduleTaskCheckboxRefresh();
      return true;
    }
    cm.replaceSelection(`\n${info.prefix}`,'end','+markdown-list');
    if(info.task) scheduleTaskCheckboxRefresh();
    return true;
  }
  function continueMarkdownListTextarea(e){
    if(e.key!=='Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
    const ta=els.editor;
    if(ta.selectionStart!==ta.selectionEnd) return false;
    const pos=ta.selectionStart;
    const {start,end}=lineBounds(ta.value,pos);
    const line=ta.value.slice(start,end);
    const info=markdownListContinuation(line);
    if(!info) return false;
    e.preventDefault();
    if(!info.body.trim() && pos>=start+info.contentStart){
      ta.setRangeText('',start,end,'end');
    }else{
      ta.setRangeText(`\n${info.prefix}`,pos,pos,'end');
    }
    scheduleSave();
    return true;
  }
  function defaultState(){ return { notes: [], folders: [], selectedId: null, savedAt:null, settings: { ...WRITING_DEFAULTS }, ui: { tagsCollapsed:false }, sortPrefs: {}, manualOrders: {}, tagSettings:{sort:'az'}, tagGroups:[], tagGroupOrder:[], tagGroupByTag:{}, tagManualOrders:{} }; }
  function normalizeState(parsed){
    if(!parsed || typeof parsed!=='object') parsed=defaultState();
    parsed.notes = Array.isArray(parsed.notes) ? parsed.notes : [];
    parsed.folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    parsed.sortPrefs = parsed.sortPrefs && typeof parsed.sortPrefs==='object' ? parsed.sortPrefs : {};
    parsed.manualOrders = parsed.manualOrders && typeof parsed.manualOrders==='object' ? parsed.manualOrders : {};
    parsed.ui = parsed.ui && typeof parsed.ui==='object' ? parsed.ui : {};
    parsed.ui.tagsCollapsed = !!parsed.ui.tagsCollapsed;
    parsed.tagSettings = parsed.tagSettings && typeof parsed.tagSettings==='object' ? parsed.tagSettings : {};
    parsed.tagSettings.sort = parsed.tagSettings.sort==='manual' ? 'manual' : 'az';
    parsed.tagGroups = Array.isArray(parsed.tagGroups) ? parsed.tagGroups.filter(g=>g&&g.id&&g.name).map(g=>({id:String(g.id),name:String(g.name).trim()||'Group',collapsed:!!g.collapsed})) : [];
    parsed.tagGroupOrder = Array.isArray(parsed.tagGroupOrder) ? parsed.tagGroupOrder.map(String) : [];
    parsed.tagGroupByTag = parsed.tagGroupByTag && typeof parsed.tagGroupByTag==='object' ? parsed.tagGroupByTag : {};
    parsed.tagManualOrders = parsed.tagManualOrders && typeof parsed.tagManualOrders==='object' ? parsed.tagManualOrders : {};
    const validGroupIds=new Set(parsed.tagGroups.map(g=>g.id));
    parsed.tagGroupOrder=[...parsed.tagGroupOrder.filter(x=>validGroupIds.has(x)),...parsed.tagGroups.map(g=>g.id).filter(x=>!parsed.tagGroupOrder.includes(x))];
    for(const [key,gid] of Object.entries(parsed.tagGroupByTag)) if(!validGroupIds.has(gid)) delete parsed.tagGroupByTag[key];
    parsed.settings = normalizeWritingSettings(parsed.settings);
    for(const note of parsed.notes){
      note.customTitle = typeof note.customTitle==='string' ? note.customTitle : null;
      note.tags = dedupeTags(Array.isArray(note.tags) ? note.tags : []);
      note.attachments = Array.isArray(note.attachments) ? note.attachments : [];
      note.folderId = note.folderId || null;
      note.pinned = !!note.pinned;
      note.archived = !!note.archived;
      note.trashed = !!note.trashed;
      note.deletedAt = note.deletedAt || null;
      if(!note.created) note.created=now();
      if(!note.updated) note.updated=note.created;
    }
    repairEscapedNewlineBug(parsed);
    return parsed;
  }
  function loadState(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if(!parsed || !Array.isArray(parsed.notes) || !Array.isArray(parsed.folders)) throw new Error('Invalid Notes state');
      localStateValid=true;
      return normalizeState(parsed);
    } catch {
      localStateValid=false;
      return defaultState();
    }
  }

  function repairEscapedNewlineBug(parsed){
    // v11 briefly serialized reordered notes using the literal characters
    // "\n" instead of line breaks. Repair only notes with the distinctive
    // corruption pattern and no genuine line breaks, so ordinary uses of
    // backslash+n are left alone.
    let changed=false;
    for(const note of (parsed.notes||[])){
      if(typeof note.body!=='string') continue;
      const body=note.body;
      const hasRealNewline=/[\r\n]/.test(body);
      const looksLikeReorderCorruption = !hasRealNewline && body.includes('\\n') && (
        body.includes('\\n\\n') ||
        /\\n\s*(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s+)/.test(body)
      );
      if(looksLikeReorderCorruption){
        note.body=body.replace(/\\n/g,'\n');
        changed=true;
      }
    }
    if(changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  }

  function normalizeWritingSettings(settings){
    const font = settings && FONT_STACKS[settings.font] ? settings.font : WRITING_DEFAULTS.font;
    const requestedSize = Number(settings?.size);
    const size = FONT_SIZES.includes(requestedSize) ? requestedSize : WRITING_DEFAULTS.size;
    return { font, size };
  }
  function applyWritingPreferences(){
    state.settings = normalizeWritingSettings(state.settings);
    document.documentElement.style.setProperty('--note-font', FONT_STACKS[state.settings.font]);
    document.documentElement.style.setProperty('--note-font-size', `${state.settings.size}px`);
    if(els.fontSelect) els.fontSelect.value = state.settings.font;
    if(els.fontSizeSelect) els.fontSizeSelect.value = String(state.settings.size);
    if(cmEditor) cmEditor.refresh();
  }
  function openWritingSettings(){
    applyWritingPreferences();
    if(els.writingSettingsDialog?.showModal) els.writingSettingsDialog.showModal();
    else els.writingSettingsDialog?.setAttribute('open','');
  }
  function saveWritingPreference(){
    state.settings = normalizeWritingSettings({ font: els.fontSelect.value, size: Number(els.fontSizeSelect.value) });
    applyWritingPreferences();
    persist();
  }

  function persist(){
    state.selectedId = selectedId;
    state.savedAt = now();
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStateValid=true; primarySaveOk=true;
      els.saveStatus.textContent = 'Saved locally';
    }catch{
      primarySaveOk=false;
      els.saveStatus.textContent = 'Saving to recovery storage…';
    }
    scheduleStateMirror();
  }
  function scheduleStateMirror(){
    clearTimeout(mirrorTimer);
    mirrorTimer=setTimeout(async()=>{
      try{
        await saveStateMirror(state);
        if(els.saveStatus.textContent!=='Saving…') els.saveStatus.textContent=primarySaveOk?'Saved locally':'Saved to recovery storage';
      }catch{
        // localStorage is still the immediate save; the recovery mirror is a second layer.
      }
    },180);
  }
  async function requestPersistentStorage(){
    try{
      if(navigator.storage?.persist) await navigator.storage.persist();
    }catch{}
  }
  function now(){ return new Date().toISOString(); }
  function id(prefix='n'){ return prefix + '-' + crypto.randomUUID(); }
  function currentNote(){ return state.notes.find(n => n.id === selectedId) || null; }
  function stripMarkdown(s=''){
    return s.replace(/^#{1,6}\s+/,'').replace(/^[-*>\s]+/,'').replace(/[`*_~\[\]]/g,'').trim();
  }
  function deriveTitle(body=''){
    const line = body.split(/\r?\n/).find(x => x.trim());
    return stripMarkdown(line || '') || 'Untitled';
  }
  function displayTitle(note){
    if(!note) return 'Untitled';
    const custom=typeof note.customTitle==='string' ? note.customTitle.trim() : '';
    return custom || deriveTitle(note.body);
  }
  function previewText(body=''){
    return body.replace(/```[\s\S]*?```/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[#>*_`~\-]+/g,' ').replace(/\s+/g,' ').trim();
  }
  function safeFilename(s){
    return (s || 'Untitled').replace(/[\\/:*?"<>|]/g,'').replace(/\s+/g,' ').trim().slice(0,80) || 'Untitled';
  }
  function formatDate(iso){
    if (!iso) return '';
    const d = new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  }
  function toast(msg){
    els.toast.textContent = msg; els.toast.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>els.toast.classList.remove('show'),1800);
  }
  function wordCount(text=''){
    const t=String(text).trim();
    return t ? t.split(/\s+/).length : 0;
  }
  function historyPayload(note){
    return {
      noteId:note.id, title:displayTitle(note), customTitle:note.customTitle, body:note.body||'',
      tags:[...(note.tags||[])], folderId:note.folderId||null, pinned:!!note.pinned, archived:!!note.archived,
      createdOriginal:note.created, attachments:[...(note.attachments||[])]
    };
  }
  function historyFingerprint(value){
    return JSON.stringify([value.customTitle||null,value.body||'',value.tags||[],value.folderId||null,!!value.pinned,!!value.archived]);
  }
  async function getHistory(noteId){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HISTORY_STORE,'readonly');
      const index=tx.objectStore(HISTORY_STORE).index('noteId');
      const req=index.getAll(noteId);
      req.onsuccess=()=>{
        const items=(req.result||[]).sort((a,b)=>new Date(b.created)-new Date(a.created));
        db.close(); res(items);
      };
      req.onerror=()=>{db.close();rej(req.error);};
    });
  }
  async function getAllHistory(){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HISTORY_STORE,'readonly');
      const req=tx.objectStore(HISTORY_STORE).getAll();
      req.onsuccess=()=>{db.close();res(req.result||[]);}; req.onerror=()=>{db.close();rej(req.error);};
    });
  }
  async function putHistorySnapshot(snapshot){
    const db=await openDB();
    await new Promise((res,rej)=>{
      const tx=db.transaction(HISTORY_STORE,'readwrite');
      tx.objectStore(HISTORY_STORE).put(snapshot);
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
    db.close();
  }
  async function deleteHistorySnapshot(idToDelete){
    const db=await openDB();
    await new Promise((res,rej)=>{
      const tx=db.transaction(HISTORY_STORE,'readwrite');
      tx.objectStore(HISTORY_STORE).delete(idToDelete);
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
    db.close();
  }
  async function deleteHistoryForNote(noteId){
    const versions=await getHistory(noteId);
    for(const v of versions) await deleteHistorySnapshot(v.id);
  }
  async function createSnapshot(note,label='Automatic',force=false){
    if(!note || permanentlyDeletedNoteIds.has(note.id)) return null;
    try{
      const payload=historyPayload(note);
      const existing=await getHistory(note.id);
      if(permanentlyDeletedNoteIds.has(note.id)) return null;
      if(!force && existing[0] && historyFingerprint(existing[0])===historyFingerprint(payload)) return existing[0];
      const snap={ id:id('v'), created:now(), label, ...payload };
      await putHistorySnapshot(snap);
      const versions=await getHistory(note.id);
      for(const old of versions.slice(HISTORY_LIMIT_PER_NOTE)) await deleteHistorySnapshot(old.id);
      return snap;
    }catch{ return null; }
  }
  function queueAutoSnapshot(note){
    if(!note) return;
    clearTimeout(autoSnapshotTimers.get(note.id));
    autoSnapshotTimers.set(note.id,setTimeout(async()=>{
      autoSnapshotTimers.delete(note.id);
      await createSnapshot(note,'Automatic',false);
    },AUTO_SNAPSHOT_DELAY));
  }
  function formatHistoryDate(iso){
    const d=new Date(iso);
    const today=new Date();
    const sameDay=d.toDateString()===today.toDateString();
    return sameDay ? d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) : d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  }
  async function renderHistory(){
    const n=currentNote(); if(!n) return;
    let versions=[];
    try{ versions=await getHistory(n.id); }catch{
      els.historyPreview.hidden=true; els.historyList.hidden=false;
      els.historyList.innerHTML='<div class="empty-state">Version history is unavailable in this browser context.</div>';
      return;
    }
    els.historyPreview.hidden=true; els.historyList.hidden=false;
    els.historyList.innerHTML='';
    if(!versions.length){ els.historyList.innerHTML='<div class="empty-state">No saved versions yet.</div>'; return; }
    for(const v of versions){
      const row=document.createElement('div'); row.className='history-row';
      const meta=document.createElement('div'); meta.className='history-row-main';
      const title=document.createElement('div'); title.className='history-row-title'; title.textContent=formatHistoryDate(v.created);
      const detail=document.createElement('div'); detail.className='history-row-detail';
      detail.textContent=`${v.label||'Version'} · ${wordCount(v.body)} word${wordCount(v.body)===1?'':'s'} · ${v.title||'Untitled'}`;
      const snippet=document.createElement('div'); snippet.className='history-row-snippet'; snippet.textContent=previewText(v.body)||'Empty note';
      meta.append(title,detail,snippet);
      const actions=document.createElement('div'); actions.className='history-row-actions';
      const preview=document.createElement('button'); preview.className='secondary-btn compact'; preview.textContent='Preview'; preview.addEventListener('click',()=>previewHistoryVersion(v));
      const copy=document.createElement('button'); copy.className='secondary-btn compact'; copy.textContent='Copy'; copy.title='Restore as a new note'; copy.addEventListener('click',()=>restoreHistoryAsCopy(v));
      const restore=document.createElement('button'); restore.className='primary-btn compact'; restore.textContent='Restore'; restore.addEventListener('click',()=>restoreHistoryVersion(v));
      actions.append(preview,copy,restore); row.append(meta,actions); els.historyList.appendChild(row);
    }
  }
  function previewHistoryVersion(v){
    els.historyList.hidden=true; els.historyPreview.hidden=false;
    els.historyPreviewMeta.textContent=`${formatHistoryDate(v.created)} · ${v.label||'Version'} · ${v.title||'Untitled'}`;
    els.historyPreviewText.textContent=v.body||'';
  }
  async function openHistory(){
    const n=currentNote(); if(!n) return;
    if(saveTimer){ clearTimeout(saveTimer); saveTimer=null; saveEditorNow(); }
    await createSnapshot(n,'Automatic',false);
    await renderHistory();
    if(els.historyDialog.showModal) els.historyDialog.showModal(); else els.historyDialog.setAttribute('open','');
  }
  async function saveVersionNow(){
    const n=currentNote(); if(!n) return;
    if(saveTimer){ clearTimeout(saveTimer); saveTimer=null; saveEditorNow(); }
    await createSnapshot(n,'Saved manually',true);
    await renderHistory(); toast('Version saved');
  }
  async function restoreHistoryVersion(v){
    const n=currentNote(); if(!n) return;
    if(!confirm(`Restore the version from ${formatHistoryDate(v.created)}? Your current version will be saved first.`)) return;
    await createSnapshot(n,'Before restore',true);
    n.customTitle=typeof v.customTitle==='string'?v.customTitle:null;
    n.body=v.body||''; n.tags=[...(v.tags||[])]; n.folderId=v.folderId||null; n.pinned=!!v.pinned; n.archived=!!v.archived;
    if(n.trashed) n.preTrashArchived=n.archived;
    n.updated=now(); persist(); renderAll(); await createSnapshot(n,'Restored version',true); await renderHistory(); toast('Version restored');
  }
  async function restoreHistoryAsCopy(v){
    const copy={ id:id(), body:v.body||'', customTitle:(v.title||'Untitled')+' (restored copy)', tags:[...(v.tags||[])], folderId:v.folderId||null, pinned:false, archived:false, trashed:false, deletedAt:null, created:now(), updated:now(), attachments:[] };
    for(const name of (v.attachments||[])){
      try{ const blob=await getAttachment(v.noteId,name); if(blob){ await putAttachment(copy.id,name,blob); copy.attachments.push(name); } }catch{}
    }
    state.notes.unshift(copy); selectedId=copy.id; currentView=copy.folderId?'folder':'inbox'; currentFolder=copy.folderId||null; persist(); renderAll(); await createSnapshot(copy,'Restored copy',true); els.historyDialog.close(); toast('Restored as a new note'); focusEditor();
  }

  function tagKey(tag){ return String(tag||'').trim().toLocaleLowerCase(); }
  function dedupeTags(tags){
    const out=[]; const seen=new Set();
    for(const raw of (tags||[])){
      const tag=String(raw||'').trim(); const key=tagKey(tag);
      if(!tag || seen.has(key)) continue;
      seen.add(key); out.push(tag);
    }
    return out;
  }
  function rawTagSummaries(includeTrashed=false){
    const map=new Map();
    for(const n of state.notes){
      if(!includeTrashed && n.trashed) continue;
      const seenInNote=new Set();
      for(const tag of dedupeTags(n.tags||[])){
        const key=tagKey(tag); if(!key || seenInNote.has(key)) continue;
        seenInNote.add(key);
        if(!map.has(key)) map.set(key,{key,name:tag,count:0});
        map.get(key).count++;
      }
    }
    return [...map.values()];
  }
  function tagGroupKey(groupId){ return groupId ? `group:${groupId}` : 'ungrouped'; }
  function tagGroupForKey(key){
    const gid=state.tagGroupByTag?.[key];
    return state.tagGroups.find(g=>g.id===gid) || null;
  }
  function orderedTagGroups(){
    state.tagGroups ||= []; state.tagGroupOrder ||= [];
    const byId=new Map(state.tagGroups.map(g=>[g.id,g]));
    const ordered=[];
    for(const gid of state.tagGroupOrder){ if(byId.has(gid)){ ordered.push(byId.get(gid)); byId.delete(gid); } }
    for(const g of byId.values()) ordered.push(g);
    return ordered;
  }
  function tagsForGroup(groupId){
    const all=rawTagSummaries(false);
    const wanted=groupId||null;
    const filtered=all.filter(item=>(state.tagGroupByTag?.[item.key]||null)===wanted);
    if(state.tagSettings?.sort!=='manual') return filtered.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base',numeric:true}));
    state.tagManualOrders ||= {};
    const order=Array.isArray(state.tagManualOrders[tagGroupKey(wanted)]) ? state.tagManualOrders[tagGroupKey(wanted)] : [];
    const pos=new Map(order.map((key,i)=>[key,i]));
    return filtered.sort((a,b)=>{
      const ai=pos.has(a.key)?pos.get(a.key):Number.MAX_SAFE_INTEGER;
      const bi=pos.has(b.key)?pos.get(b.key):Number.MAX_SAFE_INTEGER;
      return ai!==bi?ai-bi:a.name.localeCompare(b.name,undefined,{sensitivity:'base',numeric:true});
    });
  }
  function tagSummaries(includeTrashed=false){
    const all=rawTagSummaries(includeTrashed);
    return all.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base',numeric:true}));
  }
  function ensureTagManualOrders(){
    state.tagManualOrders ||= {};
    const valid=new Set(rawTagSummaries(false).map(x=>x.key));
    const groupIds=[null,...state.tagGroups.map(g=>g.id)];
    for(const gid of groupIds){
      const key=tagGroupKey(gid);
      const belonging=rawTagSummaries(false).filter(item=>(state.tagGroupByTag?.[item.key]||null)===(gid||null)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base',numeric:true})).map(x=>x.key);
      const existing=Array.isArray(state.tagManualOrders[key])?state.tagManualOrders[key].filter(x=>valid.has(x)&&belonging.includes(x)):[];
      state.tagManualOrders[key]=[...existing,...belonging.filter(x=>!existing.includes(x))];
    }
  }
  function cleanTagOrganization(){
    const validTagKeys=new Set(rawTagSummaries(false).map(x=>x.key));
    const validGroupIds=new Set((state.tagGroups||[]).map(g=>g.id));
    state.tagGroupByTag ||= {}; state.tagManualOrders ||= {};
    for(const key of Object.keys(state.tagGroupByTag)) if(!validTagKeys.has(key)||!validGroupIds.has(state.tagGroupByTag[key])) delete state.tagGroupByTag[key];
    for(const orderKey of Object.keys(state.tagManualOrders)) state.tagManualOrders[orderKey]=(state.tagManualOrders[orderKey]||[]).filter(k=>validTagKeys.has(k));
    ensureTagManualOrders();
  }
  function moveTagOrganization(oldKey,newKey){
    if(!oldKey||!newKey||oldKey===newKey) return;
    state.tagGroupByTag ||= {}; state.tagManualOrders ||= {};
    const oldGroup=state.tagGroupByTag[oldKey];
    if(!state.tagGroupByTag[newKey] && oldGroup) state.tagGroupByTag[newKey]=oldGroup;
    delete state.tagGroupByTag[oldKey];
    for(const k of Object.keys(state.tagManualOrders)){
      const arr=state.tagManualOrders[k]||[];
      const next=[];
      for(const value of arr.map(x=>x===oldKey?newKey:x)) if(!next.includes(value)) next.push(value);
      state.tagManualOrders[k]=next;
    }
  }
  function removeTagOrganization(key){
    if(!key) return;
    if(state.tagGroupByTag) delete state.tagGroupByTag[key];
    for(const k of Object.keys(state.tagManualOrders||{})) state.tagManualOrders[k]=(state.tagManualOrders[k]||[]).filter(x=>x!==key);
  }
  function notesWithTag(tag){
    const key=tagKey(tag);
    return state.notes.filter(n=>!n.trashed && (n.tags||[]).some(t=>tagKey(t)===key));
  }
  function renameTagEverywhere(oldTag,newTag){
    const oldKey=tagKey(oldTag); const clean=String(newTag||'').trim(); const newKey=tagKey(clean);
    if(!oldKey || !clean) return 0;
    let changed=0;
    for(const n of state.notes){
      if(!(n.tags||[]).some(t=>tagKey(t)===oldKey)) continue;
      const replaced=(n.tags||[]).map(t=>tagKey(t)===oldKey?clean:t);
      n.tags=dedupeTags(replaced); n.updated=now(); queueAutoSnapshot(n); changed++;
    }
    moveTagOrganization(oldKey,newKey);
    cleanTagOrganization();
    if(currentTag && tagKey(currentTag)===oldKey) currentTag=clean;
    persist(); renderAll(); renderTagManager();
    return changed;
  }
  function deleteTagEverywhere(tag){
    const key=tagKey(tag); if(!key) return 0; let changed=0;
    for(const n of state.notes){
      const next=(n.tags||[]).filter(t=>tagKey(t)!==key);
      if(next.length===(n.tags||[]).length) continue;
      n.tags=next; n.updated=now(); queueAutoSnapshot(n); changed++;
    }
    removeTagOrganization(key); cleanTagOrganization();
    if(currentTag && tagKey(currentTag)===key){ currentTag=null; currentView='inbox'; currentFolder=null; }
    persist(); renderAll(); renderTagManager();
    return changed;
  }
  function addTagGroup(name){
    const clean=String(name||'').trim(); if(!clean) return null;
    const group={id:id('tg'),name:clean,collapsed:false};
    state.tagGroups ||= []; state.tagGroupOrder ||= [];
    state.tagGroups.push(group); state.tagGroupOrder.push(group.id); persist(); renderSidebar(); renderTagManager();
    return group;
  }
  function renameTagGroup(groupId){
    const group=state.tagGroups.find(g=>g.id===groupId); if(!group) return;
    const next=prompt('Rename tag group:',group.name); if(next===null) return;
    const clean=next.trim(); if(!clean) return;
    group.name=clean; persist(); renderSidebar(); renderTagManager();
  }
  function deleteTagGroup(groupId){
    const group=state.tagGroups.find(g=>g.id===groupId); if(!group) return;
    const memberCount=rawTagSummaries(false).filter(t=>state.tagGroupByTag?.[t.key]===groupId).length;
    if(!confirm(`Delete the “${group.name}” group? ${memberCount?`Its ${memberCount} tag${memberCount===1?'':'s'} will become ungrouped.`:'No tags will be deleted.'}`)) return;
    for(const key of Object.keys(state.tagGroupByTag||{})) if(state.tagGroupByTag[key]===groupId) delete state.tagGroupByTag[key];
    state.tagGroups=state.tagGroups.filter(g=>g.id!==groupId);
    state.tagGroupOrder=(state.tagGroupOrder||[]).filter(id=>id!==groupId);
    delete state.tagManualOrders?.[tagGroupKey(groupId)];
    cleanTagOrganization(); persist(); renderSidebar(); renderTagManager();
  }
  function setTagGroup(tagKeyValue,groupId){
    state.tagGroupByTag ||= {};
    const oldGroup=state.tagGroupByTag[tagKeyValue]||null;
    const next=groupId||null;
    if(oldGroup===next) return;
    if(next) state.tagGroupByTag[tagKeyValue]=next; else delete state.tagGroupByTag[tagKeyValue];
    state.tagManualOrders ||= {};
    const oldOrderKey=tagGroupKey(oldGroup), newOrderKey=tagGroupKey(next);
    if(Array.isArray(state.tagManualOrders[oldOrderKey])) state.tagManualOrders[oldOrderKey]=state.tagManualOrders[oldOrderKey].filter(k=>k!==tagKeyValue);
    state.tagManualOrders[newOrderKey]=Array.isArray(state.tagManualOrders[newOrderKey])?state.tagManualOrders[newOrderKey].filter(k=>k!==tagKeyValue):[];
    state.tagManualOrders[newOrderKey].push(tagKeyValue);
    persist();
  }
  function renderTagManager(){
    if(!els.tagManagerList) return;
    cleanTagOrganization();
    if(els.tagManagerGroups){
      els.tagManagerGroups.innerHTML='';
      const groups=orderedTagGroups();
      if(!groups.length){
        els.tagManagerGroups.innerHTML='<div class="tag-manager-empty compact-empty">No tag groups yet.</div>';
      }else{
        for(const g of groups){
          const row=document.createElement('div'); row.className='tag-manager-group-row';
          const count=rawTagSummaries(false).filter(t=>state.tagGroupByTag?.[t.key]===g.id).length;
          const info=document.createElement('div'); info.className='tag-manager-info'; info.innerHTML=`<div class="tag-manager-name">${escapeHtml(g.name)}</div><div class="tag-manager-count">${count} tag${count===1?'':'s'}</div>`;
          const actions=document.createElement('div'); actions.className='tag-manager-actions';
          const rename=document.createElement('button'); rename.type='button'; rename.textContent='Rename'; rename.addEventListener('click',()=>renameTagGroup(g.id));
          const del=document.createElement('button'); del.type='button'; del.className='danger-action'; del.textContent='Delete'; del.addEventListener('click',()=>deleteTagGroup(g.id));
          actions.append(rename,del); row.append(info,actions); els.tagManagerGroups.appendChild(row);
        }
      }
    }
    const tags=tagSummaries(false);
    els.tagManagerList.innerHTML='';
    if(!tags.length){ els.tagManagerList.innerHTML='<div class="tag-manager-empty">No tags yet.</div>'; return; }
    for(const item of tags){
      const row=document.createElement('div'); row.className='tag-manager-row';
      const info=document.createElement('div'); info.className='tag-manager-info';
      info.innerHTML=`<div class="tag-manager-name">#${escapeHtml(item.name)}</div><div class="tag-manager-count">${item.count} note${item.count===1?'':'s'}</div>`;
      const controls=document.createElement('div'); controls.className='tag-manager-controls';
      const groupSelect=document.createElement('select'); groupSelect.className='tag-group-select'; groupSelect.setAttribute('aria-label',`Group for ${item.name}`);
      groupSelect.innerHTML='<option value="">Ungrouped</option>'+orderedTagGroups().map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
      groupSelect.value=state.tagGroupByTag?.[item.key]||'';
      groupSelect.addEventListener('change',()=>{ setTagGroup(item.key,groupSelect.value||null); renderSidebar(); renderTagManager(); });
      const actions=document.createElement('div'); actions.className='tag-manager-actions';
      const rename=document.createElement('button'); rename.type='button'; rename.textContent='Rename';
      rename.addEventListener('click',()=>{
        const next=prompt(`Rename #${item.name} to:`,item.name); if(next===null) return;
        const clean=next.trim(); if(!clean || tagKey(clean)===item.key) return;
        const count=renameTagEverywhere(item.name,clean); if(count) toast(`Renamed tag on ${count} note${count===1?'':'s'}`);
      });
      const merge=document.createElement('button'); merge.type='button'; merge.textContent='Merge';
      merge.addEventListener('click',()=>{
        const target=prompt(`Merge #${item.name} into which tag?`,''); if(target===null) return;
        const clean=target.trim(); if(!clean || tagKey(clean)===item.key) return;
        const count=renameTagEverywhere(item.name,clean); if(count) toast(`Merged tag on ${count} note${count===1?'':'s'}`);
      });
      const del=document.createElement('button'); del.type='button'; del.textContent='Delete'; del.className='danger-action';
      del.addEventListener('click',()=>{
        if(!confirm(`Remove #${item.name} from ${item.count} note${item.count===1?'':'s'}?`)) return;
        const count=deleteTagEverywhere(item.name); if(count) toast(`Removed tag from ${count} note${count===1?'':'s'}`);
      });
      actions.append(rename,merge,del); controls.append(groupSelect,actions); row.append(info,controls); els.tagManagerList.appendChild(row);
    }
  }
  function openTagManager(){ flushPendingSave(); renderTagManager(); els.tagManagerDialog.showModal(); }

  function viewLocationKey(){
    if(currentTag) return `tag:${tagKey(currentTag)}`;
    if(currentFolder) return `folder:${currentFolder}`;
    return `view:${currentView}`;
  }
  function folderLocationKey(folderId){ return folderId ? `folder:${folderId}` : 'view:inbox'; }
  function currentSortPreference(){
    state.sortPrefs ||= {};
    return state.sortPrefs[viewLocationKey()] || 'updated-desc';
  }
  function notesForCurrentView(applySearch=true){
    const q=applySearch ? els.searchInput.value.trim().toLowerCase() : '';

    // Search is deliberately global. The search box says “Search all notes”,
    // so a query must not be limited by whichever folder/view happens to be
    // open in the sidebar. Archived notes are searchable too.
    if(q){
      return state.notes.filter(n=>{
        const folder=state.folders.find(f=>f.id===n.folderId)?.name||'';
        const searchable=[
          displayTitle(n),
          n.body||'',
          (n.tags||[]).join(' '),
          folder,
          n.archived?'archive archived':'',
          n.trashed?'trash deleted':'',
          n.pinned?'pinned favorite favourite':''
        ].join(' ').toLowerCase();
        return searchable.includes(q);
      });
    }

    return state.notes.filter(n=>{
      if(currentTag) return !n.trashed && (n.tags||[]).some(t=>tagKey(t)===tagKey(currentTag));
      if(currentFolder) return !n.trashed&&!n.archived&&n.folderId===currentFolder;
      if(currentView==='pinned') return !n.trashed&&!n.archived&&n.pinned;
      if(currentView==='archived') return !n.trashed&&n.archived;
      if(currentView==='trash') return !!n.trashed;
      return !n.trashed&&!n.archived&&!n.folderId;
    });
  }
  function sortNotes(notes, preference=currentSortPreference(), key=viewLocationKey()){
    const copy=[...notes];
    const titleCompare=(a,b)=>displayTitle(a).localeCompare(displayTitle(b),undefined,{numeric:true,sensitivity:'base'});
    if(preference==='manual'){
      state.manualOrders ||= {};
      const order=Array.isArray(state.manualOrders[key]) ? state.manualOrders[key] : [];
      const pos=new Map(order.map((id,i)=>[id,i]));
      return copy.sort((a,b)=>{
        const ai=pos.has(a.id)?pos.get(a.id):Number.MAX_SAFE_INTEGER;
        const bi=pos.has(b.id)?pos.get(b.id):Number.MAX_SAFE_INTEGER;
        if(ai!==bi) return ai-bi;
        return new Date(b.updated)-new Date(a.updated);
      });
    }
    if(preference==='updated-asc') return copy.sort((a,b)=>new Date(a.updated)-new Date(b.updated));
    if(preference==='created-desc') return copy.sort((a,b)=>new Date(b.created)-new Date(a.created));
    if(preference==='created-asc') return copy.sort((a,b)=>new Date(a.created)-new Date(b.created));
    if(preference==='title-asc') return copy.sort(titleCompare);
    if(preference==='title-desc') return copy.sort((a,b)=>titleCompare(b,a));
    return copy.sort((a,b)=>new Date(b.updated)-new Date(a.updated));
  }
  function ensureManualOrder(key, orderedNotes){
    state.manualOrders ||= {};
    const validIds=new Set(notesForLocationKey(key).map(n=>n.id));
    const existing=Array.isArray(state.manualOrders[key]) ? state.manualOrders[key].filter(id=>validIds.has(id)) : [];
    const seed=orderedNotes ? orderedNotes.map(n=>n.id) : [];
    const merged=[];
    for(const id of [...seed,...existing,...validIds]) if(validIds.has(id) && !merged.includes(id)) merged.push(id);
    state.manualOrders[key]=merged;
    return merged;
  }
  function notesForLocationKey(key){
    if(key.startsWith('tag:')){
      const wanted=key.slice(4);
      return state.notes.filter(n=>!n.trashed && (n.tags||[]).some(t=>tagKey(t)===wanted));
    }
    if(key.startsWith('folder:')){
      const folderId=key.slice(7);
      return state.notes.filter(n=>!n.trashed&&!n.archived&&n.folderId===folderId);
    }
    if(key==='view:inbox') return state.notes.filter(n=>!n.trashed&&!n.archived&&!n.folderId);
    if(key==='view:pinned') return state.notes.filter(n=>!n.trashed&&!n.archived&&n.pinned);
    if(key==='view:archived') return state.notes.filter(n=>!n.trashed&&n.archived);
    if(key==='view:trash') return state.notes.filter(n=>n.trashed);
    return [];
  }
  function updateManualLocation(noteId, fromFolderId, toFolderId){
    state.manualOrders ||= {};
    const fromKey=folderLocationKey(fromFolderId);
    const toKey=folderLocationKey(toFolderId);
    if(Array.isArray(state.manualOrders[fromKey])) state.manualOrders[fromKey]=state.manualOrders[fromKey].filter(id=>id!==noteId);
    if(Array.isArray(state.manualOrders[toKey])){
      state.manualOrders[toKey]=state.manualOrders[toKey].filter(id=>id!==noteId);
      state.manualOrders[toKey].unshift(noteId);
    }
  }
  function moveNoteToFolder(note, folderId){
    if(!note) return false;
    const next=folderId||null;
    const previous=note.folderId||null;
    const wasTrashed=!!note.trashed;
    if(previous!==next) updateManualLocation(note.id,previous,next);
    note.folderId=next;
    if(wasTrashed){
      note.trashed=false; note.deletedAt=null; note.archived=false; delete note.preTrashArchived;
    }
    if(previous!==next || wasTrashed) note.updated=now();
    if(previous!==next || wasTrashed) queueAutoSnapshot(note);
    return wasTrashed;
  }

  function newNote(){
    flushPendingSave();
    const n = { id:id(), body:'', customTitle:null, tags:[], folderId:null, pinned:false, archived:false, trashed:false, deletedAt:null, created:now(), updated:now(), attachments:[] };
    state.notes.unshift(n);
    state.manualOrders ||= {};
    if(Array.isArray(state.manualOrders['view:inbox'])) state.manualOrders['view:inbox'].unshift(n.id);
    selectedId = n.id; currentView='inbox'; currentFolder=null; currentTag=null; persist(); renderAll(); focusEditor(); closeSidebar();
  }
  function focusEditor(){ setTimeout(()=>{ if(cmEditor) cmEditor.focus(); else els.editor.focus(); }, 0); }

  function renderAll(){
    renderSidebar(); renderNotesList(); renderEditor();
  }
  function renderSidebar(){
    // Sortable temporarily moves the actual note-row DOM node into a drop
    // target. Remove any such transient rows before rebuilding navigation so
    // a moved note can never remain visually nested under Inbox or a folder.
    document.querySelectorAll('.inbox-drop-zone > .note-row, .folder-drop-zone > .note-row').forEach(el=>el.remove());
    els.inboxCount.textContent = state.notes.filter(n=>!n.trashed&&!n.archived && !n.folderId).length || '';
    els.pinnedCount.textContent = state.notes.filter(n=>!n.trashed&&!n.archived && n.pinned).length || '';
    els.archiveCount.textContent = state.notes.filter(n=>!n.trashed&&n.archived).length || '';
    els.trashCount.textContent = state.notes.filter(n=>n.trashed).length || '';
    document.querySelectorAll('.nav-item').forEach(btn=>btn.classList.toggle('active', !currentTag && currentView===btn.dataset.view && !currentFolder));
    els.folderList.innerHTML='';
    state.folders.sort((a,b)=>a.name.localeCompare(b.name)).forEach(f=>{
      const count=state.notes.filter(n=>!n.trashed&&!n.archived&&n.folderId===f.id).length;
      const zone=document.createElement('div');
      zone.className='folder-drop-zone';
      zone.dataset.folderId=f.id;
      const b=document.createElement('button'); b.className='folder-item'+(currentFolder===f.id?' active':'');
      b.innerHTML=`<span class="folder-name">${escapeHtml(f.name)}</span><span class="count">${count||''}</span>`;
      b.addEventListener('click',()=>{ flushPendingSave(); currentTag=null; currentFolder=f.id; currentView='folder'; els.searchInput.value=''; renderAll(); closeSidebar(); });
      zone.appendChild(b);
      els.folderList.appendChild(zone);
    });
    if(els.tagList){
      state.ui ||= {tagsCollapsed:false};
      state.tagSettings ||= {sort:'az'};
      cleanTagOrganization();
      const tagsCollapsed=!!state.ui.tagsCollapsed;
      els.tagList.hidden=tagsCollapsed;
      if(els.tagsToggleBtn){
        els.tagsToggleBtn.setAttribute('aria-expanded',String(!tagsCollapsed));
        els.tagsToggleBtn.title=tagsCollapsed?'Expand tags':'Collapse tags';
      }
      if(els.tagsChevron) els.tagsChevron.textContent=tagsCollapsed?'›':'⌄';
      if(els.tagSortSelect) els.tagSortSelect.value=state.tagSettings.sort==='manual'?'manual':'az';
      els.tagList.innerHTML='';
      const groups=orderedTagGroups();
      const allTags=rawTagSummaries(false);
      const hasGroups=groups.length>0;

      const makeTagButton=(item)=>{
        const row=document.createElement('div'); row.className='tag-sort-row'; row.dataset.tagKey=item.key;
        if(state.tagSettings.sort==='manual'){
          const handle=document.createElement('span'); handle.className='tag-drag-handle'; handle.textContent='⠿'; handle.title='Reorder or move tag'; handle.setAttribute('aria-hidden','true'); row.appendChild(handle);
        }
        const b=document.createElement('button'); b.className='tag-item'+(currentTag&&tagKey(currentTag)===item.key?' active':'');
        b.innerHTML=`<span class="tag-name">${escapeHtml(item.name)}</span><span class="count">${item.count}</span>`;
        b.addEventListener('click',()=>{ flushPendingSave(); currentTag=item.name; currentFolder=null; currentView='tag'; els.searchInput.value=''; const matches=notesWithTag(item.name); if(!matches.some(n=>n.id===selectedId)) selectedId=matches[0]?.id||selectedId; renderAll(); closeSidebar(); });
        row.appendChild(b); return row;
      };
      const makeGroup=(group,ungrouped=false)=>{
        const gid=ungrouped?null:group.id;
        const items=tagsForGroup(gid);
        const wrap=document.createElement('section'); wrap.className='tag-group'+(ungrouped?' tag-group-ungrouped':''); wrap.dataset.groupId=gid||'';
        const head=document.createElement('div'); head.className='tag-group-head';
        if(!ungrouped){ const drag=document.createElement('span'); drag.className='tag-group-drag-handle'; drag.textContent='⠿'; drag.title='Reorder tag group'; head.appendChild(drag); }
        const toggle=document.createElement('button'); toggle.type='button'; toggle.className='tag-group-toggle';
        const collapsed=ungrouped?false:!!group.collapsed;
        toggle.innerHTML=`<span class="tag-group-chevron">${collapsed?'›':'⌄'}</span><span class="tag-group-name">${escapeHtml(ungrouped?'Ungrouped':group.name)}</span><span class="count">${items.length||''}</span>`;
        toggle.setAttribute('aria-expanded',String(!collapsed));
        if(!ungrouped) toggle.addEventListener('click',()=>{ group.collapsed=!group.collapsed; persist(); renderSidebar(); });
        else toggle.disabled=true;
        head.appendChild(toggle);
        wrap.appendChild(head);
        const list=document.createElement('div'); list.className='tag-group-items'; list.dataset.groupId=gid||''; list.hidden=collapsed;
        items.forEach(item=>list.appendChild(makeTagButton(item)));
        // Every tag group gets a temporary drop target in Manual mode. It is
        // hidden during normal use and becomes visible only while a tag is
        // being dragged, so populated groups and Ungrouped are just as easy
        // to target as an empty group.
        if(state.tagSettings.sort==='manual'){
          const hint=document.createElement('div'); hint.className='tag-drop-hint'; hint.textContent='Drop tag here'; list.appendChild(hint);
        }
        wrap.appendChild(list); return wrap;
      };

      if(hasGroups || state.tagSettings.sort==='manual') els.tagList.appendChild(makeGroup(null,true));
      else tagsForGroup(null).forEach(item=>els.tagList.appendChild(makeTagButton(item)));
      for(const group of groups) els.tagList.appendChild(makeGroup(group,false));
      if(!allTags.length) els.tagList.innerHTML='<div class="tag-sidebar-empty">No tags yet</div>';
      requestAnimationFrame(setupTagDragging);
    }
    fillFolderSelect();
    requestAnimationFrame(setupNoteDragging);
  }
  function setupTagDragging(){
    tagItemSortables.forEach(x=>{try{x.destroy();}catch{}}); tagItemSortables=[];
    if(tagGroupSortable){ try{tagGroupSortable.destroy();}catch{} tagGroupSortable=null; }
    if(!window.Sortable || !els.tagList || state.tagSettings?.sort!=='manual' || state.ui?.tagsCollapsed) return;
    ensureTagManualOrders();
    const lists=[...els.tagList.querySelectorAll('.tag-group-items')];
    const clearTagDropFeedback=()=>{
      els.tagList?.querySelectorAll('.tag-drop-hover,.tag-drop-empty').forEach(el=>el.classList.remove('tag-drop-hover','tag-drop-empty'));
      els.tagList?.querySelectorAll('.tag-drop-hover-group').forEach(el=>el.classList.remove('tag-drop-hover-group'));
      els.tagList?.querySelectorAll('.tag-insert-before,.tag-insert-after').forEach(el=>el.classList.remove('tag-insert-before','tag-insert-after'));
    };
    const beginTagDragUI=()=>{
      clearTagDropFeedback();
      els.tagList?.classList.add('tag-item-dragging');
      // Collapsed groups need a small invisible landing area while a tag is
      // moving. They remain visually collapsed until the pointer is actually
      // over them, at which point the group itself provides the feedback.
      for(const targetList of lists){
        if(targetList.hidden){
          targetList.dataset.restoreHidden='1';
          targetList.hidden=false;
          targetList.classList.add('tag-drop-only');
        }
      }
    };
    const endTagDragUI=()=>{
      clearTagDropFeedback();
      els.tagList?.classList.remove('tag-item-dragging');
      for(const targetList of lists){
        if(targetList.dataset.restoreHidden==='1'){
          targetList.hidden=true;
          delete targetList.dataset.restoreHidden;
        }
        targetList.classList.remove('tag-drop-only');
      }
    };
    const showTagDropFeedback=(evt)=>{
      clearTagDropFeedback();
      const targetList=evt?.to;
      if(!targetList?.classList?.contains('tag-group-items')) return true;
      targetList.classList.add('tag-drop-hover');
      targetList.closest('.tag-group')?.classList.add('tag-drop-hover-group');

      const related=evt.related;
      if(related?.classList?.contains('tag-sort-row') && related!==evt.dragged){
        related.classList.add(evt.willInsertAfter?'tag-insert-after':'tag-insert-before');
      }else{
        const otherRows=[...targetList.querySelectorAll('.tag-sort-row')].filter(row=>row!==evt.dragged);
        if(!otherRows.length) targetList.classList.add('tag-drop-empty');
      }
      return true;
    };
    for(const list of lists){
      const sortableTagList=new Sortable(list,{
        group:'notes-tag-items', draggable:'.tag-sort-row', handle:'.tag-drag-handle', animation:120,
        forceFallback:true, fallbackOnBody:true, delayOnTouchOnly:true, delay:80, touchStartThreshold:4,
        ghostClass:'tag-sort-ghost', chosenClass:'tag-sort-chosen',
        onStart(){ beginTagDragUI(); },
        onMove(evt){ return showTagDropFeedback(evt); },
        onEnd(evt){
          endTagDragUI();
          const key=evt.item?.dataset?.tagKey; if(!key) return;
          const sourceGroup=evt.from?.dataset?.groupId||null;
          const targetGroup=evt.to?.dataset?.groupId||null;
          if(sourceGroup!==targetGroup){
            if(targetGroup) state.tagGroupByTag[key]=targetGroup; else delete state.tagGroupByTag[key];
          }
          for(const targetList of lists){
            const gid=targetList.dataset.groupId||null;
            state.tagManualOrders[tagGroupKey(gid)]=[...targetList.querySelectorAll('.tag-sort-row')].map(row=>row.dataset.tagKey).filter(Boolean);
          }
          cleanTagOrganization(); persist(); renderSidebar();
        }
      });
      tagItemSortables.push(sortableTagList);
    }
    tagGroupSortable=new Sortable(els.tagList,{
      draggable:'.tag-group:not(.tag-group-ungrouped)', handle:'.tag-group-drag-handle', animation:120,
      forceFallback:true, fallbackOnBody:true, delayOnTouchOnly:true, delay:80, touchStartThreshold:4,
      ghostClass:'tag-sort-ghost', chosenClass:'tag-sort-chosen',
      onEnd(){
        state.tagGroupOrder=[...els.tagList.querySelectorAll('.tag-group:not(.tag-group-ungrouped)')].map(el=>el.dataset.groupId).filter(Boolean);
        persist(); renderSidebar();
      }
    });
  }

  function fillFolderSelect(){
    const val=currentNote()?.folderId || '';
    els.folderSelect.innerHTML='<option value="">Inbox / No folder</option>'+state.folders.sort((a,b)=>a.name.localeCompare(b.name)).map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
    els.folderSelect.value=val;
  }
  function visibleNotes(){
    const searching=!!els.searchInput.value.trim();
    // A folder-specific manual order has no sensible meaning for a global
    // result set, so fall back to recently modified while searching.
    const preference=searching && currentSortPreference()==='manual' ? 'updated-desc' : currentSortPreference();
    return sortNotes(notesForCurrentView(true),preference);
  }
  function noteLocationLabel(note){
    const folder=state.folders.find(f=>f.id===note.folderId)?.name;
    const place=folder||'Inbox';
    return note.trashed ? `Trash · ${place}` : (note.archived ? `Archive · ${place}` : place);
  }
  function renderNotesList(){
    const query=els.searchInput.value.trim();
    const folder=state.folders.find(f=>f.id===currentFolder);
    if(query){
      els.viewTitle.textContent='Search';
    } else if(currentTag){
      els.viewTitle.textContent=`#${currentTag}`;
    } else {
      els.viewTitle.textContent=folder?.name || ({inbox:'Inbox',pinned:'Pinned',archived:'Archive',trash:'Trash'}[currentView]||'Notes');
    }
    const notes=visibleNotes();
    els.viewSubtitle.textContent=query
      ? `${notes.length} result${notes.length===1?'':'s'} for “${query}”`
      : `${notes.length} note${notes.length===1?'':'s'}`;
    if(els.sortSelect){
      const manualOption=els.sortSelect.querySelector('option[value="manual"]');
      if(manualOption) manualOption.disabled=!!currentTag;
      if(currentTag && currentSortPreference()==='manual') state.sortPrefs[viewLocationKey()]='updated-desc';
      els.sortSelect.value=currentSortPreference();
      els.sortSelect.title=currentTag ? 'Manual ordering is available inside folders and Inbox' : (currentSortPreference()==='manual' && els.searchInput.value.trim() ? 'Clear search to reorder notes manually' : 'Sort notes');
    }
    els.notesList.innerHTML='';
    if(!notes.length){ els.notesList.innerHTML='<div class="empty-state">No notes here yet.</div>'; return; }
    notes.forEach(n=>{
      const row=document.createElement('div'); row.className='note-row'+(n.id===selectedId?' active':''); row.dataset.noteId=n.id;
      const tags=(n.tags||[]).slice(0,2).map(t=>`<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
      const location=(query || currentTag) ? `<span>${escapeHtml(noteLocationLabel(n))}</span>` : '';
      row.innerHTML=`<div class="note-drag-handle" title="${currentSortPreference()==='manual'?'Reorder or move note':'Move note'}" aria-label="${currentSortPreference()==='manual'?'Reorder or move note':'Move note'}">⠿</div><div class="note-row-content"><div class="note-row-title">${n.pinned?'★ ':''}${escapeHtml(displayTitle(n))}</div><div class="note-row-preview">${escapeHtml(previewText(n.body)||'Empty note')}</div><div class="note-row-meta"><span>${formatDate(n.updated)}</span>${location}${tags}</div></div>`;
      row.addEventListener('click',e=>{ if(e.target.closest('.note-drag-handle')) return; flushPendingSave(); selectedId=n.id; persist(); renderAll(); });
      els.notesList.appendChild(row);
    });
    requestAnimationFrame(setupNoteDragging);
  }

  function clearFolderDropHighlight(){
    document.querySelectorAll('.folder-drop-zone.drop-target,.inbox-drop-zone.drop-target').forEach(el=>el.classList.remove('drop-target'));
  }
  function setupNoteDragging(){
    if(noteListSortable){ noteListSortable.destroy(); noteListSortable=null; }
    folderDropSortables.forEach(x=>x.destroy()); folderDropSortables=[];
    clearFolderDropHighlight();
    if(!window.Sortable || !els.notesList) return;

    const manualReorder=!currentTag && currentSortPreference()==='manual' && !els.searchInput.value.trim();
    const manualKey=viewLocationKey();
    const dragOptions={
      group:{name:'notes-to-folders',pull:true,put:false},
      sort:manualReorder,
      draggable:'.note-row',
      handle:'.note-drag-handle',
      animation:120,
      forceFallback:true,
      fallbackOnBody:true,
      fallbackTolerance:3,
      delayOnTouchOnly:true,
      delay:100,
      touchStartThreshold:4,
      ghostClass:'note-drag-ghost',
      chosenClass:'note-drag-chosen',
      fallbackClass:'note-drag-fallback',
      onChoose:()=>{
        flushPendingSave();
        document.body.classList.add('dragging-note');
        if(window.matchMedia('(max-width: 900px)').matches) openSidebar();
      },
      onMove:evt=>{
        clearFolderDropHighlight();
        if(evt.to?.classList?.contains('folder-drop-zone') || evt.to?.classList?.contains('inbox-drop-zone')) evt.to.classList.add('drop-target');
        return true;
      },
      onEnd:evt=>{
        if(manualReorder && evt.from===els.notesList && evt.to===els.notesList){
          state.manualOrders ||= {};
          state.manualOrders[manualKey]=[...els.notesList.querySelectorAll('.note-row')].map(row=>row.dataset.noteId).filter(Boolean);
          persist();
          toast('Manual order saved');
        }
        document.body.classList.remove('dragging-note'); clearFolderDropHighlight();
      }
    };
    noteListSortable=new Sortable(els.notesList,dragOptions);

    document.querySelectorAll('.folder-drop-zone').forEach(zone=>{
      const target=new Sortable(zone,{
        group:{name:'notes-to-folders',pull:false,put:true},
        sort:false,
        draggable:'.note-row',
        forceFallback:true,
        fallbackOnBody:true,
        onAdd:evt=>{
          const noteId=evt.item?.dataset?.noteId;
          const folderId=evt.to?.dataset?.folderId;
          // The target is navigation, not a real list container. Sortable has
          // inserted the note card here only as part of the drag operation, so
          // remove that transient DOM node immediately and let renderAll()
          // recreate the card in the correct notes pane.
          evt.item?.remove();
          const note=state.notes.find(n=>n.id===noteId);
          if(note && folderId){
            const restored=moveNoteToFolder(note,folderId);
            persist();
            if(restored){ currentFolder=folderId; currentView='folder'; }
            const folderName=state.folders.find(f=>f.id===folderId)?.name||'folder';
            toast(restored?`Restored to ${folderName}`:`Moved to ${folderName}`);
          }
          document.body.classList.remove('dragging-note');
          clearFolderDropHighlight();
          renderAll();
          if(window.matchMedia('(max-width: 900px)').matches) closeSidebar();
        }
      });
      folderDropSortables.push(target);
    });

    if(els.inboxDropZone){
      const inboxTarget=new Sortable(els.inboxDropZone,{
        group:{name:'notes-to-folders',pull:false,put:true},
        sort:false,
        draggable:'.note-row',
        forceFallback:true,
        fallbackOnBody:true,
        onAdd:evt=>{
          const noteId=evt.item?.dataset?.noteId;
          evt.item?.remove();
          const note=state.notes.find(n=>n.id===noteId);
          if(note){
            const restored=moveNoteToFolder(note,null);
            persist();
            if(restored){ currentFolder=null; currentView='inbox'; }
            toast(restored?'Restored to Inbox':'Moved to Inbox');
          }
          document.body.classList.remove('dragging-note');
          clearFolderDropHighlight();
          renderAll();
          if(window.matchMedia('(max-width: 900px)').matches) closeSidebar();
        }
      });
      folderDropSortables.push(inboxTarget);
    }
  }
  function renderEditor(){
    let n=currentNote();
    if(!n){ if(state.notes.length){ selectedId=state.notes[0].id; n=currentNote(); } else { newNote(); return; } }
    els.noteTitle.value=displayTitle(n);
    setEditorValue(n.body);
    els.tagsInput.value=(n.tags||[]).join(', ');
    fillFolderSelect();
    els.pinBtn.textContent=n.pinned?'★':'☆';
    els.pinBtn.disabled=!!n.trashed;
    els.folderSelect.disabled=!!n.trashed;
    if(n.trashed){
      els.archiveBtn.title='Restore from Trash';
      els.archiveBtn.textContent='↩';
      els.deleteBtn.title='Delete permanently';
      els.deleteBtn.setAttribute('aria-label','Delete permanently');
    }else{
      els.archiveBtn.title=n.archived?'Unarchive':'Archive';
      els.archiveBtn.textContent=n.archived?'↩':'⌑';
      els.deleteBtn.title='Move to Trash';
      els.deleteBtn.setAttribute('aria-label','Move to Trash');
    }
    if(previewMode) renderPreview();
    else scheduleTaskCheckboxRefresh();
  }

  function capturePreEditVersion(){
    if(saveTimer) return;
    const n=currentNote(); if(!n) return;
    if(!(n.body||'').trim() && !(n.customTitle||'').trim() && !(n.tags||[]).length) return;
    createSnapshot(n,'Before edit',false);
  }
  function scheduleSave(){
    els.saveStatus.textContent='Saving…'; clearTimeout(saveTimer); saveTimer=setTimeout(saveEditorNow,350);
  }
  function flushPendingSave(){
    if(!saveTimer) return;
    clearTimeout(saveTimer); saveTimer=null; saveEditorNow();
  }
  function saveEditorNow(){
    saveTimer=null;
    const n=currentNote(); if(!n) return;
    n.body=editorValue(); n.updated=now(); persist(); queueAutoSnapshot(n); els.noteTitle.value=displayTitle(n); renderNotesList();
  }

  function lineBounds(text,pos){
    const start=text.lastIndexOf('\n',pos-1)+1; let end=text.indexOf('\n',pos); if(end<0) end=text.length; return {start,end};
  }
  function replaceSelection(before,after=before,placeholder='text'){
    if(cmEditor){
      const chosen=cmEditor.getSelection();
      if(chosen){
        cmEditor.replaceSelection(before+chosen+after,'end');
      } else if(placeholder != null){
        cmEditor.replaceSelection(before+placeholder+after,'end');
      } else {
        const start=cmEditor.getCursor();
        cmEditor.replaceSelection(before+after,'end');
        cmEditor.setCursor({line:start.line,ch:start.ch+before.length});
      }
      cmEditor.focus(); return;
    }
    const ta=els.editor; const a=ta.selectionStart,b=ta.selectionEnd; const chosen=ta.value.slice(a,b);
    if(chosen){
      ta.setRangeText(before+chosen+after,a,b,'end');
    } else if(placeholder != null){
      ta.setRangeText(before+placeholder+after,a,b,'end');
    } else {
      ta.setRangeText(before+after,a,b,'end');
      ta.setSelectionRange(a+before.length,a+before.length);
    }
    scheduleSave(); ta.focus();
  }
  function prefixCurrentLines(prefix){
    if(cmEditor){
      const from=cmEditor.getCursor('from'), to=cmEditor.getCursor('to');
      cmEditor.operation(()=>{
        for(let line=from.line;line<=to.line;line++){
          const text=cmEditor.getLine(line);
          const p=typeof prefix==='function'?prefix(text,line-from.line):prefix;
          cmEditor.replaceRange(p,{line,ch:0});
        }
      });
      cmEditor.focus(); return;
    }
    const ta=els.editor; const a=ta.selectionStart,b=ta.selectionEnd; const start=lineBounds(ta.value,a).start; const end=lineBounds(ta.value,b).end;
    const chunk=ta.value.slice(start,end); const out=chunk.split('\n').map((line,i)=> typeof prefix==='function'?prefix(line,i):prefix+line).join('\n');
    ta.setRangeText(out,start,end,'select'); scheduleSave(); ta.focus();
  }
  function makeCheckbox(){
    if(cmEditor){
      const from=cmEditor.getCursor('from'), to=cmEditor.getCursor('to');
      cmEditor.operation(()=>{
        for(let lineNo=from.line;lineNo<=to.line;lineNo++){
          const text=cmEditor.getLine(lineNo)||'';
          if(/^\s*[-*+]\s+\[[ xX]\](?:\s|$)/.test(text)) continue;
          const indent=(text.match(/^\s*/)||[''])[0];
          const body=text.slice(indent.length).replace(/^[-*+]\s+/,'');
          cmEditor.replaceRange(`${indent}- [ ] ${body}`,{line:lineNo,ch:0},{line:lineNo,ch:text.length},'+task-list');
        }
      });
      scheduleTaskCheckboxRefresh();
      cmEditor.focus();
      return;
    }
    const ta=els.editor; const a=ta.selectionStart,b=ta.selectionEnd; const start=lineBounds(ta.value,a).start; const end=lineBounds(ta.value,b).end;
    const chunk=ta.value.slice(start,end);
    const out=chunk.split('\n').map(line=>{
      if(/^\s*[-*+]\s+\[[ xX]\](?:\s|$)/.test(line)) return line;
      const indent=(line.match(/^\s*/)||[''])[0];
      const body=line.slice(indent.length).replace(/^[-*+]\s+/,'');
      return `${indent}- [ ] ${body}`;
    }).join('\n');
    ta.setRangeText(out,start,end,'select'); scheduleSave(); ta.focus();
  }
  async function toolbarAction(action){
    if(reorderMode) finishReorder();
    if(previewMode) exitModes();
    switch(action){
      case 'checkbox': makeCheckbox(); break;
      case 'h1': setHeading(1); break; case 'h2': setHeading(2); break; case 'h3': setHeading(3); break;
      case 'bullet': prefixCurrentLines('- '); break;
      case 'number': prefixCurrentLines((line,i)=>`${i+1}. ${line}`); break;
      case 'quote': prefixCurrentLines('> '); break;
      case 'bold': replaceSelection('**','**',null); break;
      case 'italic': replaceSelection('*','*',null); break;
      case 'strike': replaceSelection('~~','~~',null); break;
      case 'code': insertCode(); break;
      case 'link': insertLink(); break;
      case 'image': els.imageInput.click(); break;
      case 'hr': insertAtCursor('\n\n---\n\n'); break;
    }
  }
  function setHeading(level){
    if(cmEditor){
      const cur=cmEditor.getCursor(); let line=cmEditor.getLine(cur.line).replace(/^#{1,6}\s+/,'');
      cmEditor.replaceRange('#'.repeat(level)+' '+line,{line:cur.line,ch:0},{line:cur.line,ch:cmEditor.getLine(cur.line).length}); cmEditor.focus(); return;
    }
    const ta=els.editor; const pos=ta.selectionStart; const {start,end}=lineBounds(ta.value,pos); let line=ta.value.slice(start,end).replace(/^#{1,6}\s+/,''); line='#'.repeat(level)+' '+line; ta.setRangeText(line,start,end,'end'); scheduleSave(); ta.focus();
  }
  function insertCode(){
    if(cmEditor){ if(cmEditor.somethingSelected()) replaceSelection('`','`','code'); else insertAtCursor('```\n\n```'); return; }
    const ta=els.editor; if(ta.selectionStart!==ta.selectionEnd) replaceSelection('`','`','code'); else insertAtCursor('```\n\n```');
  }
  function insertLink(){
    const selected=cmEditor ? cmEditor.getSelection() : els.editor.value.slice(els.editor.selectionStart,els.editor.selectionEnd);
    const label=selected||prompt('Link text:','')||''; if(!label)return; const url=prompt('URL:','https://'); if(!url)return;
    if(cmEditor){ cmEditor.replaceSelection(`[${label}](${url})`,'end'); cmEditor.focus(); return; }
    const ta=els.editor; const start=ta.selectionStart,end=ta.selectionEnd; ta.setRangeText(`[${label}](${url})`,start,end,'end'); scheduleSave(); ta.focus();
  }
  function insertAtCursor(text){
    if(cmEditor){ cmEditor.replaceSelection(text,'end'); cmEditor.focus(); return; }
    const ta=els.editor; ta.setRangeText(text,ta.selectionStart,ta.selectionEnd,'end'); scheduleSave(); ta.focus();
  }

  async function handleImage(file){
    if(!file) return; const n=currentNote(); if(!n)return;
    const ext=(file.name.split('.').pop()||'jpg').toLowerCase(); const base=safeFilename(file.name.replace(/\.[^.]+$/,'')); const filename=`${base}-${crypto.randomUUID().slice(0,6)}.${ext}`;
    await putAttachment(n.id,filename,file);
    n.attachments ||= []; n.attachments.push(filename); n.updated=now(); persist();
    insertAtCursor(`![${base}](attachments/${filename})`); toast('Image added');
  }

  function exitModes(){ previewMode=false; reorderMode=false; els.preview.hidden=true; els.reorderPanel.hidden=true; showEditor(true); els.previewBtn.classList.remove('active'); els.reorderBtn.classList.remove('active'); if(cmEditor) cmEditor.refresh(); }
  async function togglePreview(){
    flushPendingSave();
    if(reorderMode) finishReorder(); previewMode=!previewMode; els.previewBtn.classList.toggle('active',previewMode); showEditor(!previewMode); els.preview.hidden=!previewMode; if(previewMode) await renderPreview(); else { if(cmEditor) cmEditor.refresh(); focusEditor(); }
  }
  async function renderPreview(){
    releaseObjectUrls();
    const md=currentNote()?.body||'';
    let html;
    try { html=window.marked ? marked.parse(md,{gfm:true,breaks:false}) : fallbackMarkdown(md); } catch { html=fallbackMarkdown(md); }
    if(window.DOMPurify) html=DOMPurify.sanitize(html,{USE_PROFILES:{html:true}});
    els.preview.innerHTML=html;
    els.preview.querySelectorAll('li.task-list-item').forEach(li=>{
      const box=li.querySelector('input[type=\"checkbox\"]');
      if(box?.checked){
        // Strike only the task content so the line begins at the first word,
        // not in the spacer between the checkbox and its text.
        const nodes=[...li.childNodes].filter(node=>node!==box);
        const firstText=nodes.find(node=>node.nodeType===Node.TEXT_NODE);
        if(firstText) firstText.textContent=firstText.textContent.replace(/^\s+/,'');
        if(nodes.length){
          const span=document.createElement('span');
          span.className='task-complete-preview';
          nodes.forEach(node=>span.appendChild(node));
          li.appendChild(span);
        }
      }
    });
    const imgs=[...els.preview.querySelectorAll('img')];
    for(const img of imgs){
      const src=img.getAttribute('src')||'';
      if(src.startsWith('attachments/')){
        const blob=await getAttachment(currentNote().id,src.slice('attachments/'.length));
        if(blob){ const u=URL.createObjectURL(blob); objectUrls.push(u); img.src=u; }
      }
      img.loading='lazy';
    }
    els.preview.querySelectorAll('a').forEach(a=>{ a.target='_blank'; a.rel='noopener noreferrer'; });
  }
  function fallbackMarkdown(md){
    let s=escapeHtml(md); s=s.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>'); s=s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/\n\n/g,'</p><p>'); return '<p>'+s+'</p>';
  }
  function releaseObjectUrls(){ objectUrls.forEach(URL.revokeObjectURL); objectUrls=[]; }

  function isListLine(line){
    return /^(\s*)(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.test(line);
  }
  function isOrderedListLine(line){
    return /^(\s*)(\d+)([.)])(\s+)/.test(line);
  }
  function splitBlocks(text){
    // Reorder mode: every top-level Markdown list line is a separate draggable
    // unit. Ordinary prose is grouped into paragraph/section blocks. Fenced
    // code stays intact. Indented continuation text remains attached to the
    // list item it belongs to.
    const units=[];
    const lines=text.split('\n');
    let i=0;
    while(i<lines.length){
      const line=lines[i];
      if(!line.trim()){ i++; continue; }

      if(/^```/.test(line.trim())){
        const block=[line]; i++;
        while(i<lines.length){
          block.push(lines[i]);
          if(/^```/.test(lines[i].trim())){ i++; break; }
          i++;
        }
        units.push({text:block.join('\n'),kind:'block'});
        continue;
      }

      if(isListLine(line)){
        const item=[line];
        const baseIndent=(line.match(/^\s*/)||[''])[0].length;
        i++;
        // Only non-list indented continuation lines may join this item. A new
        // list marker ALWAYS starts a new draggable row, even with no blank
        // line between items.
        while(i<lines.length && lines[i].trim()){
          const next=lines[i];
          if(isListLine(next)) break;
          const indent=(next.match(/^\s*/)||[''])[0].length;
          if(indent>baseIndent){ item.push(next); i++; continue; }
          break;
        }
        units.push({text:item.join('\n'),kind:'list'});
        continue;
      }

      const block=[line]; i++;
      while(i<lines.length && lines[i].trim() && !isListLine(lines[i]) && !/^```/.test(lines[i].trim())){
        block.push(lines[i]); i++;
      }
      units.push({text:block.join('\n'),kind:'block'});
    }
    return units;
  }
  function joinReorderUnits(units){
    let out='';
    units.forEach((u,i)=>{
      if(i){
        const prev=units[i-1];
        // Adjacent list items stay on consecutive lines. Everything else
        // remains separated as Markdown blocks. These are real newlines,
        // not the literal characters backslash+n.
        out += (prev.kind==='list' && u.kind==='list') ? '\n' : '\n\n';
      }
      out += u.text;
    });
    return renumberOrderedLists(out);
  }
  function renumberOrderedLists(text){
    const lines=text.split('\n');
    const counters=new Map();
    let previousWasOrdered=false;
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
      if(!m){
        if(lines[i].trim()) counters.clear();
        previousWasOrdered=false;
        continue;
      }
      const key=m[1]+'|'+m[3];
      if(!previousWasOrdered || !counters.has(key)) counters.set(key,Number(m[2]));
      const n=counters.get(key);
      lines[i]=`${m[1]}${n}${m[3]}${m[4]}${m[5]}`;
      counters.set(key,n+1);
      previousWasOrdered=true;
    }
    return lines.join('\n');
  }
  function enterReorder(){
    flushPendingSave();
    if(previewMode){ previewMode=false; els.preview.hidden=true; els.previewBtn.classList.remove('active'); }
    reorderMode=true; els.reorderBtn.classList.add('active'); showEditor(false); els.reorderPanel.hidden=false;
    const blocks=splitBlocks(currentNote()?.body||''); els.blocksList.innerHTML='';
    blocks.forEach((b,i)=>{ const el=document.createElement('div'); el.className='reorder-block'; el.dataset.block=b.text; el.dataset.kind=b.kind; el.innerHTML=`<div class="grab-handle" aria-label="Drag ${b.kind==='list'?'list item':'block'}">⠿</div><div class="block-text"></div>`; el.querySelector('.block-text').textContent=b.text; els.blocksList.appendChild(el); });
    if(sortable) sortable.destroy();
    if(window.Sortable) sortable=new Sortable(els.blocksList,{animation:150,handle:'.grab-handle',ghostClass:'sortable-ghost',chosenClass:'sortable-chosen',delayOnTouchOnly:true,delay:80,touchStartThreshold:4});
  }
  function finishReorder(){
    if(!reorderMode) return; const n=currentNote(); if(!n)return;
    const blocks=[...els.blocksList.children].map(x=>({text:x.dataset.block,kind:x.dataset.kind||'block'})); n.body=joinReorderUnits(blocks); n.updated=now(); setEditorValue(n.body); persist(); queueAutoSnapshot(n); reorderMode=false; els.reorderPanel.hidden=true; showEditor(true); els.reorderBtn.classList.remove('active'); renderNotesList(); renderEditor(); if(cmEditor) cmEditor.refresh(); focusEditor();
  }

  function openSidebar(){ els.sidebar.classList.add('open'); els.scrim.classList.add('show'); }
  function closeSidebar(){ els.sidebar.classList.remove('open'); els.scrim.classList.remove('show'); }

  async function shareCurrent(){
    flushPendingSave();
    const n=currentNote(); if(!n)return; const selection=previewMode||reorderMode?'':(cmEditor?cmEditor.getSelection():els.editor.value.slice(els.editor.selectionStart,els.editor.selectionEnd)); const text=selection||n.body; const title=displayTitle(n);
    try{
      if(navigator.share){ await navigator.share({title,text}); return; }
      await navigator.clipboard.writeText(text); toast('Copied to clipboard');
    }catch(e){ if(e.name!=='AbortError') toast('Sharing unavailable here'); }
  }
  async function downloadCurrent(){
    flushPendingSave();
    const n=currentNote(); if(!n)return; const title=safeFilename(displayTitle(n)); const md=makeMarkdownFile(n);
    if((n.attachments||[]).length && window.JSZip){
      const zip=new JSZip(); zip.file(`${title}.md`,md); const folder=zip.folder('attachments');
      for(const name of n.attachments){ const blob=await getAttachment(n.id,name); if(blob) folder.file(name,blob); }
      const blob=await zip.generateAsync({type:'blob'}); downloadBlob(blob,`${title}.zip`); toast('Downloaded note + images');
    } else { downloadBlob(new Blob([md],{type:'text/markdown;charset=utf-8'}),`${title}.md`); }
  }
  function makeMarkdownFile(n){
    const tags=(n.tags||[]).map(t=>`  - ${t}`).join('\n'); const folder=state.folders.find(f=>f.id===n.folderId)?.name||'';
    const fm=`---\ntitle: ${JSON.stringify(displayTitle(n))}\ncreated: ${n.created}\nupdated: ${n.updated}\nfolder: ${JSON.stringify(folder)}\ntags:\n${tags||'  []'}\n---\n\n`; return fm+n.body;
  }
  function downloadBlob(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000); }

  async function exportBackup(){
    try{
      if(saveTimer){ clearTimeout(saveTimer); saveTimer=null; saveEditorNow(); }
      const history=await getAllHistory().catch(()=>[]);
      const payload={backupVersion:2,exportedAt:now(),state};
      if(window.JSZip){
        const zip=new JSZip();
        zip.file('notes-backup.json',JSON.stringify(payload,null,2));
        zip.file('history.json',JSON.stringify(history,null,2));
        const attRoot=zip.folder('attachments');
        for(const note of state.notes){
          for(const name of (note.attachments||[])){
            const blob=await getAttachment(note.id,name);
            if(blob) attRoot.folder(note.id).file(name,blob);
          }
        }
        const blob=await zip.generateAsync({type:'blob'});
        downloadBlob(blob,`notes-backup-${new Date().toISOString().slice(0,10)}.zip`);
        toast('Full backup exported');
      }else{
        downloadBlob(new Blob([JSON.stringify({...payload,history},null,2)],{type:'application/json'}),'notes-backup.json');
      }
    }catch{ toast('Backup could not be created'); }
  }
  async function importBackup(file){
    flushPendingSave();
    for(const timer of autoSnapshotTimers.values()) clearTimeout(timer);
    autoSnapshotTimers.clear(); permanentlyDeletedNoteIds.clear();
    try{
      let parsed, history=[];
      const isZip=/\.zip$/i.test(file.name)||file.type==='application/zip'||file.type==='application/x-zip-compressed';
      if(isZip){
        if(!window.JSZip) throw new Error('ZIP support unavailable');
        const zip=await JSZip.loadAsync(file);
        const stateFile=zip.file('notes-backup.json');
        if(!stateFile) throw new Error('Missing notes-backup.json');
        parsed=JSON.parse(await stateFile.async('string'));
        const historyFile=zip.file('history.json');
        if(historyFile) history=JSON.parse(await historyFile.async('string'));
        const rawState=parsed.state||parsed;
        for(const note of (rawState.notes||[])){
          for(const name of (note.attachments||[])){
            const entry=zip.file(`attachments/${note.id}/${name}`);
            if(entry) await putAttachment(note.id,name,await entry.async('blob'));
          }
        }
      }else{
        parsed=JSON.parse(await file.text());
        history=Array.isArray(parsed.history)?parsed.history:[];
      }
      const rawState=parsed.state||parsed;
      if(!Array.isArray(rawState.notes)||!Array.isArray(rawState.folders)) throw new Error('Invalid backup');
      state=normalizeState(rawState);
      selectedId=state.selectedId||state.notes[0]?.id||null;
      for(const snap of history){ if(snap?.id&&snap?.noteId) await putHistorySnapshot(snap); }
      applyWritingPreferences(); persist(); renderAll(); toast('Backup imported');
    }catch{ toast('That backup could not be read'); }
  }

  function openFolderDialog(){ els.folderNameInput.value=''; els.folderDialog.showModal(); setTimeout(()=>els.folderNameInput.focus(),20); }
  function saveFolder(){ flushPendingSave(); const name=els.folderNameInput.value.trim(); if(!name)return; state.folders.push({id:id('f'),name}); persist(); els.folderDialog.close(); renderAll(); }

  function escapeHtml(s=''){ return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  function openDB(){ return new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(ATT_STORE)) db.createObjectStore(ATT_STORE);
      if(!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if(!db.objectStoreNames.contains(HISTORY_STORE)){
        const store=db.createObjectStore(HISTORY_STORE,{keyPath:'id'});
        store.createIndex('noteId','noteId',{unique:false});
      }
    };
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  }); }
  async function saveStateMirror(value){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STATE_STORE,'readwrite');
      tx.objectStore(STATE_STORE).put(typeof structuredClone==='function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)),'latest');
      tx.oncomplete=()=>{db.close();res();}; tx.onerror=()=>{db.close();rej(tx.error);};
    });
  }
  async function loadStateMirror(){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STATE_STORE,'readonly');
      const r=tx.objectStore(STATE_STORE).get('latest');
      r.onsuccess=()=>{db.close();res(r.result||null);}; r.onerror=()=>{db.close();rej(r.error);};
    });
  }
  async function putAttachment(noteId,name,blob){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(ATT_STORE,'readwrite'); tx.objectStore(ATT_STORE).put(blob,`${noteId}/${name}`); tx.oncomplete=()=>{db.close();res();}; tx.onerror=()=>rej(tx.error); }); }
  async function getAttachment(noteId,name){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(ATT_STORE,'readonly'); const r=tx.objectStore(ATT_STORE).get(`${noteId}/${name}`); r.onsuccess=()=>{db.close();res(r.result||null);}; r.onerror=()=>rej(r.error); }); }
  async function deleteAttachments(note){ if(!(note.attachments||[]).length)return; const db=await openDB(); await new Promise((res,rej)=>{ const tx=db.transaction(ATT_STORE,'readwrite'); const s=tx.objectStore(ATT_STORE); note.attachments.forEach(name=>s.delete(`${note.id}/${name}`)); tx.oncomplete=()=>{db.close();res();}; tx.onerror=()=>rej(tx.error); }); }

  if(!cmEditor){
    els.editor.addEventListener('input',()=>{capturePreEditVersion();scheduleSave();});
    els.editor.addEventListener('keydown',e=>{ if(continueMarkdownListTextarea(e)) return; if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='b'){e.preventDefault();replaceSelection('**','**',null);} if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='i'){e.preventDefault();replaceSelection('*','*',null);} });
  }
  els.noteTitle.addEventListener('input',()=>{
    const n=currentNote(); if(!n)return;
    n.customTitle=els.noteTitle.value;
    n.updated=now();
    persist();
    queueAutoSnapshot(n);
    renderNotesList();
  });
  els.noteTitle.addEventListener('blur',()=>{
    const n=currentNote(); if(!n)return;
    if(!els.noteTitle.value.trim()){
      n.customTitle=null;
      els.noteTitle.value=deriveTitle(n.body);
      n.updated=now();
      persist();
      queueAutoSnapshot(n);
      renderNotesList();
    }
  });
  els.noteTitle.addEventListener('keydown',e=>{
    if(e.key==='Enter'){ e.preventDefault(); els.noteTitle.blur(); focusEditor(); }
    if(e.key==='Escape'){ e.preventDefault(); els.noteTitle.value=displayTitle(currentNote()); els.noteTitle.blur(); }
  });
  els.tagsInput.addEventListener('change',()=>{ const n=currentNote(); if(!n)return; n.tags=dedupeTags(els.tagsInput.value.split(',')); cleanTagOrganization(); els.tagsInput.value=n.tags.join(', '); n.updated=now(); persist(); queueAutoSnapshot(n); if(currentTag && !(n.tags||[]).some(t=>tagKey(t)===tagKey(currentTag))){ const remaining=notesWithTag(currentTag); if(remaining.length) selectedId=remaining[0].id; else { currentTag=null; currentView='inbox'; currentFolder=null; } renderAll(); return; } renderSidebar(); renderNotesList(); });
  els.folderSelect.addEventListener('change',()=>{ flushPendingSave(); const n=currentNote(); if(!n)return; moveNoteToFolder(n,els.folderSelect.value||null); persist(); renderAll(); });
  els.toolbar.addEventListener('click',e=>{ const b=e.target.closest('button[data-action]'); if(b) toolbarAction(b.dataset.action); });
  els.imageInput.addEventListener('change',()=>{ handleImage(els.imageInput.files?.[0]); els.imageInput.value=''; });
  els.writingSettingsBtn.addEventListener('click',openWritingSettings);
  els.fontSelect.addEventListener('change',saveWritingPreference);
  els.fontSizeSelect.addEventListener('change',saveWritingPreference);
  els.previewBtn.addEventListener('click',togglePreview); els.reorderBtn.addEventListener('click',()=>reorderMode?finishReorder():enterReorder()); els.reorderDone.addEventListener('click',finishReorder);
  els.newNoteBtn.addEventListener('click',newNote); els.newNoteMobile.addEventListener('click',newNote); els.sidebarOpen.addEventListener('click',openSidebar); els.sidebarClose.addEventListener('click',closeSidebar); els.scrim.addEventListener('click',closeSidebar);
  els.searchInput.addEventListener('input',renderNotesList);
  els.sortSelect?.addEventListener('change',()=>{
    const key=viewLocationKey();
    const previous=currentSortPreference();
    const next=els.sortSelect.value;
    if(next==='manual' && !Array.isArray(state.manualOrders?.[key])){
      const snapshot=sortNotes(notesForCurrentView(false),previous,key);
      ensureManualOrder(key,snapshot);
    }
    state.sortPrefs ||= {};
    state.sortPrefs[key]=next;
    persist();
    renderNotesList();
  });
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>{flushPendingSave();currentTag=null;currentFolder=null;currentView=b.dataset.view;els.searchInput.value='';renderAll();closeSidebar();}));
  els.addFolderBtn.addEventListener('click',openFolderDialog); els.folderSaveBtn.addEventListener('click',e=>{e.preventDefault();saveFolder();}); els.folderNameInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveFolder();}});
  els.tagsToggleBtn?.addEventListener('click',()=>{
    state.ui ||= {tagsCollapsed:false};
    state.ui.tagsCollapsed=!state.ui.tagsCollapsed;
    persist();
    renderSidebar();
  });
  els.tagSortSelect?.addEventListener('change',()=>{
    state.tagSettings ||= {sort:'az'};
    state.tagSettings.sort=els.tagSortSelect.value==='manual'?'manual':'az';
    if(state.tagSettings.sort==='manual') ensureTagManualOrders();
    persist(); renderSidebar();
  });
  const promptNewTagGroup=()=>{
    const name=prompt('New tag group name:',''); if(name===null) return;
    const group=addTagGroup(name); if(group) toast(`Created ${group.name}`);
  };
  els.addTagGroupBtn?.addEventListener('click',promptNewTagGroup);
  els.tagManagerNewGroupBtn?.addEventListener('click',promptNewTagGroup);
  els.manageTagsBtn?.addEventListener('click',openTagManager); els.tagManagerCloseBtn?.addEventListener('click',()=>els.tagManagerDialog.close()); els.tagManagerCloseX?.addEventListener('click',()=>els.tagManagerDialog.close());
  els.pinBtn.addEventListener('click',()=>{flushPendingSave();const n=currentNote();if(!n||n.trashed)return;n.pinned=!n.pinned;n.updated=now();persist();queueAutoSnapshot(n);renderAll();});
  els.archiveBtn.addEventListener('click',async()=>{
    flushPendingSave();
    const n=currentNote(); if(!n)return;
    if(n.trashed){
      n.trashed=false; n.deletedAt=null; n.archived=!!n.preTrashArchived; delete n.preTrashArchived; n.updated=now();
      persist(); await createSnapshot(n,'Restored from Trash',true);
      if(n.archived){ currentView='archived'; currentFolder=null; } else if(n.folderId){ currentView='folder'; currentFolder=n.folderId; } else { currentView='inbox'; currentFolder=null; }
      renderAll(); toast('Restored from Trash'); return;
    }
    n.archived=!n.archived; n.updated=now(); persist(); queueAutoSnapshot(n); currentView=n.archived?'archived':'inbox'; currentFolder=null; renderAll();
  });
  els.deleteBtn.addEventListener('click',async()=>{
    flushPendingSave();
    const n=currentNote(); if(!n)return;
    if(!n.trashed){
      await createSnapshot(n,'Before Trash',true);
      n.preTrashArchived=!!n.archived; n.trashed=true; n.deletedAt=now(); n.updated=now(); persist();
      currentView='trash'; currentFolder=null; renderAll(); toast('Moved to Trash'); return;
    }
    if(!confirm(`Permanently delete “${displayTitle(n)}”? This removes the note, its images, and its local version history.`))return;
    clearTimeout(autoSnapshotTimers.get(n.id)); autoSnapshotTimers.delete(n.id); permanentlyDeletedNoteIds.add(n.id);
    await deleteAttachments(n); try{await deleteHistoryForNote(n.id);}catch{} state.notes=state.notes.filter(x=>x.id!==n.id);
    const remaining=state.notes.filter(x=>x.trashed); selectedId=remaining[0]?.id||state.notes.find(x=>!x.trashed)?.id||null;
    if(!remaining.length){ currentView='inbox'; currentFolder=null; }
    persist(); renderAll(); toast('Permanently deleted');
  });
  els.historyBtn.addEventListener('click',openHistory); els.saveVersionBtn.addEventListener('click',saveVersionNow); els.historyPreviewClose.addEventListener('click',()=>{els.historyPreview.hidden=true;els.historyList.hidden=false;}); els.historyCloseBtn.addEventListener('click',()=>els.historyDialog.close()); els.historyCloseX.addEventListener('click',()=>els.historyDialog.close());
  els.shareBtn.addEventListener('click',shareCurrent); els.downloadBtn.addEventListener('click',downloadCurrent); els.backupBtn.addEventListener('click',exportBackup); els.restoreBtn.addEventListener('click',()=>els.restoreInput.click()); els.restoreInput.addEventListener('change',()=>{if(els.restoreInput.files?.[0])importBackup(els.restoreInput.files[0]);els.restoreInput.value='';});
  window.addEventListener('keydown',e=>{
    const target=e.target;
    const typing=target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
    const dialogOpen=!!document.querySelector('dialog[open]');
    if(!typing && !dialogOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase()==='q'){
      e.preventDefault();
      newNote();
      return;
    }
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='n'){e.preventDefault();newNote();}
    if(e.key==='Escape'&&els.sidebar.classList.contains('open'))closeSidebar();
  });
  window.addEventListener('beforeunload',()=>{ flushPendingSave(); releaseObjectUrls(); });

  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});

  async function initializeApp(){
    requestPersistentStorage();
    try{
      const mirror=await loadStateMirror();
      const mirrorValid=mirror && Array.isArray(mirror.notes) && Array.isArray(mirror.folders);
      const mirrorIsNewer=mirrorValid && new Date(mirror.savedAt||0).getTime()>new Date(state.savedAt||0).getTime();
      if(mirrorValid && (!localStateValid || mirrorIsNewer)){
        state=normalizeState(mirror); selectedId=state.selectedId||state.notes[0]?.id||null;
        try{ localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); localStateValid=true; }catch{}
        toast('Recovered notes from local recovery copy');
      }
    }catch{}
    applyWritingPreferences();
    if(!selectedId && state.notes.length) selectedId=state.notes[0].id;
    if(!state.notes.length) newNote(); else { renderAll(); scheduleStateMirror(); }
  }
  initializeApp();
})();
