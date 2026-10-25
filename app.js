/* СЕЙФ 1.6 — local-only experimental password vault. No network requests or analytics. */
'use strict';
(() => {
  const root = document.getElementById('app');
  const toastArea = document.getElementById('toast-container');
  const DB_NAME = 'seif-vault-local-v1';
  const STORE = 'vault';
  const FILE_KEY = 'primary';
  const KDF_ROUNDS = 600000;
  const MAX_IMAGE_DATA_CHARS = 500000; // Encoded image remains inside encrypted vault.
  const AUTOLOCK_MS = 15 * 60 * 1000; // Idle lock remains independent of background grace.
  const BG_SETTINGS_KEY = 'seif-ui-bg-lock-delay-v1'; // NONSECRET preference only. Never store passwords here.
  const FACE_WRAP_KEY = 'seif-ui-face-prf-v1'; // PRF-encrypted vault key, never plaintext
  const SOUND_SETTINGS_KEY = 'seif-ui-tap-sound-v1'; // non-secret preference, no network/audio files.
  let tapSoundEnabled = true;
  try { tapSoundEnabled = localStorage.getItem(SOUND_SETTINGS_KEY) !== 'off'; } catch {}
  let tapSoundContext = null;
  let lastTapSoundAt = 0;
  // Gentle synthesized "glass click". Audio starts only on an intentional user tap.
  // Sound generation never reads passwords, contacts services, or persists audio data.
  function playTapSound(style='card') {
    if(!tapSoundEnabled || phase !== 'unlocked') return;
    const now=Date.now(); if(now-lastTapSoundAt<65) return;
    lastTapSoundAt=now;
    try {
      const AC=window.AudioContext || window.webkitAudioContext;
      if(!AC)return; // Browser does not support Web Audio; functional UI remains unaffected.
      if(!tapSoundContext)tapSoundContext=new AC();
      const ctx=tapSoundContext;
      if(ctx.state==='suspended')ctx.resume().catch(()=>{});
      const time=ctx.currentTime+0.003;
      const freq=style==='reveal'?790:1070;
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type='sine';
      osc.frequency.setValueAtTime(freq,time);
      osc.frequency.exponentialRampToValueAtTime(freq*.54,time+.06);
      gain.gain.setValueAtTime(0.0001,time);
      gain.gain.exponentialRampToValueAtTime(.065,time+.006);
      gain.gain.exponentialRampToValueAtTime(0.0001,time+.083);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(time);osc.stop(time+.088);
      osc.onended=()=>{try{osc.disconnect();gain.disconnect();}catch{}};
    } catch { /* Sound must never interrupt the vault or block tapping. */ }
  }
  // Capture before application navigation replaces the pressed button.
  document.addEventListener('click', (ev)=>{
    const target=ev.target;
    if(!(target instanceof Element))return;
    if(target.closest('[data-seif-sound="reveal"]')){playTapSound('reveal');return;}
    if(target.closest('.daily-story-card, .cash-card, .daily-favorite-card, .tile, .loyalty-preset.has-card'))playTapSound('card');
  },true);
  const VALID_BG_DELAYS = [60,300,900];
  function readBackgroundSeconds(){
    try {const n=Number(localStorage.getItem(BG_SETTINGS_KEY));return VALID_BG_DELAYS.includes(n)?n:900;}
    catch {return 10;}
  }
  let bgLockSeconds=readBackgroundSeconds();
  let backgroundAt=null;
  let backgroundTimeout=null;
  let privacyCurtain=null;
  // iOS briefly backgrounds PWAs when opening the system photo picker. Treat the
  // picker as a deliberate foreground flow, not as switching to another app.
  // An absolute cap prevents indefinite unlock while the chooser is open.
  const MEDIA_PICKER_MAX_MS = 120000;
  let photoPickerStartedAt=0;
  let photoPickerTimer=null;
  let photoPickerCleanupTimer=null;
  function releasePhotoPicker(){
    photoPickerStartedAt=0;
    if(photoPickerTimer){clearTimeout(photoPickerTimer);photoPickerTimer=null;}
    if(photoPickerCleanupTimer){clearTimeout(photoPickerCleanupTimer);photoPickerCleanupTimer=null;}
  }
  function startPhotoPicker(){
    releasePhotoPicker();
    if(phase!=='unlocked')return;
    photoPickerStartedAt=Date.now();
    photoPickerTimer=setTimeout(()=>{
      if(photoPickerStartedAt && phase==='unlocked'){
        releasePhotoPicker();
        lock(false);
      }
    },MEDIA_PICKER_MAX_MS);
  }
  function finishPhotoPicker(){
    if(!photoPickerStartedAt)return;
    const overLimit=Date.now()-photoPickerStartedAt>=MEDIA_PICKER_MAX_MS;
    releasePhotoPicker();
    if(overLimit){if(phase==='unlocked')lock();return;}
    if(phase==='unlocked'){
      backgroundAt=null;
      if(backgroundTimeout){clearTimeout(backgroundTimeout);backgroundTimeout=null;}
      lastActivity=Date.now();
      if(!document.hidden)uncoverPrivateView();
    }
  }
  const temporaryImageURLs=new Set();
  function revokeImageURL(url){try{URL.revokeObjectURL(url);}catch{}temporaryImageURLs.delete(url);}

  const encode = new TextEncoder();
  const decode = new TextDecoder();
  const SVC = [
    ['instagram','Instagram','IG','ig'], ['gosuslugi','Госуслуги','ГУ','gos'],
    ['fns','ФНС / Налоги','₽','fns'], ['tiktok','TikTok','♪','tiktok'],
    ['sber','Сбербанк','С','sber'], ['vtb','ВТБ','В','vtb'],
    ['telegram','Telegram','➤','tg'], ['vk','ВКонтакте','VK','vk'],
    ['yandex','Яндекс','Я','ya'], ['google','Google','G','google'],
    ['apple','Apple','●','apple'], ['mail','Mail.ru','@','mail'],
    ['tbank','Т-Банк','Т','tbank'], ['ozon','Ozon','O','ozon'],
    ['wb','Wildberries','W','wb'], ['whatsapp','WhatsApp','☎','wa'],
    ['ms','Microsoft','⊞','ms'], ['other','Другое','＋','other']
  ];
  // Recognisable local colour tiles; no downloads or calls to retailer APIs.
  const LOYALTY_BRANDS = [
    ['magnit','Магнит','М','https://magnit.ru/'],
    ['pyaterochka','Пятёрочка','5','https://5ka.ru/'],
    ['perekrestok','Перекрёсток','П','https://www.perekrestok.ru/'],
    ['lenta','Лента','Л','https://lenta.com/'],
    ['vkusvill','ВкусВилл','В','https://vkusvill.ru/'],
    ['diksi','Дикси','Д','https://dixy.ru/'],
    ['fixprice','Fix Price','F','https://fix-price.com/'],
    ['auchan','Ашан','А','https://www.auchan.ru/'],
    ['metro','METRO','M','https://www.metro-cc.ru/'],
    ['okey','О’КЕЙ','О','https://www.okmarket.ru/'],
    ['sportmaster','Спортмастер','С','https://www.sportmaster.ru/'],
    ['goldapple','Золотое Яблоко','Я','https://goldapple.ru/'],
    ['azbuka','Азбука вкуса','А','https://av.ru/'],
    ['tsum','ЦУМ','Ц','https://www.tsum.ru/'],
    ['podruzhka','Подружка','П','https://www.podrygka.ru/'],
    ['rivegauche','РИВ ГОШ','Р','https://rivegauche.ru/'],
    ['other','Другая карта','+','']
  ];
  function loyaltyBrand(item){
    const id=(item.brandId||'').toLowerCase();
    return LOYALTY_BRANDS.find(x=>x[0]===id)||LOYALTY_BRANDS.find(x=>x[1].toLowerCase()===(item.brand||'').toLowerCase())||LOYALTY_BRANDS.at(-1);
  }
  function loyaltyTile(item,large=false){
    const found=loyaltyBrand(item);return h('div','loyalty-icon loyalty-'+found[0]+(large?' loyalty-big':''),found[2]);
  }
  function approvedStoreUrl(s){try{const u=new URL(s);return ['https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
  let dbPromise;
  let phase = 'loading';
  let setupStep = 'profile';
  let setupProfile = 'neutral';
  let view = 'home';
  let key = null;
  let entries = [];
  const freshExtras = () => ({cards:[], subscriptions:[], reminders:[], documents:[], notes:[], otps:[], expenses:[], rhythmCycles:[], rhythmMood:[], rhythmReminders:[], rhythmCare:[], rhythmPlans:[], rhythmWardrobe:[], rhythmProfile:[]});
  let extras = freshExtras();
  let salt = null;
  let iterationCount = KDF_ROUNDS;
  let vaultFile = null;
  let busySave = false;
  let sessionEpoch = 0; // invalidates async unlock/import operations after a lock/hide
  let lastActivity = Date.now();
  let activeEditorDraft = null;
  let preselectedBrand = null;
  let lastToastTimeout;

  function h(tag, css, txt) {
    const n = document.createElement(tag);
    if (css) n.className = css;
    if (txt !== undefined && txt !== null) n.textContent = String(txt);
    return n;
  }
  function append(node, ...children) { for (const child of children) if (child) node.append(child); return node; }
  function textEl(tag, css, text) { return h(tag, css, text); }
  function btn(label, css, onClick, type='button') {
    const b = h('button', 'btn ' + (css||''), label); b.type = type;
    if (onClick) b.addEventListener('click', onClick); return b;
  }
  function iconButton(glyph, title, onClick) {
    const b = h('button','icon-btn',glyph); b.type='button'; b.title=title; b.setAttribute('aria-label',title);
    b.addEventListener('click',onClick); return b;
  }
  function input(placeholder='',type='text',value='') {
    const x = h('input','field-input'); x.type=type; x.placeholder=placeholder; x.value=value;
    if (type === 'password') { x.autocomplete='off'; x.spellcheck=false; }
    return x;
  }
  function field(label, control, wide=false) {
    const f=h('label','field'+(wide?' wide':'')); append(f,h('span','field-label',label),control); return f;
  }
  function sectionTitle(txt,extra) {return append(h('div','section-title'),h('span','',txt),extra||null);}
  function serviceInfo(id) { return SVC.find(s=>s[0]===id)||SVC[SVC.length-1]; }
  function serviceIcon(id,large=false) {
    const s=serviceInfo(id);
    return h('div', 'svc svc-'+s[3]+(large?' svc-lg':''),s[2]);
  }
  function idNew() {return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), x=>x.toString(16).padStart(2,'0')).join('');}
  function fmtBytes(bytes){
    let out=''; const part=8192;
    for(let i=0;i<bytes.length;i+=part)out+=String.fromCharCode(...bytes.subarray(i,i+part));
    return btoa(out);
  }
  function readBytes(s){
    if (typeof s!=='string'||s.length>25000000||!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error('Некорректное содержимое резервной копии');
    const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0));
  }
  function randBytes(n){return crypto.getRandomValues(new Uint8Array(n));}
  async function deriveBits(password,slt,rounds=KDF_ROUNDS){
    const material=await crypto.subtle.importKey('raw',encode.encode(password),'PBKDF2',false,['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:slt,iterations:rounds,hash:'SHA-256'},material,256));
  }
  async function importVaultKey(raw){return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);}
  async function derive(password,slt,rounds=KDF_ROUNDS){return importVaultKey(await deriveBits(password,slt,rounds));}
  function faceRecord(){try{const data=JSON.parse(localStorage.getItem(FACE_WRAP_KEY)||'null');return data?.version===1?data:null;}catch{return null;}}
  function forgetFace(){try{localStorage.removeItem(FACE_WRAP_KEY);}catch{}}
  function faceAvailable(){return !!(window.PublicKeyCredential&&navigator.credentials?.create&&navigator.credentials?.get&&window.isSecureContext);}
  async function faceAssertion(record){
    const result=await navigator.credentials.get({publicKey:{
      challenge:randBytes(32),allowCredentials:[{type:'public-key',id:readBytes(record.credentialId)}],
      userVerification:'required',timeout:60000,
      extensions:{prf:{eval:{first:readBytes(record.prfSalt)}}}
    }});
    const prf=result?.getClientExtensionResults?.()?.prf?.results?.first;
    if(!prf||prf.byteLength!==32)throw Error('Этот iPhone или браузер не предоставил защищённый ключ Face ID (WebAuthn PRF).');
    return new Uint8Array(prf);
  }
  async function enrollFace(password){
    if(!faceAvailable())throw Error('Для Face ID нужен совместимый браузер с WebAuthn по HTTPS.');
    const ticket=sessionEpoch;
    const bits=await deriveBits(password,salt,iterationCount);
    try{
      const candidate=await importVaultKey(bits);
      await decryptVault(vaultFile,candidate); // Verify master password BEFORE creating credential.
      const prfSalt=randBytes(32);
      const credential=await navigator.credentials.create({publicKey:{
        challenge:randBytes(32),rp:{name:'СЕЙФ'},
        user:{id:randBytes(24),name:'local-seif-user',displayName:'СЕЙФ на этом устройстве'},
        pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],timeout:60000,
        authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'preferred',userVerification:'required'},
        attestation:'none',extensions:{prf:{eval:{first:prfSalt}}}
      }});
      if(!credential?.rawId||!credential.getClientExtensionResults?.()?.prf?.enabled)
        throw Error('Face ID для защиты ключа пока не поддерживается этим браузером. Мастер-пароль остаётся доступен.');
      const provisional={version:1,credentialId:fmtBytes(new Uint8Array(credential.rawId)),prfSalt:fmtBytes(prfSalt)};
      const prf=await faceAssertion(provisional);
      const wrapKey=await crypto.subtle.importKey('raw',prf,{name:'AES-GCM'},false,['encrypt']);
      const iv=randBytes(12);
      const wrapped=await crypto.subtle.encrypt({name:'AES-GCM',iv},wrapKey,bits);
      if(ticket!==sessionEpoch||phase!=='unlocked')throw Error('Сейф заблокировался. Попробуйте снова.');
      const record={...provisional,salt:fmtBytes(salt),iv:fmtBytes(iv),wrapped:fmtBytes(new Uint8Array(wrapped))};
      localStorage.setItem(FACE_WRAP_KEY,JSON.stringify(record));
      return true;
    }finally{bits.fill(0);}
  }
  async function unlockFace(){
    const record=faceRecord();if(!record)throw Error('Face ID ещё не настроен. Откройте сейф мастер-паролем.');
    if(!faceAvailable())throw Error('Face ID недоступен в этом браузере. Введите мастер-пароль.');
    const ticket=sessionEpoch;
    const json=await dbGet();if(!json)throw Error('Сейф не найден');
    const file=validateEnvelope(JSON.parse(json));
    if(record.salt!==file.salt)throw Error('Сейф изменился. Откройте мастер-паролем и настройте Face ID заново.');
    const prf=await faceAssertion(record);
    const wrapKey=await crypto.subtle.importKey('raw',prf,{name:'AES-GCM'},false,['decrypt']);
    const bits=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:readBytes(record.iv)},wrapKey,readBytes(record.wrapped)));
    try{
      const localKey=await importVaultKey(bits);
      const items=await decryptVault(file,localKey);
      if(ticket!==sessionEpoch)return;
      key=localKey;salt=readBytes(file.salt);iterationCount=file.iterations;entries=items.entries;extras=items.extras;vaultFile=file;phase='unlocked';view='dashboard';lastActivity=Date.now();render();
    }finally{bits.fill(0);}
  }
  async function encryptVault(items, cryptoKey, slt,rounds, other=freshExtras()) {
    const iv=randBytes(12);
    const payload=encode.encode(JSON.stringify({version:2,entries:items,...other}));
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,tagLength:128},cryptoKey,payload);
    return {format:'SEIF_ENCRYPTED_VAULT',version:1,kdf:'PBKDF2-SHA256',iterations:rounds,algorithm:'AES-256-GCM',salt:fmtBytes(slt),iv:fmtBytes(iv),ciphertext:fmtBytes(new Uint8Array(encrypted))};
  }
  function validateEnvelope(obj){
    if (!obj || typeof obj!=='object'||Array.isArray(obj)||obj.format!=='SEIF_ENCRYPTED_VAULT'||obj.version!==1||obj.kdf!=='PBKDF2-SHA256'||obj.algorithm!=='AES-256-GCM')throw new Error('Формат файла не поддерживается');
    if (!Number.isInteger(obj.iterations)||obj.iterations<600000||obj.iterations>5000000)throw new Error('Неверные параметры защиты');
    if (readBytes(obj.salt).length!==16||readBytes(obj.iv).length!==12||readBytes(obj.ciphertext).length<16)throw new Error('Резервная копия повреждена');
    return {format:obj.format,version:obj.version,kdf:obj.kdf,iterations:obj.iterations,algorithm:obj.algorithm,salt:obj.salt,iv:obj.iv,ciphertext:obj.ciphertext};
  }
  async function decryptVault(file,cryptoKey) {
    validateEnvelope(file);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:readBytes(file.iv),tagLength:128},cryptoKey,readBytes(file.ciphertext));
    const obj=JSON.parse(decode.decode(plain));
    if (!obj||(obj.version!==1&&obj.version!==2)||!Array.isArray(obj.entries)||obj.entries.length>10000)throw new Error('Файл содержит неподдерживаемые данные');
    const clean=obj.entries.map(x=>{
      if(!x||typeof x!=='object'||typeof x.id!=='string'||typeof x.serviceId!=='string'||typeof x.login!=='string'||typeof x.password!=='string')throw new Error('Повреждена запись');
      return {id:x.id.slice(0,100),serviceId:x.serviceId.slice(0,100),name:String(x.name||'').slice(0,200),account:String(x.account||'').slice(0,200),login:x.login.slice(0,500),password:x.password.slice(0,2000),url:String(x.url||'').slice(0,500),note:String(x.note||'').slice(0,3000),favorite:!!x.favorite,createdAt:Number(x.createdAt)||Date.now(),updatedAt:Number(x.updatedAt)||Date.now()};
    });
    const other=freshExtras();
    for (const collection of Object.keys(other)) {
      const list=obj[collection];
      if (list===undefined)continue;
      if(!Array.isArray(list)||list.length>(collection==='expenses'?10000:collection==='rhythmWardrobe'?250:2000))throw new Error('Неверные данные раздела: '+collection);
      other[collection]=list.map(item=>{
        if(!item || typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||item.id.length>120)throw new Error('Повреждён элемент раздела '+collection);
        const record={};
        for(const [k,v] of Object.entries(item)){
          if(!/^[a-zA-Z]{1,30}$/.test(k))continue;
          if(typeof v==='string'){if(k==='imageData'){if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)&&v.length<=MAX_IMAGE_DATA_CHARS)record[k]=v;}else record[k]=v.slice(0,k==='body'?15000:3000);}
          else if(typeof v==='number'&&Number.isFinite(v))record[k]=v;
          else if(typeof v==='boolean')record[k]=v;
        }
        return record;
      });
    }
    return {entries:clean,extras:other};
  }
  function openDB(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||new Error('Не удалось открыть хранилище'));
      req.onblocked=()=>reject(new Error('Хранилище заблокировано другой вкладкой'));
    });
    return dbPromise;
  }
  async function dbGet(){const db=await openDB();return new Promise((resolve,reject)=>{
    const tr=db.transaction(STORE,'readonly');const req=tr.objectStore(STORE).get(FILE_KEY);
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
  });}
  async function dbPut(data){const db=await openDB();return new Promise((resolve,reject)=>{
    const tr=db.transaction(STORE,'readwrite');tr.objectStore(STORE).put(data,FILE_KEY);
    tr.oncomplete=()=>resolve();tr.onerror=()=>reject(tr.error||new Error('Ошибка сохранения'));tr.onabort=()=>reject(tr.error||new Error('Запись отменена'));
  });}
  async function dbDel(){const db=await openDB();return new Promise((resolve,reject)=>{
    const tr=db.transaction(STORE,'readwrite');tr.objectStore(STORE).delete(FILE_KEY);
    tr.oncomplete=()=>resolve();tr.onerror=()=>reject(tr.error||new Error('Ошибка удаления'));
  });}
  function toast(msg,isError=false){
    const t=h('div','toast'+(isError?' err':''),msg);toastArea.replaceChildren(t);
    if(lastToastTimeout)clearTimeout(lastToastTimeout);
    lastToastTimeout=setTimeout(()=>{if(t.parentNode)t.remove();},3700);
  }
  function forget(){ resetExpenseState();releasePhotoPicker();stopOtp();for(const url of temporaryImageURLs)revokeImageURL(url);key=null;entries=[];extras=freshExtras();salt=null;activeEditorDraft=null;vaultFile=null; }
  function coverPrivateView(){
    if(privacyCurtain) return;
    privacyCurtain=h('div','privacy-curtain');privacyCurtain.setAttribute('aria-label','Сейф скрыт');
    append(privacyCurtain,shieldSvg(),h('strong','','СЕЙФ'),h('p','','Содержимое скрыто'));
    document.body.append(privacyCurtain);
  }
  function uncoverPrivateView(){if(privacyCurtain){privacyCurtain.remove();privacyCurtain=null;}}
  function lock(showNotice=false){
    if(phase!=='unlocked')return;
    sessionEpoch++;
    backgroundAt=null;
    if(backgroundTimeout){clearTimeout(backgroundTimeout);backgroundTimeout=null;}
    document.querySelectorAll('.modal-backdrop').forEach(x=>x.remove());
    forget();phase='locked';view='home';root.replaceChildren();render();
    if(!document.hidden)uncoverPrivateView();
    if(showNotice)toast('Сейф заблокирован');
  }
  function tickActivity(){if(phase==='unlocked'&&!document.hidden&&backgroundAt===null)lastActivity=Date.now();}
  ['pointerdown','keydown','touchstart','scroll'].forEach(name=>document.addEventListener(name,tickActivity,{passive:true}));
  function markBackground(){
    if(backgroundAt!==null)return;
    backgroundAt=Date.now();
    if(phase==='unlocked'){
      coverPrivateView();
      // Timer is only an optimization. On resume we compare absolute timestamps,
      // because iOS can suspend background JavaScript timers entirely.
      if(!photoPickerStartedAt)backgroundTimeout=setTimeout(()=>{
        if(backgroundAt!==null&&Date.now()-backgroundAt>=bgLockSeconds*1000)lock(false);
      },bgLockSeconds*1000+50);
    }else if(phase==='locked'||phase==='setup')render();
  }
  function resumeForeground(){
    if(document.hidden)return;
    const elapsed=backgroundAt===null?0:Date.now()-backgroundAt;
    const hasPicker=Boolean(photoPickerStartedAt);
    const expiredPicker=hasPicker&&Date.now()-photoPickerStartedAt>=MEDIA_PICKER_MAX_MS;
    backgroundAt=null;
    if(backgroundTimeout){clearTimeout(backgroundTimeout);backgroundTimeout=null;}
    if(phase==='unlocked'&&(
        expiredPicker||(!hasPicker&&(elapsed>=bgLockSeconds*1000||Date.now()-lastActivity>=AUTOLOCK_MS))
    ))lock(false);
    else if(phase==='unlocked'&&hasPicker){
      // Some iOS versions dispatch focus/pageshow before the input.change event;
      // allow that event to complete, then reset the exemption on cancel.
      lastActivity=Date.now();
      if(photoPickerCleanupTimer)clearTimeout(photoPickerCleanupTimer);
      photoPickerCleanupTimer=setTimeout(()=>{
        if(!document.hidden && photoPickerStartedAt)finishPhotoPicker();
      },1700);
    }
    uncoverPrivateView();
    if(phase==='locked'||phase==='setup')render();
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)markBackground();else resumeForeground();
  });
  window.addEventListener('pagehide',markBackground);
  window.addEventListener('pageshow',resumeForeground);
  window.addEventListener('blur',()=>{
    // iOS incoming calls and app switching can blur before visibilitychange.
    if(phase==='unlocked'&&!document.hidden)markBackground();
  });
  window.addEventListener('focus',resumeForeground);
  setInterval(()=>{if(phase==='unlocked'&&Date.now()-lastActivity>=AUTOLOCK_MS)lock(true);},1000);
  async function commit(newEntries, newExtras=extras){
    if(busySave||phase!=='unlocked'||!key||!salt){toast('Сейф заблокирован или выполняется сохранение',true);return false;}
    const capturedKey=key;const capturedEpoch=sessionEpoch;busySave=true;
    try{
      const encrypted=await encryptVault(newEntries,capturedKey,salt,iterationCount,newExtras);
      if(capturedEpoch!==sessionEpoch||key!==capturedKey||phase!=='unlocked')return false;
      await dbPut(JSON.stringify(encrypted));
      if(capturedEpoch===sessionEpoch&&key===capturedKey&&phase==='unlocked'){
        entries=newEntries;extras=newExtras;vaultFile=encrypted;
        toast('Сохранено в зашифрованном виде');return true;
      }
      return false;
    }catch(_err){toast('Не удалось сохранить. Запись не изменена.',true);return false;}
    finally{busySave=false;}
  }
  async function create(password){
    const ticket=sessionEpoch;
    const localSalt=randBytes(16);
    const localKey=await derive(password,localSalt);
    const initialExtras={...freshExtras(),rhythmProfile:[{id:'profile',mode:setupProfile,createdAt:Date.now()}]};
    const encrypted=await encryptVault([],localKey,localSalt,KDF_ROUNDS,initialExtras);
    if(ticket!==sessionEpoch)return;
    await dbPut(JSON.stringify(encrypted));
    if(ticket!==sessionEpoch)return;
    phase='unlocked';key=localKey;salt=localSalt;iterationCount=KDF_ROUNDS;entries=[];extras=initialExtras;vaultFile=encrypted;lastActivity=Date.now();view='dashboard';render();
  }
  async function unlock(password){
    const ticket=sessionEpoch;
    const json=await dbGet();if(!json)throw new Error('Сейф не найден');
    const file=validateEnvelope(JSON.parse(json));
    const localSalt=readBytes(file.salt);
    const localKey=await derive(password,localSalt,file.iterations);
    const items=await decryptVault(file,localKey);
    if(ticket!==sessionEpoch)return;
    key=localKey;salt=localSalt;iterationCount=file.iterations;entries=items.entries;extras=items.extras;vaultFile=file;phase='unlocked';view='dashboard';lastActivity=Date.now();render();
  }
  function render(){root.replaceChildren();if(phase==='loading'){root.append(h('div','loading','Открываем сейф…'));return;}
    if(phase==='error'){renderError();return;}
    if(phase==='setup'||phase==='locked')renderAuth();
    else if(phase==='unlocked'){
      if(view==='home')renderHome();
      else if(view==='new'||view.startsWith('edit:'))renderEditor();
      else if(view.startsWith('detail:'))renderDetail();
      else if(view==='settings')renderSettings();
      else if(view==='dashboard')renderDashboard();
      else if(view==='expenses')renderExpenses();
      else if(view==='rhythm')renderRhythm();
      else if(view==='life')renderLife();
      else if(view.startsWith('rhythm:'))renderRhythmSection(view.slice(7));
      else if(view==='favorites')renderFavoriteManager();
      else if(view==='cards')renderCollection('cards');
      else if(view==='subscriptions')renderCollection('subscriptions');
      else if(view==='reminders')renderCollection('reminders');
      else if(view==='notes')renderCollection('notes');
      else if(view==='documents')renderCollection('documents');
      else if(view==='otps')renderCollection('otps');
      else if(view==='security')renderSecurity();
      else if(view.startsWith('extra:'))renderExtraEditor();
      else{view='home';renderHome();}
    }
  }
  function brand(){return append(h('div','brand'),h('div','brand-mark','♜'),h('span','', 'СЕЙФ'));}
  function shieldSvg(){
    const wrap=h('div','hero-logo');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 70 70');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M35 5 60 15v22C60 52 50 60 35 66 20 60 10 52 10 37V15z');path.setAttribute('fill','none');path.setAttribute('stroke','#9cf7e2');path.setAttribute('stroke-width','3');
    const keypath=document.createElementNS('http://www.w3.org/2000/svg','path');keypath.setAttribute('d','M35 28a6 6 0 1 0 0 12l-3 13h6l-3-13');keypath.setAttribute('fill','#9cf7e2');
    svg.append(path,keypath);wrap.append(svg);return wrap;
  }
  // Profile preference is stored INSIDE the encrypted vault, never in localStorage.
  const PROFILE_LABELS={man:'Мужской · Графит',woman:'Женский · Лиловый',neutral:'Универсальный · Нейтральный'};
  function profileMode(){return extras.rhythmProfile?.[0]?.mode||'woman';} // preserve 1.5 look for upgraded vaults
  function renderProfileSetup(){
    const main=h('main','hero-screen profile-onboarding');
    append(main,shieldSvg(),h('h1','hero-title','СЕЙФ'),h('p','hero-sub','Сначала выбери своё пространство.'));
    const panel=h('section','auth-card');append(panel,h('div','eyebrow','ШАГ 1 ИЗ 2'),h('h2','profile-title','Какой стиль тебе ближе?'),h('p','note','Это выбор оформления, а не ограничение функций. Всё можно изменить позже в настройках, не удаляя записи.'));
    const choices=h('div','profile-choices');
    for(const [id,icon,title,desc] of [['man','◈','Мужской','Графит · глубокий синий · спорт и стиль'],['woman','✿','Женский','Лиловый · мягкие тона · цикл и забота'],['neutral','◌','Универсальный','Спокойный нейтральный стиль · всё под рукой']]){
      const b=h('button','profile-choice'+(setupProfile===id?' selected':''));b.type='button';b.setAttribute('aria-pressed',String(setupProfile===id));
      append(b,h('span','profile-choice-icon',icon),append(h('span','profile-choice-copy'),h('strong','',title),h('small','',desc)),h('span','profile-choice-check',setupProfile===id?'✓':'○'));
      b.addEventListener('click',()=>{setupProfile=id;render();});choices.append(b);
    }
    append(panel,choices,btn('Далее · создать пароль →','btn-primary full',()=>{setupStep='password';render();}));
    main.append(panel);root.append(main);
  }
  async function changeProfile(mode){
    if(!PROFILE_LABELS[mode])return false;
    const next={...extras,rhythmProfile:[{id:'profile',mode,createdAt:Date.now()}]};
    const ok=await commit(entries,next);
    if(ok){rhUi.feedFilter='all';view='rhythm';render();}
    return ok;
  }
  function profileChooser(){
    const panel=h('section','panel profile-settings');append(panel,h('h3','','Сценарии СЕЙФА'),h('p','note','Проверяй мужской, женский и универсальный вариант на одном устройстве. Переключение НЕ удаляет фото, пароли, расходы и документы.'));
    const choices=h('div','profile-switch-list');
    for(const [mode,title] of Object.entries(PROFILE_LABELS)){
      const b=btn((profileMode()===mode?'✓ ':'○ ')+title,'btn-outline profile-switch',async()=>{if(mode===profileMode())return;b.disabled=true;await changeProfile(mode);});choices.append(b);
    }
    append(panel,choices,h('p','note','Для проверки регистрации с самого начала ниже есть отдельная команда «Обнулить тестовый СЕЙФ». Она удаляет все данные без возможности восстановления без резервной копии.'),btn('Начать тест с нуля (удалить всё)','btn-danger btn-small',wipeDialog));
    return panel;
  }
  function renderAuth(){
    const setup=phase==='setup';
    if(setup&&setupStep==='profile'){renderProfileSetup();return;}
    const main=h('main','hero-screen');append(main,shieldSvg(),h('h1','hero-title','СЕЙФ'),h('p','hero-sub','Все доступы. Один ключ.'));
    const card=h('section','auth-card');const frm=h('form','auth-form');frm.noValidate=true;
    append(frm,h('div','eyebrow',setup?'ШАГ 2 ИЗ 2 · '+PROFILE_LABELS[setupProfile]:'ЛИЧНОЕ ХРАНИЛИЩЕ'));
    if(setup)frm.append(btn('← Выбрать другое оформление','btn-outline btn-small',()=>{setupStep='profile';render();}));
    const pwd=input(setup?'Не менее 12 символов':'Введите мастер-пароль','password');pwd.autocomplete=setup?'new-password':'current-password';
    append(frm,field('Мастер-пароль',pwd));
    let confirm,accepted, counter, match;
    if(setup){
      // Show the required length and matching status before submission, so a user is never stuck with no explanation.
      counter=h('p','password-hint');counter.setAttribute('aria-live','polite');append(frm,counter);
      confirm=input('Повторите пароль','password');confirm.autocomplete='new-password';
      append(frm,field('Повторите пароль',confirm));
      match=h('p','password-hint');match.setAttribute('aria-live','polite');append(frm,match);
      const label=h('label','checklabel');accepted=h('input');accepted.type='checkbox';
      append(label,accepted,h('span','', 'Я понимаю: восстановить мастер-пароль невозможно. Я сохраню его самостоятельно.'));
      append(frm,label);
      const refresh=()=>{
        const size=Array.from(pwd.value).length;
        counter.textContent=size>=12?'✓ Длина подходит: '+size+' символов':'Длина пароля: '+size+'/12 символов'+(size?'. Добавьте ещё '+(12-size):'');
        counter.className='password-hint '+(size>=12?'hint-good':size?'hint-warn':'');
        match.textContent=!confirm.value?'Повторите пароль для подтверждения':pwd.value===confirm.value?'✓ Пароли совпадают':'Пароли не совпадают';
        match.className='password-hint '+(!confirm.value?'':pwd.value===confirm.value?'hint-good':'hint-warn');
      };
      pwd.addEventListener('input',refresh);confirm.addEventListener('input',refresh);refresh();
    }
    const submit=btn(setup?'Создать сейф →':'Открыть сейф →','btn-primary full',null,'submit');append(frm,submit);
    const error=h('div','auth-error');error.setAttribute('role','alert');error.setAttribute('aria-live','assertive');error.hidden=true;append(frm,error);
    const setError=(message,focusTarget)=>{error.textContent=message;error.hidden=false; if(focusTarget)focusTarget.focus();};
    frm.addEventListener('submit',async ev=>{
      ev.preventDefault();error.textContent='';error.hidden=true;
      if(!pwd.value){setError('Введите мастер-пароль.',pwd);return;}
      if(setup){
        const size=Array.from(pwd.value).length;
        if(size<12){setError('Недостаточно символов: '+size+' из 12. Добавьте ещё '+(12-size)+'.',pwd);return;}
        if(pwd.value!==confirm.value){setError('Пароли не совпадают. Введите одинаковый пароль в оба поля.',confirm);return;}
        if(!accepted.checked){setError('Сначала подтвердите, что понимаете: забытый мастер-пароль восстановить нельзя.',accepted);return;}
      }
      submit.disabled=true;submit.textContent=setup?'Создаём зашифрованный сейф…':'Открываем сейф…';
      try {if(setup)await create(pwd.value);else await unlock(pwd.value);}
      catch(_err){
        setError(setup?'Не удалось создать сейф. Проверьте, что открыли сайт по HTTPS в обычном Safari и разрешено хранение данных браузера.':'Не удалось открыть сейф. Проверьте мастер-пароль или целостность резервной копии.');
        submit.disabled=false;submit.textContent=setup?'Создать сейф →':'Открыть сейф →';
      }
    });
    if(!setup&&faceRecord()){
      const faceBtn=btn('◉ Открыть с Face ID','btn-outline full',async()=>{
        faceBtn.disabled=true;error.hidden=true;
        try{await unlockFace();}
        catch(err){setError(err?.message||'Не удалось открыть через Face ID. Введите мастер-пароль.');faceBtn.disabled=false;}
      });
      card.append(faceBtn);
    }
    const importBtn=btn('↧ Восстановить из зашифрованной копии','btn-outline full',chooseImport);
    append(card,frm,h('div','separator'),importBtn);append(main,card,
      h('div','notice-strip','Тестовая версия. Не сохраняйте здесь реальные пароли от банков, Госуслуг и других критичных аккаунтов до независимой проверки безопасности.'));
    root.append(main);
  }
  function renderError(){
    const main=h('main','hero-screen');append(main,shieldSvg(),h('h1','hero-title','СЕЙФ'),h('p','hero-sub','Не удалось открыть локальное хранилище.'),
      h('div','warning','Проверьте, что приложение запущено через HTTPS или localhost, и браузер разрешает IndexedDB. Никакие данные автоматически не удаляются.'),btn('Попробовать снова','btn-primary',()=>location.reload()));root.append(main);
  }
  function go(where){stopOtp();if(where.startsWith('rhythm:')){const sub=where.slice(7);if(['wardrobe','feed'].includes(sub))rhUi.feedFilter='all';else if(['sport','travel','events'].includes(sub))rhUi.feedFilter=sub;}view=where;render();window.scrollTo(0,0);}
  function shell(){const s=h('main','shell');if(view==='life'){root.append(s);return s;}const bar=h('div','topbar');
    append(bar,brand(),h('span','build-badge','v2.4'),append(h('div','topactions'),iconButton('⚙','Настройки',()=>go('settings')),iconButton('⌑','Заблокировать',()=>lock(true))));append(s,bar);
    const nav=h('nav','primary-nav');nav.setAttribute('aria-label','Основные разделы');
    for(const [id,label,ico] of [['dashboard','Главная','⌂'],['rhythm','Мой ритм','✿'],['life','Сейф Life','♡'],['cards','Карты','▤'],['home','Пароли','⌘'],['reminders','Даты','◷']]){
      const item=h('button','nav-pill'+(id==='cards'?' nav-pill-cards':'')+(view===id?' active':''));item.type='button';append(item,h('span','',ico),h('span','',label));item.addEventListener('click',()=>go(id));nav.append(item);
    }
    s.append(nav);root.append(s);return s;}
  function filteredEntries(q){return entries.filter(x=>{const s=serviceInfo(x.serviceId);const hay=[x.name||s[1],x.account,x.login,s[1]].join(' ').toLocaleLowerCase('ru');return hay.includes(q.toLocaleLowerCase('ru'));});}
  function renderCards(container,items){container.replaceChildren();if(!items.length){container.append(append(h('div','empty'),h('div','emoji','🔎'),h('h3','','Ничего не найдено'),h('p','','Попробуйте другое название или логин.')));return;}
    const grid=h('div','tiles');for(const item of items){const info=serviceInfo(item.serviceId);const b=h('button','tile');b.type='button';
      append(b,serviceIcon(item.serviceId),append(h('div','tile-main'),h('div','tile-name',item.name||info[1]),h('div','tile-login',item.account||item.login)),h('span','tile-right','›'));
      b.addEventListener('click',()=>go('detail:'+item.id));grid.append(b);}
    container.append(grid);
  }
  function renderHome(){const s=shell();const header=h('div','header-row');
    append(header,append(h('div',''),h('div','eyebrow','ВАШЕ ПРОСТРАНСТВО'),h('h1','h1','Ваши доступы'),h('p','sub','Никаких забытых паролей. Всё под рукой.')),
      append(h('div','stat-circle'),h('div','stat-value',entries.length),h('div','stat-label','ЗАПИСЕЙ')));
    s.append(header);
    const q=input('Поиск по сервису или логину');q.autocomplete='off';q.setAttribute('aria-label','Поиск');
    const search=h('div','search');search.append(q);
    const add=btn('＋ Добавить','btn-primary',()=>go('new'));
    s.append(append(h('div','toolbar'),search,add));
    if(!entries.length){const empty=h('div','empty');
      append(empty,h('div','emoji','🔐'),h('h3','','Сейф пока пуст'),h('p','','Добавьте первую тестовую запись и попробуйте, как работает хранилище.'),btn('Добавить запись','btn-primary',()=>go('new')));s.append(empty);
    }else{
      const favs=entries.filter(x=>x.favorite).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
      const favBox=h('div');const allBox=h('div');
      function refreshList(){
        const term=q.value.trim();const matches=filteredEntries(term);
        favBox.replaceChildren();allBox.replaceChildren();
        if(!term&&favs.length){favBox.append(sectionTitle('★ Избранное',h('span','section-small',favs.length+' записей')));const deck=h('div');renderCards(deck,favs);favBox.append(deck);}
        allBox.append(sectionTitle(term?'Результаты поиска':'Все аккаунты',h('span','section-small',matches.length+' записей')));
        const deck=h('div');renderCards(deck,matches.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)));allBox.append(deck);
      }
      q.addEventListener('input',refreshList);s.append(favBox,allBox);refreshList();
    }
    s.insertBefore(dashboardShortcut(), s.firstChild.nextSibling);
    s.append(h('div','foot','Только на этом устройстве · Зашифрованное хранение · Тестовый продукт'));
  }
  function pageTitle(label){return append(h('div','pagehead'),btn('← Назад','btn-outline btn-small',()=>go('dashboard')),h('h2','',label));}
  function renderEditor(){
    const edit=view.startsWith('edit:');const id=edit?view.slice(5):null;const current=edit?entries.find(x=>x.id===id):null;
    if(edit&&!current){go('home');return;}
    const s=shell();s.append(pageTitle(edit?'Редактировать':'Новая запись'));
    const info=h('div','panel');append(info,h('h3','','Выберите сервис'),h('p','note','Прокрутите барабан или нажмите на нужную иконку.'));
    let selected=current?.serviceId||'instagram';
    const wheel=h('div','wheel');wheel.setAttribute('aria-label','Барабан сервисов');
    const wheelItems=[];const serviceName=h('div','wheeltitle');
    const custom=input('Название вашего сервиса','text',current?.name||'');custom.maxLength=200;
    const customField=field('Название сервиса',custom);
    function updateSelected(id,doScroll=false){selected=id;
      wheelItems.forEach(({btn,id:itemId})=>{btn.classList.toggle('selected',itemId===id);btn.setAttribute('aria-pressed',String(itemId===id));});
      serviceName.textContent='Выбран: '+serviceInfo(id)[1];customField.classList.toggle('hidden',id!=='other');
      if(doScroll){const item=wheelItems.find(x=>x.id===id);item?.btn.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});}
    }
    for(const item of SVC){const x=h('button','wheel-item');x.type='button';
      append(x,serviceIcon(item[0]),h('span','',item[1]));x.addEventListener('click',()=>updateSelected(item[0],true));wheelItems.push({btn:x,id:item[0]});wheel.append(x);}
    wheel.addEventListener('scroll',()=>{
      // Snap selection to the card nearest the centre when the wheel is dragged.
      const center=wheel.getBoundingClientRect().left+wheel.clientWidth/2;let best=null,delta=Infinity;
      for(const x of wheelItems){const box=x.btn.getBoundingClientRect();const d=Math.abs(box.left+box.width/2-center);if(d<delta){delta=d;best=x;}}
      if(best&&delta<75&&best.id!==selected)updateSelected(best.id,false);
    },{passive:true});
    info.append(serviceName,wheel,customField);s.append(info);
    const form=h('form','panel');form.noValidate=true;
    append(form,h('h3','','Данные для входа'));
    const grid=h('div','formgrid');
    const account=input('Например, личный','text',current?.account||'');account.maxLength=200;
    const login=input('Телефон, почта или логин','text',current?.login||'');login.maxLength=500;login.required=true;login.autocomplete='off';login.spellcheck=false;
    const pwd=input('Введите или создайте пароль','password',current?.password||'');pwd.maxLength=2000;pwd.required=true;pwd.autocomplete='new-password';pwd.spellcheck=false;
    const show=btn('◉','btn-outline btn-small',()=>{const visible=pwd.type==='password';pwd.type=visible?'text':'password';show.textContent=visible?'◌':'◉';});show.setAttribute('aria-label','Показать или скрыть пароль');
    const passline=append(h('div','passwordline'),pwd,show);
    const url=input('https://...','url',current?.url||'');url.maxLength=500;url.autocomplete='off';
    const notes=h('textarea','field-input');notes.placeholder='Дополнительная информация (необязательно)';notes.value=current?.note||'';notes.maxLength=3000;
    append(grid,field('Аккаунт (необязательно)',account),field('Логин / почта / телефон',login),field('Пароль',passline,true),field('Ссылка на сайт',url,true),field('Заметки',notes,true));
    const fav=h('input');fav.type='checkbox';fav.checked=!!current?.favorite;
    const favlabel=append(h('label','checklabel'),fav,h('span','','★ Добавить в избранное'));
    append(form,grid,h('div','separator'),favlabel);
    const generator=h('div','panel');append(generator,h('h3','','Генератор надёжного пароля'));
    const lengthLine=append(h('div','range-row'),h('span','','Длина пароля'),h('strong','mono','20 символов'));
    const lengthSlider=h('input','range');lengthSlider.type='range';lengthSlider.min='12';lengthSlider.max='40';lengthSlider.value='20';
    lengthSlider.addEventListener('input',()=>{lengthLine.lastChild.textContent=lengthSlider.value+' символов';});
    generator.append(lengthLine,lengthSlider);
    const chips=h('div','chip-row');const opts={upper:true,lower:true,digits:true,special:true};
    for(const [k,name] of [['upper','A–Z'],['lower','a–z'],['digits','0–9'],['special','!@#']]){
      const c=h('input');c.type='checkbox';c.checked=true;c.addEventListener('change',()=>{opts[k]=c.checked;});
      chips.append(append(h('label','chip'),c,h('span','',name)));
    }
    generator.append(chips,btn('✧ Сгенерировать пароль','btn-outline full',()=>{
      try{pwd.value=generatePassword(Number(lengthSlider.value),opts);pwd.type='text';show.textContent='◌';toast('Новый пароль создан. Не забудьте сохранить запись.');}
      catch(e){toast(e.message||'Не удалось создать пароль',true);}
    }));
    s.append(generator);
    const submit=btn(edit?'Сохранить изменения':'Сохранить в сейф','btn-primary full',null,'submit');
    append(form,h('div','separator'),submit);
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();if(selected==='other'&&!custom.value.trim()){toast('Укажите название сервиса',true);custom.focus();return;}
      if(!login.value.trim()||!pwd.value){toast('Заполните логин и пароль',true);return;}
      const website=url.value.trim();if(website&&!/^https?:\/\//i.test(website)){toast('Ссылка должна начинаться с https:// или http://',true);return;}
      const stamp=Date.now();const entry={id:current?.id||idNew(),serviceId:selected,name:selected==='other'?custom.value.trim():'',account:account.value.trim(),login:login.value.trim(),password:pwd.value,url:website,note:notes.value,favorite:fav.checked,createdAt:current?.createdAt||stamp,updatedAt:stamp};
      submit.disabled=true;submit.textContent='Шифруем и сохраняем…';
      const next=edit?entries.map(x=>x.id===entry.id?entry:x):[...entries,entry];
      const ok=await commit(next);if(ok)go('detail:'+entry.id);else {submit.disabled=false;submit.textContent=edit?'Сохранить изменения':'Сохранить в сейф';}
    });
    // Insert the full form after the picker and generator.
    s.insertBefore(form,generator);
    requestAnimationFrame(()=>updateSelected(selected,true));
    s.append(h('p','note','Пароль не отправляется на сервер. Тестируйте на вымышленных данных.'));
  }
  function secureIndex(n){const a=new Uint32Array(1);const ceiling=Math.floor(0x100000000/n)*n;let v;do{crypto.getRandomValues(a);v=a[0];}while(v>=ceiling);return v%n;}
  function generatePassword(length,chosen){
    const groups=[];if(chosen.upper)groups.push('ABCDEFGHJKLMNPQRSTUVWXYZ');if(chosen.lower)groups.push('abcdefghijkmnopqrstuvwxyz');if(chosen.digits)groups.push('23456789');if(chosen.special)groups.push('!@#$%*_-+=?');
    if(!groups.length)throw new Error('Выберите хотя бы один набор символов');
    const all=groups.join('');const chars=groups.map(x=>x[secureIndex(x.length)]);
    while(chars.length<length)chars.push(all[secureIndex(all.length)]);
    for(let i=chars.length-1;i>0;i--){const j=secureIndex(i+1);[chars[i],chars[j]]=[chars[j],chars[i]];}
    return chars.join('');
  }
  async function copyText(str,type){
    try{await navigator.clipboard.writeText(str);toast(type+' скопирован. Буфер обмена очистите вручную.');}
    catch(_err){toast('Копирование недоступно. Откройте поле и скопируйте вручную.',true);}
  }
  function infoField(title,value,actions){
    const wrap=h('div','info-field');const inner=append(h('div','info-field-content'),h('div','value',value));
    if(actions)for(const a of actions)inner.append(a);
    return append(wrap,h('div','info-field-title',title),inner);
  }
  function renderDetail(){const item=entries.find(x=>x.id===view.slice(7));if(!item){go('home');return;}
    const s=shell();s.append(pageTitle('Данные аккаунта'));
    const top=h('div','detail-head');append(top,serviceIcon(item.serviceId,true),h('h1','',item.name||serviceInfo(item.serviceId)[1]),h('p','',item.account||'Ваш аккаунт'));
    s.append(top);
    const panel=h('section','panel');
    const loginCopy=btn('Копировать','btn-outline btn-small',()=>copyText(item.login,'Логин'));
    panel.append(infoField('Логин',item.login,[loginCopy]));
    const mask=h('div','value password','••••••••••••');
    const show=btn('Показать','btn-outline btn-small',()=>{const visible=mask.textContent===item.password;mask.textContent=visible?'••••••••••••':item.password;mask.classList.toggle('password',visible);show.textContent=visible?'Показать':'Скрыть';});
    show.dataset.seifSound='reveal';
    const copy=btn('Копировать','btn-outline btn-small',()=>copyText(item.password,'Пароль'));
    const passwordField=append(h('div','info-field'),h('div','info-field-title','Пароль'),append(h('div','info-field-content'),mask,show,copy));
    panel.append(passwordField);
    if(item.url)panel.append(infoField('Адрес сайта',item.url));
    if(item.note)panel.append(infoField('Заметки',item.note));
    s.append(panel);
    const row=h('div','btnrow');
    append(row,btn('✎ Редактировать','btn-primary',()=>go('edit:'+item.id)),btn(item.favorite?'★ В избранном':'☆ В избранное','btn-outline',async()=>{
      const ok=await commit(entries.map(x=>x.id===item.id?{...x,favorite:!x.favorite,updatedAt:Date.now()}:x));if(ok)render();
    }),btn('Удалить','btn-danger',async()=>{
      if(!window.confirm('Удалить запись «'+(item.name||serviceInfo(item.serviceId)[1])+'»? Это действие нельзя отменить.'))return;
      const ok=await commit(entries.filter(x=>x.id!==item.id));if(ok)go('home');
    }));s.append(row);
    s.append(h('div','notice-strip','Не передавайте никому мастер-пароль. При копировании пароль может оставаться в буфере обмена устройства.'));
  }
  function makeRow(title,desc,action){const left=append(h('div',''),h('strong','',title),h('p','',desc));return append(h('div','setting-row'),left,action);}
  function renderSettings(){const s=shell();s.append(pageTitle('Настройки сейфа · 1.6'));
    s.append(profileChooser());
    const info=h('div','panel');append(info,h('h3','','Ваш сейф'),
      makeRow('Все разделы','Карты, подписки, напоминания, заметки, документы и TOTP',btn('Перейти','btn-outline btn-small',()=>go('dashboard'))),
      makeRow('Шифрование','AES‑GCM‑256 · PBKDF2‑SHA‑256 · '+iterationCount.toLocaleString('ru')+' итераций',h('span','badge','ВКЛЮЧЕНО')),
      makeRow('Хранение','Локально в этом браузере. Синхронизации нет.',h('span','badge','ЛОКАЛЬНО')),
      makeRow('Автоблокировка','Через 3 минуты бездействия. После сворачивания — по таймеру ниже.',h('span','badge','3 МИН')),
      makeRow('Паролей',entries.length+' аккаунтов',h('span','badge',String(entries.length))));
    const delaySelector=h('div','bg-lock-picker');
    delaySelector.append(h('div','field-label','КОГДА ЗАПРАШИВАТЬ МАСТЕР-ПАРОЛЬ ПОСЛЕ ВЫХОДА ИЗ ПРИЛОЖЕНИЯ')); 
    const delayRow=h('div','bg-lock-options');
    const delayDescription=h('p','note','Выбери 10, 15 или 20 секунд. При сворачивании весь экран сразу скрывается. Если вернуться до окончания времени — сейф откроется без повторного пароля. Позже потребуется мастер-пароль.');
    for(const n of VALID_BG_DELAYS){
      const b=btn((n/60)+' мин.','bg-lock-option'+(n===bgLockSeconds?' chosen':''),()=>{
        bgLockSeconds=n;
        try{localStorage.setItem(BG_SETTINGS_KEY,String(n));}catch{toast('Не удалось запомнить настройку после перезапуска',true);}
        for(const button of delayRow.children)button.classList.toggle('chosen',button===b);
      });
      b.setAttribute('aria-pressed',n===bgLockSeconds?'true':'false');
      b.addEventListener('click',()=>{for(const button of delayRow.children)button.setAttribute('aria-pressed',button===b?'true':'false');});
      delayRow.append(b);
    }
    append(delaySelector,delayRow,delayDescription);
    info.append(delaySelector);
    // A silent phone or browser may mute web audio, so it is always optional.
    const soundSwitch=btn(tapSoundEnabled?'♫ Включён':'♫ Выключен','btn-outline btn-small',()=>{
      tapSoundEnabled=!tapSoundEnabled;
      try{localStorage.setItem(SOUND_SETTINGS_KEY,tapSoundEnabled?'on':'off');}
      catch{toast('Настройка звука не сохраняется в этом браузере',true);}
      soundSwitch.textContent=tapSoundEnabled?'♫ Включён':'♫ Выключен';
      soundSwitch.setAttribute('aria-pressed',String(tapSoundEnabled));
      if(tapSoundEnabled)playTapSound();
    });
    soundSwitch.setAttribute('aria-pressed',String(tapSoundEnabled));
    info.append(makeRow('Звук открытия карт','Мягкий щелчок при открытии карты или просмотре пароля. Не влияет на безопасность.',soundSwitch));
    info.append(h('p','note','Звук можно выключить здесь в любой момент. В беззвучном режиме iPhone он может быть не слышен.'));
    s.append(info);
    const facePanel=h('div','panel');facePanel.append(h('h3','','Face ID / биометрия'));
    const faceStatus=h('p','note',faceRecord()?'Биометрический ключ настроен на этом устройстве. Мастер-пароль продолжает работать.':'Для повторного входа можно попробовать настроить биометрический ключ. Работает только там, где поддерживается WebAuthn PRF.');
    facePanel.append(faceStatus);
    if(faceRecord())facePanel.append(btn('Отключить Face ID','btn-outline',()=>{forgetFace();faceStatus.textContent='Face ID отключён на этом устройстве.';toast('Биометрический ключ удалён');}));
    else facePanel.append(btn('Настроить Face ID','btn-primary',()=>{
      const body=h('div','stack');body.append(h('p','note','Для настройки один раз введите мастер-пароль. Далее устройство предложит биометрическую проверку, если поддерживает безопасное расширение PRF. Пароль не сохраняется.'));
      const password=input('Мастер-пароль','password');body.append(password);
      const message=h('p','note');body.append(message);
      const pop=overlay('Включить Face ID',body);
      const confirm=btn('Продолжить','btn-primary full',async()=>{
        if(!password.value){message.textContent='Введите мастер-пароль';return;}
        confirm.disabled=true;
        try{await enrollFace(password.value);password.value='';pop.close();toast('Face ID настроен');go('settings');}
        catch(err){message.textContent=err?.message||'Биометрия недоступна';confirm.disabled=false;}
      });body.append(confirm,btn('Отмена','btn-outline full',pop.close));
    }));
    facePanel.append(h('p','note','На iPhone поддержка WebAuthn PRF зависит от iOS и браузера. Если не поддерживается, вход по мастер-паролю остаётся единственным вариантом. Не используем имитацию Face ID.'));
    s.append(facePanel);
    const backup=h('div','panel');append(backup,h('h3','','Резервные копии'),
      h('p','note','Скачайте только зашифрованный файл. Храните его в надёжном месте: после очистки Safari, удаления приложения или смены устройства локальная база может исчезнуть.'),
      makeRow('Экспорт зашифрованного сейфа','В файле нет читаемых логинов и паролей.',btn('Скачать','btn-outline btn-small',exportBackup)),
      makeRow('Импорт копии','Полностью заменит текущие записи после проверки пароля.',btn('Выбрать','btn-outline btn-small',chooseImport)));
    s.append(backup);
    const future=h('div','panel');append(future,h('h3','','В планах после аудита'),h('p','note','Системное автозаполнение паролей, семейные общие сейфы, облачная синхронизация и push-уведомления потребуют дополнительных компонентов и проверки безопасности. Пока эти функции не работают.'));s.append(future);
    const help=h('div','panel');append(help,h('h3','','На экран «Домой»'),
      h('p','note','iPhone / iPad: откройте размещённое на HTTPS приложение в Safari → Поделиться → «На экран Домой». Android: меню Chrome → «Установить приложение» или «Добавить на главный экран». Для автономной работы сначала откройте установленное приложение при наличии интернета.'));
    s.append(help);
    const danger=h('div','dangerzone');append(danger,h('strong','', 'Удалить весь сейф'),h('p','note','Все записи в этом браузере исчезнут. Перед удалением скачайте зашифрованную резервную копию.'),btn('Удалить всё','btn-danger btn-small',wipeDialog));s.append(danger);
    s.append(h('div','notice-strip','СЕЙФ 1.6 · Тестовая версия. Не храните здесь реальные пароли от банков, Госуслуг и других критичных аккаунтов до независимой проверки безопасности.'));
  }
  function exportBackup(){
    if(phase!=='unlocked'||!vaultFile)return toast('Сейф заблокирован',true);
    // Read the committed encrypted file rather than in-memory plaintext.
    dbGet().then(json=>{
      if(!json)throw new Error('Копия отсутствует');
      validateEnvelope(JSON.parse(json));
      const blob=new Blob([json],{type:'application/json'});const url=URL.createObjectURL(blob);const a=h('a');
      a.href=url;a.download='seif-encrypted-'+new Date().toISOString().slice(0,10)+'.json';
      document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
      toast('Зашифрованная копия готова к сохранению.');
    }).catch(()=>toast('Не удалось подготовить резервную копию',true));
  }
  function overlay(title,body){const bg=h('div','modal-backdrop');const modal=h('div','modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    append(modal,h('h3','',title),body);bg.append(modal);document.body.append(bg);
    bg.addEventListener('click',e=>{if(e.target===bg)bg.remove();});return {bg,modal,close:()=>bg.remove()};
  }
  function chooseImport(){const file=h('input');file.type='file';file.accept='.json,application/json';file.hidden=true;document.body.append(file);
    file.addEventListener('change',async()=>{
      try{
        const selected=file.files?.[0];if(!selected)return;
        if(selected.size>16000000)throw new Error('Файл слишком большой');
        const text=await selected.text();const parsed=validateEnvelope(JSON.parse(text));
        importDialog(parsed);
      }catch(err){toast(err.message||'Невозможно прочитать этот файл',true);}finally{file.remove();}
    });
    file.click();
  }
  function importDialog(file){
    const body=h('div','stack');append(body,h('p','','Это действие полностью заменит текущий сейф. Укажите мастер-пароль ОТ ИМПОРТИРУЕМОЙ копии. Без него файл нельзя расшифровать.'));
    const pass=input('Мастер-пароль резервной копии','password');pass.autocomplete='off';
    const err=h('div','smallprint');
    const row=h('div','btnrow');
    const confirmBtn=btn('Проверить и восстановить','btn-primary',async()=>{
      if(!pass.value)return;
      const ticket=sessionEpoch;
      confirmBtn.disabled=true;err.textContent='Проверяем шифрование…';
      try{
        const slt=readBytes(file.salt);const newKey=await derive(pass.value,slt,file.iterations);
        const restored=await decryptVault(file,newKey);
        if(ticket!==sessionEpoch)return;
        if(!window.confirm('Пароль верный. Заменить текущий сейф данными из резервной копии (паролей: '+restored.entries.length+', других записей: '+Object.values(restored.extras).reduce((n,a)=>n+a.length,0)+')?')){
          confirmBtn.disabled=false;err.textContent='Операция отменена';return;
        }
        if(ticket!==sessionEpoch)return;
        await dbPut(JSON.stringify(validateEnvelope(file)));
        if(ticket!==sessionEpoch)return;
        key=newKey;salt=slt;iterationCount=file.iterations;entries=restored.entries;extras=restored.extras;vaultFile=file;phase='unlocked';view='dashboard';lastActivity=Date.now();popup.close();render();toast('Зашифрованная база восстановлена');
      }catch(_error){err.textContent='Неверный пароль или повреждённая копия. Ничего не заменено.';confirmBtn.disabled=false;}
    });
    append(row,confirmBtn,btn('Отмена','btn-outline',()=>popup.close()));append(body,field('Мастер-пароль копии',pass),err,row);
    const popup=overlay('Импорт сейфа',body);
  }
  function wipeDialog(){
    const body=h('div','stack');append(body,h('p','','ОСТОРОЖНО: будут навсегда удалены карты, пароли, документы, расходы, фотографии, цикл и настройки профиля. Для простого переключения мужского/женского/нейтрального сценария используйте «Настройки → Сценарии СЕЙФА». Перед полным сбросом скачайте резервную копию. Для подтверждения введите УДАЛИТЬ.'));
    const phrase=input('УДАЛИТЬ');const confirmBtn=btn('Безвозвратно удалить','btn-danger',async()=>{
      if(phrase.value!=='УДАЛИТЬ'){toast('Введите слово УДАЛИТЬ',true);return;}
      confirmBtn.disabled=true;
      try{await dbDel();forgetFace();forget();phase='setup';setupStep='profile';setupProfile='neutral';view='home';popup.close();render();toast('Тестовый сейф обнулён');}
      catch(_err){toast('Не удалось удалить',true);confirmBtn.disabled=false;}
    });append(body,field('Подтверждение',phrase),append(h('div','btnrow'),confirmBtn,btn('Отмена','btn-outline',()=>popup.close())));
    const popup=overlay('Удаление сейфа',body);
  }
  async function startup(){
    if(!window.isSecureContext||!crypto?.subtle||!indexedDB){phase='error';render();return;}
    try{const found=await dbGet();phase=found?'locked':'setup';}
    catch(_err){phase='error';}
    render();
    if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
      navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
    }
  }
  // ===== Daily-life modules: entirely encrypted together with the existing vault. =====
  const FEATURES = {
    cards: {title:'Мои карты',icon:'▤',subtitle:'Скидки и бонусы в одном месте',empty:'Добавьте первую карту магазина — потом её можно быстро показать на кассе.',add:'Добавить карту'},
    subscriptions: {title:'Подписки',icon:'◉',subtitle:'Следите за регулярными платежами',empty:'Добавьте подписку, и СЕЙФ покажет, когда следующий платёж.',add:'Добавить подписку'},
    reminders: {title:'Важные даты',icon:'◷',subtitle:'Не пропустите важное',empty:'Добавьте оплату, продление или важную дату.',add:'Добавить напоминание'},
    documents: {title:'Важный документ',icon:'▣',subtitle:'Фото, скриншоты и важные бумаги под рукой',empty:'Добавьте фото или скриншот страховки, чека или другого важного документа.',add:'Добавить документ'},
    notes: {title:'Личные заметки',icon:'▧',subtitle:'Важные записи под мастер-паролем',empty:'Здесь можно хранить короткие зашифрованные заметки. Для секретных документов пока используйте проверенное приложение.',add:'Добавить заметку'},
    otps: {title:'Коды 2FA',icon:'✥',subtitle:'Одноразовые коды подтверждения',empty:'Добавьте тестовый TOTP-ключ вручную, чтобы проверить встроенный генератор.',add:'Добавить код'}
  };
  function dashboardShortcut(){
    const row=h('div','feature-strip');
    append(row,h('div','feature-spark','✧'),append(h('div','grow'),h('strong','','Всё важное — в одном месте'),h('p','','Карты, подписки, даты и заметки под одним ключом.')),btn('Открыть →','btn-primary btn-small',()=>go('dashboard')));
    return row;
  }
  function featureTile(k){
    const x=FEATURES[k],b=h('button','dash-tile dash-'+k);b.type='button';
    append(b,h('div','dash-icon',x.icon),h('strong','',x.title),h('span','dash-small',extraCount(k)+' записей'),h('span','dash-arrow','↗'));
    b.addEventListener('click',()=>go(k));return b;
  }
  function extraCount(k){return (extras[k]||[]).length;}
  function dayFrom(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return null;const d=new Date(s+'T12:00:00');return isNaN(d.getTime())?null:d;}
  function todayISO(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
  function isoDate(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
  function dayDiff(date){const d=dayFrom(date);if(!d)return NaN;const n=new Date();return Math.round((Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())-Date.UTC(n.getFullYear(),n.getMonth(),n.getDate()))/86400000);}
  function shiftedMonth(d, months){const y=d.getFullYear(),m=d.getMonth()+months;const first=new Date(y,m,1,12),last=new Date(first.getFullYear(),first.getMonth()+1,0,12);return new Date(first.getFullYear(),first.getMonth(),Math.min(d.getDate(),last.getDate()),12);}
  function upcomingDate(item){
    const original=dayFrom(item.dueDate);if(!original)return null;
    const repeat=item.cycle||item.repeat||'none'; if(repeat==='none'||repeat==='once')return item.dueDate;
    const stride=repeat==='yearly'?12:1;let d=original;
    if(dayDiff(isoDate(d))<0){const n=new Date(),delta=(n.getFullYear()-original.getFullYear())*12+n.getMonth()-original.getMonth();const jump=Math.max(0,Math.floor(delta/stride)*stride);d=shiftedMonth(original,jump);if(dayDiff(isoDate(d))<0)d=shiftedMonth(original,jump+stride);}
    return isoDate(d);
  }
  function dateHuman(s){const d=dayFrom(s);return d?d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}):'Дата не указана';}
  function dueText(s){const n=dayDiff(s);if(!Number.isFinite(n))return '';
    if(n===0)return 'Сегодня';if(n===1)return 'Завтра';if(n<0)return 'Просрочено · '+Math.abs(n)+' дн.';return 'Через '+n+' дн.';
  }
  function monthlySpend(){
    const sums={};
    for(const x of extras.subscriptions){
      const a=Number(x.amount);if(!Number.isFinite(a)||a<0||a>1e9)continue;
      const rate=x.cycle==='yearly'?a/12:x.cycle==='once'?0:a;
      const cur=x.currency||'₽';sums[cur]=(sums[cur]||0)+rate;
    }
    return Object.entries(sums).filter(([_,sum])=>sum>0).map(([cur,sum])=>sum.toLocaleString('ru-RU',{maximumFractionDigits:2})+' '+cur).join(' · ')||'Пока нет регулярных платежей';
  }
  function upcomingItems(){
    const hits=[];
    for(const x of extras.subscriptions){const date=upcomingDate(x);if(date&&dayDiff(date)<=Math.max(0,Number(x.remindDays??3)))hits.push({kind:'subscriptions',item:x,date});}
    for(const x of extras.documents){const date=x.dueDate;if(date&&dayDiff(date)<=30)hits.push({kind:'documents',item:x,date});}
    for(const x of extras.reminders){if(x.completed)continue;const date=upcomingDate(x);if(date&&dayDiff(date)<=Math.max(0,Number(x.remindDays??3)))hits.push({kind:'reminders',item:x,date});}
    return hits.sort((a,b)=>dayDiff(a.date)-dayDiff(b.date));
  }
  function overviewPanel(){
    const p=h('div','overview-panel'); const t=upcomingItems();
    append(p,append(h('div','row between'),h('span','eyebrow','МОЙ ДЕНЬ'),h('span','now-tag',new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long'}))),h('h2','overview-title',t.length?'Есть важные дела':'Сегодня всё под контролем'));
    if(t.length){for(const item of t.slice(0,3)){
      const b=h('button','upcoming-row');append(b,h('span','upcoming-dot',item.kind==='subscriptions'?'₽':item.kind==='documents'?'▣':'◷'),append(h('span','grow'),h('strong','',item.item.name),h('small','',item.kind==='subscriptions'?'Подписка':item.kind==='documents'?'Документ':'Напоминание')),h('span','due-pill',dueText(item.date)));b.addEventListener('click',()=>go(item.kind));p.append(b);
    }}else p.append(h('p','overview-desc','Ближайших событий по вашим настройкам нет. Добавьте подписку или дату, чтобы видеть их здесь.'));
    return p;
  }
  function addLoyaltyFromBrand(brandId){preselectedBrand=brandId;go('extra:cards:new');}
  function cardRank(a,b){return Number(!!b.favorite)-Number(!!a.favorite)||(b.updatedAt||0)-(a.updatedAt||0);}
  function cardAccessTile(item,large=false){
    const button=h('button','cash-card'+(large?' cash-card-large':''));button.type='button';
    button.setAttribute('aria-label','Открыть карту '+(item.name||item.brand||'магазина'));
    const b=loyaltyBrand(item);
    const copy=append(h('span','cash-copy'),h('strong','',item.name||item.brand||b[1]),h('small','',(item.codeType==='dynamic'?'Открыть приложение магазина':item.codeType==='image'?'Фото постоянного кода':item.codeType==='qr'?'Статичный QR-код':'Показать штрихкод')));
    append(button,loyaltyTile(item,large),copy,h('span','cash-arrow','↗'));
    button.addEventListener('click',()=>showCard(item));return button;
  }
  function loyaltyHomeSpotlight(){
    const box=h('section','loyalty-spotlight');box.setAttribute('aria-label','Карты магазинов для кассы');
    const head=h('div','loyalty-spotlight-head');
    append(head,append(h('div',''),h('span','eyebrow','НА КАССЕ — В ОДНО КАСАНИЕ'),h('h2','loyalty-feature-title','Мои карты'),h('p','loyalty-feature-sub','Все скидочные карты в одном месте. Откройте нужную перед кассой.')),
      append(h('div','loyalty-card-counter'),h('strong','',String(extras.cards.length)),h('span','','карт')));
    box.append(head);
    if(extras.cards.length){
      const hits=[...extras.cards].sort(cardRank).slice(0,4);
      const rail=h('div','cash-rail');for(const item of hits)rail.append(cardAccessTile(item,true));box.append(rail);
      if(extras.cards.length>4)box.append(h('p','loyalty-more','Ещё '+(extras.cards.length-4)+' карт — в разделе «Карты»'));
      const actions=append(h('div','loyalty-main-actions'),btn('▤ Все карты','btn-primary',()=>go('cards')),btn('＋ Добавить','btn-outline',()=>addLoyaltyFromBrand('other')));
      box.append(actions);
    }else{
      const empty=h('div','loyalty-starter');append(empty,h('div','starter-symbol','▤'),h('h3','','Добавьте свою первую карту'),h('p','','Магнит, Пятёрочка, Лента — сохраните постоянный код, чтобы он был под рукой.'));
      const actions=append(h('div','loyalty-main-actions'),btn('＋ Добавить карту','btn-primary',()=>addLoyaltyFromBrand('other')),btn('Все магазины','btn-outline',()=>go('cards')));empty.append(actions);box.append(empty);
      const presets=h('div','starter-brands');for(const b of LOYALTY_BRANDS.slice(0,4)){
        const t=h('button','starter-brand');t.type='button';append(t,loyaltyTile({brandId:b[0]}),h('span','',b[1]));t.addEventListener('click',()=>addLoyaltyFromBrand(b[0]));presets.append(t);
      }box.append(presets);
    }
    box.append(h('p','loyalty-honest-note','Меняющиеся QR-коды магазинов нельзя обновлять автоматически: для них откроется официальный сервис.'));
    return box;
  }

  // ONE curated home screen: only the records that the person explicitly stars.
  // Favorites remain in the existing encrypted vault, not localStorage.
  const FAVORITE_COLLECTIONS=['cards','subscriptions','reminders','documents','notes','otps'];
  function everydayItems(onlyFavorites=true){
    const items=[];
    for(const x of entries)if(!onlyFavorites||x.favorite)items.push({kind:'passwords',record:x});
    for(const kind of FAVORITE_COLLECTIONS){
      for(const x of (extras[kind]||[]))if(!onlyFavorites||x.favorite)items.push({kind,record:x});
    }
    return items.sort((a,b)=>(b.record.updatedAt||0)-(a.record.updatedAt||0));
  }
  function quickName(item){return item.kind==='passwords'?(item.record.name||serviceInfo(item.record.serviceId)[1]):(item.record.name||'Без названия');}
  function quickType(item){return item.kind==='passwords'?'Пароль':FEATURES[item.kind]?.title||'Запись';}
  function quickOpen(item){
    const id=item.record.id;
    if(item.kind==='cards'){showCard(item.record);return;}
    if(item.kind==='passwords'){go('detail:'+id);return;}
    if(item.kind==='otps'){showOtp(item.record);return;}
    if(item.kind==='documents'){showDocument(item.record);return;}
    go('extra:'+item.kind+':'+id);
  }
  async function toggleQuickFavorite(item){
    if(item.kind==='passwords')return commit(entries.map(x=>x.id===item.record.id?{...x,favorite:!x.favorite,updatedAt:Date.now()}:x));
    return updateCollection(item.kind,item.record.id,{favorite:!item.record.favorite});
  }
  function quickTile(item){
    const el=h('button','daily-favorite-card'),kind=item.kind;
    el.type='button';el.setAttribute('aria-label','Открыть '+quickName(item));
    const icon=kind==='cards'?loyaltyTile(item.record,true):kind==='passwords'?serviceIcon(item.record.serviceId,true):kind==='documents'&&item.record.imageData?h('img','daily-document-thumbnail'):h('div','daily-favorite-icon',FEATURES[kind]?.icon||'★');
    if(kind==='documents'&&item.record.imageData){icon.src=item.record.imageData;icon.alt='Фото документа';}
    const words=append(h('span','daily-favorite-copy'),h('small','',quickType(item)),h('strong','',quickName(item)));
    append(el,icon,words,h('span','daily-favorite-arrow','↗'));
    el.addEventListener('click',()=>quickOpen(item));return el;
  }
  function dailyFavoritesPanel(){
    const panel=h('section','daily-favorites-panel');panel.setAttribute('aria-label','Избранное на главной');
    const header=h('div','daily-favorites-header');
    append(header,append(h('div',''),h('span','eyebrow','МОЯ ГЛАВНАЯ'),h('h2','daily-title','Каждый день'),h('p','daily-sub','Только то, что вы выбрали сами. Всё нужное — в одно касание.')),
      btn('★ Настроить','btn-outline btn-small',()=>go('favorites')));
    panel.append(header);
    const starred=everydayItems();
    if(starred.length){
      const grid=h('div','daily-favorites-grid');for(const item of starred.slice(0,12))grid.append(quickTile(item));panel.append(grid);
      if(starred.length>12)panel.append(h('p','daily-sub','Ещё '+(starred.length-12)+' в разделе «Настроить».'));
    }else{
      panel.append(append(h('div','daily-empty'),h('div','daily-empty-star','★'),h('strong','','Ваш главный экран — ваши правила'),h('p','','Отметьте звёздочкой карты, пароли, подписки или важные даты. Они появятся здесь.'),btn('Выбрать избранное →','btn-primary',()=>go('favorites'))));
    }
    return panel;
  }
  function loyaltyQuickLink(){
    const wrap=h('section','loyalty-shortcut');
    const goCards=btn('▤ Карты магазинов · '+extras.cards.length,'btn-primary',()=>go('cards'));
    append(wrap,append(h('div',''),h('strong','','Все карты и QR-коды'),h('p','','Храните их в разделе «Карты». На главную выводите только любимые.')),goCards);
    return wrap;
  }
  function renderFavoriteManager(){
    const s=shell();
    s.append(append(h('div','pagehead'),btn('← На главную','btn-outline btn-small',()=>go('dashboard')),h('h2','','Настроить главную')));
    s.append(append(h('div','favorite-manager-heading'),h('span','eyebrow','ВАШЕ ИЗБРАННОЕ'),h('h1','h1','Что под рукой?'),h('p','sub','Отмечайте ★ любые карты, пароли, напоминания и подписки. Отмеченные записи будут большими кнопками на главном экране.')));
    const all=everydayItems(false);
    const list=h('div','favorite-manager-list');s.append(list);
    function refresh(){
      list.replaceChildren();
      if(!all.length){list.append(append(h('div','daily-empty'),h('p','','Записей пока нет. Добавьте первую карту или пароль.'),btn('＋ Добавить карту','btn-primary',()=>go('cards'))));return;}
      const marked=all.filter(x=>x.record.favorite),unmarked=all.filter(x=>!x.record.favorite);
      for(const [header,group] of [['На главной',marked],['Остальные записи',unmarked]]){
        if(!group.length)continue;
        list.append(sectionTitle(header,h('span','section-small',String(group.length))));
        for(const item of group){
          const row=h('div','favorite-manager-row');
          const emblem=item.kind==='cards'?loyaltyTile(item.record):item.kind==='passwords'?serviceIcon(item.record.serviceId):h('div','daily-favorite-icon',FEATURES[item.kind]?.icon||'★');
          const text=append(h('div','favorite-manager-copy'),h('strong','',quickName(item)),h('small','',quickType(item)));
          const toggle=btn(item.record.favorite?'★ На главной':'☆ Добавить','btn-outline btn-small favorite-manage-toggle',async()=>{
            toggle.disabled=true;
            try{const ok=await toggleQuickFavorite(item);if(ok){go('favorites');return;} }finally{toggle.disabled=false;}
          });
          append(row,emblem,text,toggle);list.append(row);
        }
      }
    }
    refresh();
    s.append(h('p','notice-strip','Выбор хранится внутри зашифрованного сейфа. После обновления страницы потребуется мастер-пароль.'));
  }

  // Daily main screen: selected loyalty cards are a vertical, swipeable deck.
  // Notes/events/password shortcuts are separately displayed *below* it.
  function dailyCardStories(){
    const section=h('section','daily-stories-section');
    const header=h('div','daily-stories-header');
    append(header,append(h('div',''),h('span','eyebrow','МОЯ ГЛАВНАЯ'),h('h2','daily-title','Мои любимые карты'),h('p','daily-sub','Листайте вверх. Нажмите на карту — код откроется на весь экран.')),
      btn('★ Настроить','btn-outline btn-small',()=>go('favorites')));
    section.append(header);
    const favCards=[...extras.cards].filter(x=>x.favorite).sort(cardRank);
    if(favCards.length){
      const deck=h('div','daily-stories');deck.setAttribute('aria-label','Любимые карты: прокручивайте вверх');
      favCards.forEach((item,i)=>{
        const info=loyaltyBrand(item);
        const tile=h('button','daily-story-card daily-story-'+info[0]);tile.type='button';
        tile.setAttribute('aria-label','Показать карту '+(item.name||info[1]));
        append(tile,
          append(h('div','daily-story-top'),loyaltyTile(item,true),h('span','daily-story-index',`${i+1} / ${favCards.length}`)),
          append(h('div','daily-story-middle'),h('small','','КАРТА МАГАЗИНА'),h('strong','',item.name||info[1])),
          append(h('div','daily-story-bottom'),h('span','',item.codeType==='dynamic'?'Открыть магазин':'Показать мой код'),h('span','','↗')));
        tile.addEventListener('click',()=>showCard(item));deck.append(tile);
      });
      section.append(deck);
      if(favCards.length>1)section.append(h('p','stories-scroll-hint','↑ Проведите пальцем вверх, чтобы перейти к следующей карте'));
    }else{
      const empty=append(h('div','daily-empty'),h('div','daily-empty-star','▤'),h('strong','','Выбирайте любимые магазины'),h('p','','Добавьте карту и включите «★ На главную». Здесь появятся ваши большие карточки.'),btn('＋ Добавить карту','btn-primary',()=>go('cards')),btn('★ Выбрать из сохранённых','btn-outline',()=>go('favorites')));
      section.append(empty);
    }
    return section;
  }
  function dailyOtherFavorites(){
    const groups=[
      {name:'Важные документы',kinds:['documents'],desc:'Фото страховки, чека и других нужных бумаг'},
      {name:'Важные даты',kinds:['reminders'],desc:'Страховка, оплата и продление — отдельно от паролей'},
      {name:'Пароли',kinds:['passwords'],desc:'Избранные доступы и аккаунты'},
      {name:'Остальное под рукой',kinds:['subscriptions','notes','otps'],desc:'Подписки, заметки и коды'}
    ];
    const wrapper=h('div','daily-favorites-groups');let count=0;
    for(const group of groups){
      const items=everydayItems().filter(x=>group.kinds.includes(x.kind));
      if(!items.length)continue;count++;
      const section=h('section','daily-other-section');
      section.append(sectionTitle(group.name,h('span','section-small',items.length+' шт.')));
      section.append(h('p','daily-sub',group.desc));
      const grid=h('div','daily-other-grid');for(const item of items)grid.append(quickTile(item));
      section.append(grid);wrapper.append(section);
    }
    return count?wrapper:null;
  }

  // ===== МОИ РАСХОДЫ · encrypted local extension inside the same vault =====
  // Financial records are NEVER sent to a server or stored in plaintext localStorage.
  // Pricing is a proposed future charge. No purchase, payment or entitlement exists.
  const EXPENSE_CATEGORIES = [
    ['groceries','Продукты','🛒'],['coffee','Кофе','☕'],['restaurant','Ресторан','🍽️'],
    ['school','Школа','🎓'],['barber','Барбершоп','✂️'],['taxi','Такси','🚕'],
    ['car','Обслуживание авто','🔧'],['fuel','Бензин','⛽'],['wife','Жена','❤️'],
    ['me','Я','🙂'],['son','Сынок','👦'],['mom','Мама','👩'],['sister','Сестра','🌷'],
    ['clothes','Вещи','👕'],['utilities','ЖКХ','🏠'],['shopping','Магазины','🛍️'],
    ['health','Здоровье','💊'],['gift','Подарки','🎁'],['fun','Развлечения','🎬'],
    ['travel','Путешествия','✈️'],['mobile','Связь и подписки','📱'],
    ['sport','Спорт','💪'],['other','Другое','📦'],['transit','Проезд','🚌'],
    ['rent','Квартира','🔑'],['study','Учёба','📚'],['phone','Телефон','📞'],
    ['subscriptions','Подписки','🔄'],['gpt','GPT','🤖'],['metro','Оплата за метро','🚇']
  ];
  const expenseCategory = id => EXPENSE_CATEGORIES.find(c => c[0]===id) || EXPENSE_CATEGORIES[22];
  const expenseStart = () => ({tab:'add',amount:'0',category:'groceries',note:'',day:todayISO(),monthOffset:0,filter:'all',editId:null});
  let expenseUi=expenseStart();
  function resetExpenseState(){expenseUi=expenseStart();}
  function money(kopeks){
    const n=Number(kopeks)||0;
    return (n/100).toLocaleString('ru-RU',{maximumFractionDigits:2,minimumFractionDigits:0})+' ₽';
  }
  function cleanExpenseValue(value){
    const s=String(value||'').replace(',', '.');
    if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(s))return null;
    const cents=Math.round(Number(s)*100);
    return Number.isSafeInteger(cents)&&cents>0&&cents<=100000000000?cents:null;
  }
  function amountToInput(value){const n=Math.max(0,Number(value)||0);return n%100===0?String(n/100):String(n/100).replace('.',',');}
  function expenseItems(){return (extras.expenses||[]).filter(e=>Number.isSafeInteger(e.amountKopeks)&&e.amountKopeks>0&&dayFrom(e.day));}
  function expenseMonthDate(){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+expenseUi.monthOffset,1,12);}
  function expenseMonthId(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  function monthExpenses(){const prefix=expenseMonthId(expenseMonthDate());return expenseItems().filter(e=>e.day.startsWith(prefix));}
  function expenseSum(items){return items.reduce((v,e)=>v+e.amountKopeks,0);}
  function expenseDateTitle(date){const now=todayISO();const d=dayFrom(date);if(!d)return date;
    const delta=dayDiff(date);if(delta===0)return 'Сегодня';if(delta===-1)return 'Вчера';if(delta===-2)return 'Позавчера';return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  }
  function expenseDateSmall(date){return dayFrom(date)?.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})||'';}
  function expButton(text,css,click){const n=h('button',css,text);n.type='button';n.addEventListener('click',click);return n;}
  function expenseSummary(){
    const items=monthExpenses(),now=todayISO(),current=expenseMonthId(expenseMonthDate())===now.slice(0,7);
    const total=expenseSum(items),today=current?expenseSum(items.filter(e=>e.day===now)):0;
    return {items,total,today,prev:total-today,current};
  }
  function expensesDashboardTile(){
    const total=expenseSum(expenseItems().filter(e=>e.day.startsWith(todayISO().slice(0,7))));
    const sec=h('section','expenses-launch-area');
    const button=h('button','expenses-launch');button.type='button';button.setAttribute('aria-label','Открыть Мои расходы');
    append(button,append(h('span','expenses-launch-icon'),'↗'),
      append(h('span','expenses-launch-copy'),h('span','expenses-launch-kicker','КАЖДЫЙ ДЕНЬ'),h('strong','','Мои расходы'),h('small','','Внести за секунду · история · аналитика')),
      append(h('span','expenses-launch-total'),h('small','','ЗА МЕСЯЦ'),h('strong','',money(total))));
    button.addEventListener('click',()=>{expenseUi.tab='add';go('expenses');});
    sec.append(button);
    sec.append(h('p','expenses-launch-caption','Дополнительный модуль · тестирование бесплатно · плановая цена 199 ₽ после запуска. Оплата ещё не подключена.'));
    return sec;
  }
  function renderExpenses(){
    // Own app-like surface, while remaining protected by the SAME encrypted vault.
    const shell=h('main','expense-shell');root.append(shell);
    const header=h('header','expense-header');
    append(header,expButton('←','expense-back',()=>go('dashboard')),
      append(h('div','expense-brand'),h('span','expense-logo','↗'),h('strong','','Мои расходы')),
      expButton('⋯','expense-more',()=>{
        const body=h('div','stack');append(body,h('h3','','Модуль «Мои расходы»'),h('p','note','Отдельный раздел внутри СЕЙФА. Все суммы и комментарии хранятся в общей зашифрованной базе на вашем устройстве.'),h('p','note','Плановая стоимость дополнительного модуля — 199 ₽. Реальная оплата и активация пока не подключены. Сейчас доступен бесплатный тестовый режим.'),btn('Закрыть','btn-primary',()=>popup.close()));const popup=overlay('О модуле',body);
      }));shell.append(header);
    const area=h('div','expense-content');shell.append(area);
    if(expenseUi.tab==='history')expenseHistory(area);
    else if(expenseUi.tab==='overview')expenseOverview(area);
    else expenseAddScreen(area);
    const bottom=h('nav','expense-bottom');bottom.setAttribute('aria-label','Разделы расходов');
    for(const [id,label] of [['add','＋ Добавить'],['overview','◷ Обзор'],['history','☰ История']]){
      const b=expButton(label,'expense-tab'+(expenseUi.tab===id?' selected':''),()=>{expenseUi.tab=id;render();window.scrollTo(0,0);});
      b.setAttribute('aria-current',expenseUi.tab===id?'page':'false');bottom.append(b);
    }
    shell.append(bottom);
  }
  function expenseOverviewHeader(target){
    const d=expenseMonthDate(),s=expenseSummary();
    const nav=h('div','expense-month-switch');
    const prev=expButton('‹','expense-month-btn',()=>{expenseUi.monthOffset--;render();});
    const next=expButton('›','expense-month-btn',()=>{expenseUi.monthOffset++;render();});
    next.disabled=expenseUi.monthOffset>=0;
    append(nav,prev,h('strong','',d.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})),next);target.append(nav);
    return s;
  }
  function expenseKPIs(target,summary,isAdd){
    const cards=h('div','expense-kpis');const n=expenseMonthDate();
    append(cards,
      append(h('div','expense-kpi lime'),h('span','','За сегодня'),h('strong','',money(summary.today)),h('small','',new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long'})),h('small','','Только расходы этого дня')),
      append(h('div','expense-kpi dark'),h('span','','За месяц · всего'),h('strong','',money(summary.total)),h('small','',n.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})),h('small','','Все дни, включая сегодня')));
    target.append(cards);
    if(isAdd){const details=h('div','expense-breakdown');append(details,
      append(h('div','expense-breakdown-row'),h('span','','За предыдущие дни месяца'),h('strong','',money(summary.prev))),
      append(h('div','expense-breakdown-row'),h('span','','Сегодня'),h('strong','',money(summary.today))),
      append(h('div','expense-breakdown-row'),h('span','','Всего за месяц'),h('strong','',money(summary.total))),
      h('p','','Новый день начинается с 0 ₽. Расходы прошлых дней остаются в месячном итоге.'));
      target.append(details);
    }
  }
  async function persistExpense(){
    if(phase!=='unlocked')return;
    const cents=cleanExpenseValue(expenseUi.amount);
    if(cents===null){toast('Введите сумму больше 0 ₽ (до 2 знаков после запятой)',true);return;}
    if(!dayFrom(expenseUi.day)){toast('Выберите правильную дату расхода',true);return;}
    if(!EXPENSE_CATEGORIES.some(x=>x[0]===expenseUi.category)){toast('Выберите категорию',true);return;}
    const now=Date.now();const current=(extras.expenses||[]);
    if(!expenseUi.editId&&current.length>=10000){toast('Достигнут предел записей. Сохраните резервную копию.',true);return;}
    const prev=current.find(e=>e.id===expenseUi.editId);
    const entry={id:prev?.id||idNew(),category:expenseUi.category,amountKopeks:cents,day:expenseUi.day,note:expenseUi.note.trim().slice(0,500),createdAt:prev?.createdAt||now,updatedAt:now};
    const next=prev?current.map(e=>e.id===prev.id?entry:e):[...current,entry];
    const saveButtons=Array.from(document.querySelectorAll('.expense-save'));
    saveButtons.forEach(b=>b.disabled=true);
    const success=await commit(entries,{...extras,expenses:next});
    if(success){expenseUi={...expenseUi,tab:'add',amount:'0',note:'',day:todayISO(),editId:null,monthOffset:0};render();}
    else saveButtons.forEach(b=>b.disabled=false);
  }
  function expenseAddScreen(area){
    const dateString=new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'});
    append(area,append(h('div','expense-intro'),h('span','expense-muted',dateString),h('h1','','Всё под контролем.')));
    const s=expenseSummary();expenseKPIs(area,s,true);
    const wrap=h('section','expense-form');
    const title=append(h('div','expense-form-title'),h('span','','НОВЫЙ РАСХОД'),h('span','',dayFrom(expenseUi.day)?.toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'})||''));
    wrap.append(title);
    wrap.append(h('p','expense-form-hint',expenseUi.editId?'Редактирование расхода. Сохранение обновит существующую запись.':'Запишем за сегодня. Расход войдёт и в день, и в итог месяца.'));
    const amount=h('div','expense-amount',money(Math.round(Number(expenseUi.amount.replace(',','.'))*100)||0));
    wrap.append(amount);
    const catSelect=h('select','expense-category-select');catSelect.setAttribute('aria-label','Категория расхода');
    for(const [id,name,icon] of EXPENSE_CATEGORIES){const opt=h('option','',icon+' '+name);opt.value=id;if(expenseUi.category===id)opt.selected=true;catSelect.append(opt);}
    catSelect.addEventListener('change',()=>{expenseUi.category=catSelect.value;highlightCategory();});wrap.append(catSelect);
    const shortcuts=h('div','expense-quick-cats');
    function highlightCategory(){for(const b of shortcuts.children)b.classList.toggle('active',b.dataset.cat===expenseUi.category);}
    for(const [id,name,icon] of EXPENSE_CATEGORIES.slice(0,3)){
      const b=expButton(icon+' '+name,'expense-chip'+(expenseUi.category===id?' active':''),()=>{expenseUi.category=id;catSelect.value=id;highlightCategory();});b.dataset.cat=id;shortcuts.append(b);
    }
    wrap.append(shortcuts);
    const note=h('input','expense-note');note.placeholder='Комментарий · необязательно';note.maxLength=500;note.value=expenseUi.note;note.setAttribute('aria-label','Комментарий');note.addEventListener('input',()=>{expenseUi.note=note.value;});wrap.append(note);
    const dateWrap=h('label','expense-date-row');append(dateWrap,h('span','','Дата расхода'),h('span','expense-date-control',''));const date=h('input','expense-date');date.type='date';date.value=expenseUi.day;date.setAttribute('aria-label','Дата расхода');date.addEventListener('change',()=>{expenseUi.day=date.value;});dateWrap.lastChild.append(date);wrap.append(dateWrap);
    const keypad=h('div','expense-keypad');
    function redrawAmount(){const cents=Number(expenseUi.amount.replace(',','.'))*100;if(Number.isFinite(cents)&&cents>=0)amount.textContent=money(Math.round(cents));}
    function digitPress(d){
      let x=expenseUi.amount;
      if(d==='⌫'){x=x.length>1?x.slice(0,-1):'0';if(x==='')x='0';}
      else if(d===','){if(!x.includes(','))x+=',';}
      else if(x.includes(',')&&x.split(',')[1].length>=2)return;
      else if(x==='0')x=d;
      else if(x.replace(/\D/g,'').length<10)x+=d;
      expenseUi.amount=x;redrawAmount();
    }
    for(const val of ['1','2','3','4','5','6','7','8','9',',','0','⌫'])keypad.append(expButton(val,'expense-key',()=>digitPress(val)));
    wrap.append(keypad);
    const action=h('div','expense-save-row');append(action,h('p','','Выбери категорию, введи сумму и нажми OK.'),expButton(expenseUi.editId?'OK ✓':'OK ↗','expense-save',persistExpense));wrap.append(action);
    if(expenseUi.editId)wrap.append(expButton('Отменить редактирование','expense-cancel-edit',()=>{expenseUi=expenseStart();render();}));
    area.append(wrap);
    const latest=[...expenseItems()].sort((a,b)=>b.day.localeCompare(a.day)||(b.updatedAt||0)-(a.updatedAt||0)).slice(0,4);
    const section=h('section','expense-recent');append(section,append(h('div','expense-section-heading'),h('h2','','Последние расходы'),expButton('Все →','expense-inline-link',()=>{expenseUi.tab='history';render();})));
    if(latest.length)latest.forEach(e=>section.append(expenseRow(e)));else section.append(h('p','expense-empty','Записей ещё нет. Первый расход можно добавить прямо здесь.'));
    area.append(section);
    expenseCategoryBars(area,s.items);
  }
  function expenseRow(e){
    const row=h('div','expense-transaction');const cat=expenseCategory(e.category);
    const main=expButton('','expense-transaction-main',()=>editExpense(e));
    append(main,h('span','expense-tx-icon',cat[2]),append(h('span','expense-tx-text'),h('strong','',cat[1]),h('small','',expenseDateSmall(e.day)+(e.note?' · '+e.note:''))),h('strong','expense-tx-amount',money(e.amountKopeks)));
    const dots=expButton('⋯','expense-tx-more',()=>expenseActions(e));dots.setAttribute('aria-label','Редактировать или удалить расход');
    append(row,main,dots);return row;
  }
  function editExpense(e){expenseUi={...expenseUi,tab:'add',editId:e.id,amount:amountToInput(e.amountKopeks),category:e.category,day:e.day,note:e.note||''};render();window.scrollTo(0,0);}
  function expenseActions(e){
    const content=h('div','stack');const pop=overlay('Расход · '+money(e.amountKopeks),content);
    append(content,h('p','note',(expenseCategory(e.category)[2]+' '+expenseCategory(e.category)[1]+' · '+dateHuman(e.day))),
      btn('Изменить расход','btn-primary full',()=>{pop.close();editExpense(e);}),
      btn('Удалить расход','btn-danger full',async()=>{if(!window.confirm('Удалить расход '+money(e.amountKopeks)+'?'))return;const next=extras.expenses.filter(x=>x.id!==e.id);const ok=await commit(entries,{...extras,expenses:next});if(ok){pop.close();render();}}),
      btn('Отмена','btn-outline full',()=>pop.close()));
  }
  function expenseCategoryBars(area,items){
    const sums=new Map();for(const e of items){sums.set(e.category,(sums.get(e.category)||0)+e.amountKopeks);}
    const top=[...sums].sort((a,b)=>b[1]-a[1]);const total=expenseSum(items);
    const box=h('section','expense-categories');append(box,append(h('div','expense-section-heading'),h('h2','','Куда уходят деньги'),expButton('Обзор →','expense-inline-link',()=>{expenseUi.tab='overview';render();})));
    if(!top.length)box.append(h('p','expense-empty','Добавьте расходы — здесь появятся категории и их доли.'));
    for(const [id,n] of top.slice(0,7)){const cat=expenseCategory(id),pct=total?Math.round(n/total*100):0;
      const bar=h('div','expense-cat-item');append(bar,append(h('div','expense-cat-head'),h('span','',cat[2]+' '+cat[1]),h('span','',money(n)+' · '+pct+'%')));
      const track=h('div','expense-cat-track'),fill=h('div','expense-cat-fill');fill.style.width=Math.max(1,pct)+'%';track.append(fill);bar.append(track);box.append(bar);
    }
    area.append(box);
  }
  function expenseOverview(area){
    append(area,h('p','expense-eyebrow','ПО КАТЕГОРИЯМ И ДАТАМ'),h('h1','expense-title','Обзор расходов'));
    const s=expenseOverviewHeader(area);expenseKPIs(area,s,false);
    const daysInMonth = new Date(expenseMonthDate().getFullYear(),expenseMonthDate().getMonth()+1,0).getDate();
    const daysSoFar = s.current ? new Date().getDate() : daysInMonth;
    const summary = h('div','expense-breakdown overview');
    append(summary,
      append(h('div','expense-breakdown-row'),h('span','','Расходов за месяц'),h('strong','',String(s.items.length))),
      append(h('div','expense-breakdown-row'),h('span','','В среднем на день'),h('strong','',money(Math.round(s.total/daysSoFar)))));
    area.append(summary);
    expenseCategoryBars(area,s.items);
  }
  function expenseHistory(area){
    append(area,h('p','expense-eyebrow','НИЧЕГО НЕ ТЕРЯЕТСЯ'),h('h1','expense-title','История расходов'));
    expenseOverviewHeader(area);
    const filter=h('select','expense-category-select expense-history-filter');filter.setAttribute('aria-label','Фильтр категории');
    const defaultOpt=h('option','','Все категории');defaultOpt.value='all';filter.append(defaultOpt);
    for(const [id,name,icon] of EXPENSE_CATEGORIES){const opt=h('option','',icon+' '+name);opt.value=id;filter.append(opt);}
    filter.value=expenseUi.filter;filter.addEventListener('change',()=>{expenseUi.filter=filter.value;render();});area.append(filter);
    const items=monthExpenses().filter(e=>expenseUi.filter==='all'||e.category===expenseUi.filter).sort((a,b)=>b.day.localeCompare(a.day)||(b.updatedAt||0)-(a.updatedAt||0));
    if(!items.length){area.append(h('div','expense-empty-block','За этот месяц в выбранной категории расходов пока нет.'));return;}
    const days=[...new Set(items.map(e=>e.day))];
    for(const date of days){const group=items.filter(e=>e.day===date);const box=h('section','expense-history-day');
      append(box,append(h('div','expense-history-head'),append(h('div',''),h('h2','',expenseDateTitle(date)),h('p','',dateHuman(date))),append(h('div',''),h('small','','Потрачено за день'),h('strong','',money(expenseSum(group))))));
      const sums=new Map();for(const e of group)sums.set(e.category,(sums.get(e.category)||0)+e.amountKopeks);
      const chips=h('div','expense-history-chips');for(const [cat,n] of sums)chips.append(h('span','expense-history-chip',expenseCategory(cat)[2]+' '+expenseCategory(cat)[1]+' '+money(n)));box.append(chips);
      group.forEach(e=>box.append(expenseRow(e)));area.append(box);
    }
  }

  // Life demo is local only; generated personas are always visibly labeled DEMO.
  const LIFE_TOPICS=[['all','Все'],['wardrobe','Гардероб'],['sport','Спорт'],['beauty','Красота'],['nutrition','Питание'],['travel','Отдых']];
  const LIFE_NAMES=['Аня','Мария','София','Катя','Алина','Полина','Вика','Даша','Ольга','Юлия','Макс','Артём','Даня','Миша','Саша','Никита','Илья','Кирилл','Роман','Дима'];
  const LIFE_TEXT={wardrobe:['Собрала образ из базовых вещей. Как вам?','Один жакет — три совершенно разных настроения','Сегодня хочется спокойных оттенков и удобства'],travel:['Сохраняю эти выходные в памяти','Место, в которое хочется вернуться','Немного моря, воздуха и тишины'],beauty:['Новая причёска. Мне очень нравится!','Мой утренний ритуал ухода','Экспериментирую с макияжем сегодня'],sport:['Сегодня тренировалась — и настроение другое','Мой маленький спортивный прогресс','Утренняя пробежка вместо кофе'],nutrition:['Завтрак, после которого много энергии','Мой сбалансированный обед — просто и вкусно','Что готовите после тренировки?'],fitness:['Тренировка на всё тело — готово','Растяжка после насыщенного дня','Показываю любимые упражнения'],home:['Добавила немного уюта в квартиру','Люблю такие спокойные интерьеры','Мой уголок для отдыха и чтения'],family:['Самые тёплые моменты — рядом','Выходные с близкими','Семейные традиции, которые любим'],art:['Сегодня вдохновение пришло внезапно','Небольшой творческий эксперимент','Люблю создавать что-то своими руками'],life:['Обычный день, который стал особенным','Собрала маленькие радости недели','Делюсь моментом, который хочется сохранить']};
  const LIFE_PHOTOS={
    wardrobe:['photo-1483985988355-763728e1935b','photo-1539109136881-3be0616acf4b','photo-1485968579580-b6d095142e6e'],
    travel:['photo-1500534623283-312aade485b7','photo-1476514525535-07fb3b4ae5f1','photo-1469474968028-56623f02e42e'],
    beauty:['photo-1524504388940-b1c1722653e1','photo-1596462502278-27bfdc403348','photo-1512290923902-8a9f81dc236c'],
    sport:['photo-1517836357463-d25dfeac3438','photo-1534438327276-14e5300c3a48','photo-1549476464-37392f717541'],
    nutrition:['photo-1512621776951-a57141f2eefd','photo-1546069901-ba9599a7e63c','photo-1490645935967-10de6ba17061'],
    fitness:['photo-1571019613454-1cb2f99b2d8b','photo-1518611012118-696072aa579a','photo-1517836357463-d25dfeac3438'],
    home:['photo-1600210492486-724fe5c67fb0','photo-1616486338812-3dadae4b4ace','photo-1600607687939-ce8a6c25118c'],
    family:['photo-1511895426328-dc8714191300','photo-1476703993599-0035a21b17a9','photo-1529156069898-49953e39b3ac'],
    art:['photo-1513364776144-60967b0f800f','photo-1460661419201-fd4cecdf8a8b','photo-1547891654-e66ed7ebb968'],
    life:['photo-1490750967868-88aa4486c946','photo-1441986300917-64674bd600d8','photo-1511988617509-a57c8a288659']};
  let lifeTopic='all',lifePage=0,lifeView='feed',lifeProfileId=null;
  function lifeRead(){try{return JSON.parse(localStorage.getItem('seif-life-demo-v2')||'{}')||{};}catch{return {};}}
  function lifeWrite(data){try{localStorage.setItem('seif-life-demo-v2',JSON.stringify(data));return true;}catch{toast('Недостаточно памяти для сохранения. Уменьшите размер фотографий.',true);return false;}}
  function lifePeople(){return Array.from({length:50},(_,i)=>{const topic=LIFE_TOPICS[1+Math.floor(i/10)][0];return {id:i+1,name:LIFE_NAMES[(i*7+Math.floor(i/10))%20]+' '+['М.','К.','Л.','С.','В.'][i%5],gender:(i%2===0?'Девушка':'Парень'),handle:'life_'+String(i+1).padStart(3,'0'),topic,closed:false,caption:LIFE_TEXT[topic][i%3],count:3,demo:true};});}
  function lifePhoto(p,idx){const pic=h('div','life-photo');const img=document.createElement('img');img.alt='Иллюстрация публикации: '+p.topic;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.src=p.photos?p.photos[idx]:('https://images.unsplash.com/'+LIFE_PHOTOS[p.topic][(idx+p.id)%3]+'?auto=format&fit=crop&w=900&q=75');img.onerror=()=>{img.remove();pic.append(h('div','life-photo-fallback','Фото временно недоступно'));};pic.append(img);return pic;}
  function lifeAvatar(p,klass){const a=h('div',klass);const img=document.createElement('img');img.alt='Аватар '+p.name;img.loading='lazy';img.src=p.avatar||('https://i.pravatar.cc/160?img='+((Number(p.id)||17)%65+1));img.onerror=()=>{img.remove();a.textContent=p.name.slice(0,1);};a.append(img);return a;}
  function lifeProfile(p,state,s,mine=false){
    const header=h('section','life-profile-card');const hero=h('div','life-profile-hero');const avatar=lifeAvatar(p,'life-profile-avatar');const info=h('div','life-profile-info');
    append(info,h('h2','',p.name),h('p','life-handle','@'+p.handle),h('p','life-profile-bio',mine?(state.bio||'Мои моменты, мой стиль, моя жизнь ✨'):(p.bio||'Делюсь моментами, идеями и вдохновением · Демо-профиль')));
    append(hero,avatar,info);header.append(hero);
    const posts=mine?(state.posts||[]):[p,...Array.from({length:5},(_,i)=>({...p,id:'profile_'+p.id+'_'+i,caption:LIFE_TEXT[p.topic][(i+1)%3],count:3}))];
    const stats=h('div','life-profile-stats');for(const [number,label] of [[posts.length,'публикации'],[mine?0:Math.round(120+p.id*17),'подписчики'],[mine?0:Math.round(40+p.id*3),'подписки']])append(stats,append(h('div','life-stat'),h('strong','',String(number)),h('span','',label)));header.append(stats);
    const controls=h('div','life-profile-controls');
    if(mine){controls.append(btn('✎ Редактировать профиль','life-profile-primary',()=>{const name=prompt('Имя профиля',state.name||'Мой профиль');if(name===null)return;const bio=prompt('О себе',state.bio||'Мои моменты, мой стиль, моя жизнь ✨');if(bio===null)return;const d=lifeRead();d.name=name.trim().slice(0,40)||'Мой профиль';d.bio=bio.trim().slice(0,160);lifeWrite(d);render();}));const upload=h('input','life-avatar-upload');upload.type='file';upload.accept='image/*';upload.style.display='none';upload.addEventListener('change',async()=>{if(!upload.files?.[0])return;try{const photo=await lifeCompress(upload.files[0]);const d=lifeRead();d.avatar=photo;if(lifeWrite(d))render();}catch{toast('Не удалось загрузить аватар',true);}});controls.append(btn('＋ Аватар','life-profile-secondary',()=>upload.click()),upload);controls.append(btn(state.closed?'🔒 Закрытый':'🌍 Открытый','life-profile-secondary',()=>{const d=lifeRead();d.closed=!d.closed;lifeWrite(d);render();}));}
    else{controls.append(btn(state['follow_'+p.id]?'✓ Подписки':'＋ Подписаться','life-profile-primary',()=>{const d=lifeRead();d['follow_'+p.id]=!d['follow_'+p.id];lifeWrite(d);render();}));controls.append(btn('↗ В ленту','life-profile-secondary',()=>{lifeView='feed';render();}));}
    header.append(controls);s.append(header);s.append(h('h3','life-grid-title','Публикации'));
    const grid=h('div','life-profile-grid');posts.forEach((post,i)=>{const tile=h('button','life-grid-tile');tile.type='button';const img=document.createElement('img');img.loading='lazy';img.alt=post.caption;img.src=post.photos?.[0]||('https://images.unsplash.com/'+LIFE_PHOTOS[post.topic][(i+Number(p.id||0))%3]+'?auto=format&fit=crop&w=420&q=70');tile.append(img);tile.addEventListener('click',()=>{const wrap=h('div','life-profile-expanded');wrap.append(btn('✕ Закрыть публикацию','life-profile-secondary',()=>{wrap.remove();}));lifePost(post,lifeRead(),wrap);grid.after(wrap);wrap.scrollIntoView({behavior:'smooth',block:'start'});});grid.append(tile);});s.append(grid);
    s.append(h('p','life-demo-hint',mine?'Публикации сохраняются на этом устройстве.':'Демонстрационный профиль: подписчики и публикации вымышлены.'));
  }
  function lifePost(p,state,s){const card=h('article','life-post');const top=h('div','life-post-head');const avatar=lifeAvatar(p,'life-avatar');
    append(top,avatar,append(h('div','life-post-person'),h('strong','',p.name),h('small','','@'+p.handle+' · '+LIFE_TOPICS.find(t=>t[0]===p.topic)[1])),h('span','life-bot-label',p.demo?'Демо · '+p.gender:'Моё'));top.addEventListener('click',()=>{lifeProfileId=p.id;lifeView='profile';render();});card.append(top);
    let slide=0;const frame=h('div','life-frame');const count=h('span','life-counter','1 / '+p.count);const draw=()=>{frame.querySelector('.life-photo')?.remove();frame.prepend(lifePhoto(p,slide));count.textContent=(slide+1)+' / '+p.count;};frame.append(count);draw();
    if(p.count>1){const controls=h('div','life-slide-controls');append(controls,btn('‹','life-arrow',()=>{slide=(slide+p.count-1)%p.count;draw();}),btn('›','life-arrow',()=>{slide=(slide+1)%p.count;draw();}));frame.append(controls);}
    card.append(frame);const key='like_'+p.id;const actions=h('div','life-actions');append(actions,btn(state[key]?'♥ Нравится':'♡ Нравится','btn-outline',()=>{const d=lifeRead();d[key]=!d[key];lifeWrite(d);render();}),btn('💬 Комментарии','btn-outline',()=>{const d=lifeRead();const key='comments_'+p.id;const message=prompt('Ваш комментарий (демо, виден только вам)');if(message&&message.trim()){d[key]=[...(d[key]||[]),message.trim().slice(0,300)];lifeWrite(d);render();}}),btn(state['saved_'+p.id]?'🔖 Сохранено':'♧ Сохранить','btn-outline',()=>{const d=lifeRead();d['saved_'+p.id]=!d['saved_'+p.id];lifeWrite(d);render();}));
    append(card,actions,h('p','life-caption',p.caption));(state['comments_'+p.id]||[]).forEach(c=>card.append(h('p','life-user-comment','💬 '+c)));s.append(card);}
  async function lifeCompress(file){return new Promise((resolve,reject)=>{const im=new Image(),url=URL.createObjectURL(file);im.onload=()=>{try{const canvas=document.createElement('canvas'),scale=Math.min(1,900/Math.max(im.width,im.height));canvas.width=Math.max(1,Math.round(im.width*scale));canvas.height=Math.max(1,Math.round(im.height*scale));canvas.getContext('2d').drawImage(im,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',.68));}catch(e){reject(e);}finally{URL.revokeObjectURL(url);}};im.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Не удалось прочитать фото'));};im.src=url;});}
  function lifeCreate(s){append(s,h('h2','','Новая публикация'),h('p','sub','Три простых шага: фото, подпись, категория. До 5 фотографий.'));
    const form=h('div','life-compose'),file=h('input','life-file'),preview=h('div','life-preview');file.type='file';file.accept='image/*';file.multiple=true;file.addEventListener('change',()=>{preview.textContent=file.files.length+' фото выбрано';});
    const caption=h('textarea','life-textarea');caption.placeholder='Поделись моментом…';caption.maxLength=600;caption.rows=3;
    const select=h('select','life-category-select');LIFE_TOPICS.slice(1).forEach(([id,name])=>{const opt=h('option','',name);opt.value=id;select.append(opt);});
    append(form,h('label','','1. Выбери до 5 фотографий'),file,preview,h('label','','2. Напиши пару слов'),caption,h('label','','3. Выбери тему'),select,
      btn('Опубликовать в моей ленте','btn-primary full',async()=>{const files=Array.from(file.files||[]);if(!files.length||files.length>5){toast('Выбери от 1 до 5 фотографий',true);return;}if(!caption.value.trim()){toast('Добавь подпись',true);return;}try{const photos=await Promise.all(files.map(lifeCompress));const d=lifeRead();d.posts=d.posts||[];d.posts.unshift({id:'mine_'+Date.now(),name:d.name||'Мой профиль',handle:'my_life',topic:select.value,caption:caption.value.trim(),photos,count:photos.length,demo:false});if(d.posts.length>12)d.posts=d.posts.slice(0,12);if(lifeWrite(d)){lifeView='feed';lifeTopic='all';render();toast('Публикация сохранена на этом устройстве');}}catch(e){toast(e.message||'Ошибка обработки фотографий',true);}}));s.append(form);}
  function renderLife(){const s=shell(),state=lifeRead(),people=lifePeople(),myPosts=state.posts||[];
    s.classList.add('life-screen');
    const heading=h('div','life-topline');append(heading,btn('← Сейф','life-back',()=>go('dashboard')),h('strong','life-wordmark','СЕЙФ Life'),btn('＋','life-topplus',()=>{lifeView='create';render();}));s.append(heading);
    if(lifeView==='create'){s.append(h('h2','','Новая публикация'));lifeCreate(s);lifeBottom(s);return;}
    if(lifeView==='mine'){lifeProfile({id:'mine',name:state.name||'Мой профиль',handle:'my_life',avatar:state.avatar,topic:'travel'},state,s,true);lifeBottom(s);return;}
    if(lifeView==='profile'){const p=people.find(x=>x.id===lifeProfileId);if(!p){lifeView='feed';render();return;}lifeProfile(p,state,s,false);lifeBottom(s);return;}
    const welcome=h('div','life-welcome');append(welcome,h('strong','','Вдохновение на сегодня'),h('span','','50 демо-профилей · 5 интересов · по 3 фото'));s.append(welcome);
    const filters=h('div','life-filters');for(const [id,label] of LIFE_TOPICS){filters.append(btn(label,'life-chip'+(lifeTopic===id?' selected':''),()=>{lifeTopic=id;lifePage=0;render();}));}s.append(filters);
    const filtered=[...myPosts,...people].filter(p=>lifeTopic==='all'||p.topic===lifeTopic);const visible=filtered.slice(0,(lifePage+1)*10);visible.forEach(p=>lifePost(p,state,s));if(visible.length<filtered.length)s.append(btn('Показать ещё','btn-outline full',()=>{lifePage++;render();}));
    s.append(h('p','daily-footer-note','Демонстрационные персонажи — вымышленные. Лайки, комментарии и сохранения работают только на этом устройстве.'));lifeBottom(s);
  }
  function lifeBottom(s){const bar=h('nav','life-bottom');append(bar,btn('⌂\nЛента','life-tab'+(lifeView==='feed'?' active':''),()=>{lifeView='feed';render();}),btn('⌕\nПоиск','life-tab',()=>{lifeView='feed';lifeTopic='all';render();toast('Выберите интересующую тему выше');}),btn('＋','life-tab life-add',()=>{lifeView='create';render();}),btn('♡\nСохранено','life-tab',()=>{lifeView='feed';render();toast('Сохранённые публикации отмечены значком 🔖');}),btn('◯\nПрофиль','life-tab'+(lifeView==='mine'?' active':''),()=>{lifeView='mine';render();}));s.append(bar);}
  function renderDashboard(){
    const s=shell();s.classList.add('seif-hub','seif-hub-expanded','seif-classic-home');
    const hero=h('div','seif-hub-hero');append(hero,h('div','seif-hub-shield','◇'),h('h1','','СЕЙФ'),h('p','','Моё пространство. Мои правила.'));s.append(hero);
    // The original, prominent loyalty-card section remains at the top of the home screen.
    const cards=h('section','hub-featured-cards');
    append(cards,append(h('div','hub-section-head'),h('h2','','Моя главная карта'),btn('Все карты →','hub-text-action',()=>go('cards'))));
    if(extras.cards.length){const chosen=[...extras.cards].sort(cardRank)[0];cards.append(cardAccessTile(chosen,true));
      cards.append(h('p','hub-helper','Нажмите на карту, чтобы показать её на кассе.'));}
    else{const empty=btn('','hub-card-placeholder',()=>addLoyaltyFromBrand('other'));
      append(empty,h('span','hub-card-symbol','▤'),h('strong','','Добавить большую карту'),h('small','','Скидочная карта всегда под рукой'),h('span','','＋ Добавить карту'));cards.append(empty);}
    s.append(cards);
    const pass=h('section','hub-passwords');
    append(pass,append(h('div','hub-section-head'),h('h2','','Мои пароли'),btn('Все пароли →','hub-text-action',()=>go('home'))));
    const recent=[...entries].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,3);
    if(recent.length){for(const item of recent){const info=serviceInfo(item.serviceId);const row=btn('','hub-password-row',()=>go('detail:'+item.id));append(row,serviceIcon(item.serviceId),append(h('span','hub-password-name'),h('strong','',item.name||info[1]),h('small','','Защищённая запись')),h('span','','›'));pass.append(row);}}
    else{pass.append(btn('＋ Добавить первый пароль','hub-password-empty',()=>go('new')));}
    s.append(pass);
    s.append(h('h2','hub-modules-title','Мои пространства'));
    const tiles=h('div','seif-hub-grid');
    for(const [icon,title,sub,dest] of [['♙','Мой сейф','Пароли, документы, личное','home'],['▣','Мои расходы','Финансы и платежи','expenses'],['♡','Мой ритм','Привычки, здоровье, жизнь','rhythm'],['♧','Сейф Life','Лента, друзья, фотографии','life']]){
      const t=btn('','seif-hub-tile',()=>{if(dest==='life'){lifeView='feed';lifeTopic='all';}go(dest);});append(t,h('span','hub-icon',icon),h('strong','',title),h('small','',sub));tiles.append(t);
    }s.append(tiles);
    const extra=h('section','classic-home-extras');
    extra.append(h('h2','hub-modules-title','Ещё в СЕЙФЕ'));
    const extraTiles=h('div','seif-hub-grid');
    for(const [ico,name,desc,dest] of [['▤','Все карты','Магазины и коды','cards'],['▣','Мои документы','Важные файлы и фотографии','documents'],['◷','Важные даты','Напоминания и события','reminders'],['⚙','Настройки и сценарии','Мужской, женский, нейтральный','settings']]){
      const t=btn('','seif-hub-tile',()=>go(dest));append(t,h('span','hub-icon',ico),h('strong','',name),h('small','',desc));extraTiles.append(t);
    }extra.append(extraTiles);s.append(extra);
    s.append(h('p','hub-note','Главная карта → пароли → четыре пространства. Личные данные никогда не публикуются автоматически.'));
  }
  function renderLoyaltyCollection(){
    const s=shell();const count=extras.cards.length;
    const title=append(h('div','loyalty-collection-head'),append(h('div',''),h('div','eyebrow','ВСЕ МАГАЗИНЫ В ОДНОМ МЕСТЕ'),h('h1','h1','Мои карты'),h('p','sub',count?'Сохранено карт: '+count+'. Нажмите на карту, чтобы открыть код.':'Добавьте постоянный код карты для использования на кассе.')),
      btn('＋ Карта','btn-primary',()=>addLoyaltyFromBrand('other')));
    s.append(title);
    const search=input('Найти магазин или карту');search.setAttribute('aria-label','Поиск карты');search.autocomplete='off';
    const searchwrap=h('div','search loyalty-search');searchwrap.append(search);s.append(searchwrap);
    const filterBox=h('div','loyalty-filter');let activeFilter='all';
    const filterButtons={};
    for(const [id,text] of [['all','Все карты'],['favorites','★ Избранное']]){
      const b=btn(text,'filter-chip'+(id===activeFilter?' selected':''),()=>{activeFilter=id;refresh();});filterButtons[id]=b;filterBox.append(b);
    }s.append(filterBox);
    const favSection=h('div','favorite-loyalty-section');s.append(favSection);
    const cardsSection=h('div','loyalty-collection-grid');s.append(cardsSection);
    function refresh(){
      for(const [id,b] of Object.entries(filterButtons))b.classList.toggle('selected',activeFilter===id);
      const term=search.value.trim().toLocaleLowerCase('ru');
      const all=[...extras.cards].sort(cardRank);
      const matching=all.filter(x=>[x.name,x.brand,loyaltyBrand(x)[1]].join(' ').toLocaleLowerCase('ru').includes(term));
      const list=activeFilter==='favorites'?matching.filter(x=>x.favorite):matching;
      favSection.replaceChildren();cardsSection.replaceChildren();
      if(!term&&activeFilter==='all'){
        const fav=matching.filter(x=>x.favorite);
        if(fav.length){favSection.append(sectionTitle('★ Избранное · на кассе'));const rail=h('div','cash-rail');for(const item of fav.slice(0,8))rail.append(cardAccessTile(item,true));favSection.append(rail);}
      }
      if(!list.length){
        append(cardsSection,append(h('div','loyalty-empty'),h('div','starter-symbol','▤'),h('h3','',term?'Такой карты нет':activeFilter==='favorites'?'Избранных карт пока нет':'Добавьте первую карту'),h('p','',term?'Измените запрос или добавьте карту.':'Ваши карты появятся здесь, и каждую можно будет открыть одним нажатием.'),btn('＋ Добавить карту','btn-primary',()=>addLoyaltyFromBrand('other'))));
      }else{
        cardsSection.append(sectionTitle(activeFilter==='favorites'?'Избранные карты':'Все сохранённые карты',h('span','section-small',list.length+' шт.')));
        const grid=h('div','cash-main-grid');for(const item of list){
          const wrap=h('div','cash-entry'),top=cardAccessTile(item);
          const footer=h('div','cash-entry-actions');
          const star=iconButton(item.favorite?'★':'☆',item.favorite?'Убрать из избранного':'В избранное',async()=>{
            const ok=await updateCollection('cards',item.id,{favorite:!item.favorite});if(ok)render();});
          const edit=iconButton('✎','Редактировать карту',()=>go('extra:cards:'+item.id));
          append(footer,star,edit);append(wrap,top,footer);grid.append(wrap);
        }cardsSection.append(grid);
      }
    }
    search.addEventListener('input',refresh);refresh();
    const picker=h('section','store-chooser');picker.append(sectionTitle('Быстрый выбор магазина'));
    picker.append(h('p','note','Коснитесь значка магазина: если карта сохранена, её код откроется сразу на весь экран. Если карты нет — предложим её добавить.'));
    const rail=h('div','loyalty-preset-rail');for(const b of LOYALTY_BRANDS){
      const saved=[...extras.cards].filter(x=>loyaltyBrand(x)[0]===b[0]).sort(cardRank);
      const t=h('button','loyalty-preset'+(saved.length?' has-card':''));t.type='button';
      t.setAttribute('aria-label',b[1]+(saved.length?' — открыть код':' — добавить карту'));
      append(t,loyaltyTile({brandId:b[0]}),h('span','',b[1]));
      if(saved.length)t.append(h('small','loyalty-preset-tag','✓ Есть карта'));
      t.addEventListener('click',()=>saved.length?showCard(saved[0]):addLoyaltyFromBrand(b[0]));rail.append(t);
    }picker.append(rail);s.append(picker);
    s.append(h('div','notice-strip','Обычные постоянные штрихкоды и статичные QR можно сохранить. Некоторые сети, включая «Магнит», показывают временные QR: копия такого QR не обновится, для актуального кода понадобится официальный сервис.'));
  }
  function itemSubtitle(k,item){
    if(k==='cards')return (item.brand||'Карта')+' · '+((item.codeType||'code128')==='dynamic'?'Открыть магазин':(item.codeType==='image'?'Фото кода':item.codeType==='qr'?'QR-код':'Штрихкод'));
    if(k==='subscriptions')return (item.amount||'—')+' '+(item.currency||'₽')+' · '+dateHuman(upcomingDate(item));
    if(k==='reminders')return dateHuman(upcomingDate(item))+' · '+dueText(upcomingDate(item));
    if(k==='notes')return (item.body||'').slice(0,55)||'Личная заметка';
    if(k==='documents')return (item.imageData?'📷 Фото · ':'')+(item.kind||'Документ')+(item.dueDate?' · до '+dateHuman(item.dueDate):'');
    return item.account||'Двухфакторный код';
  }
  function renderCollection(k){
    if(k==='cards'){renderLoyaltyCollection();return;}
    const f=FEATURES[k],s=shell();s.append(pageTitle(f.title),h('p','sub',f.subtitle));
    const toolbar=append(h('div','list-toolbar'),btn('＋ '+f.add,'btn-primary',()=>go('extra:'+k+':new')));
    const search=input('Поиск по названию');search.setAttribute('aria-label','Поиск по '+f.title);search.autocomplete='off';toolbar.append(search);s.append(toolbar);
    if(k==='cards'){
      const note=append(h('div','panel loyalty-help'),h('h3','','Ваша коллекция карт'),h('p','note','Выберите магазин, сохраните постоянный номер, статичный QR или фото кода. Для меняющихся QR используйте официальное приложение — подменять такой код нельзя.'));
      const row=h('div','loyalty-preset-rail');for(const b of LOYALTY_BRANDS.slice(0,8)){
        const tile=h('button','loyalty-preset');tile.type='button';append(tile,loyaltyTile({brandId:b[0]}),h('span','',b[1]));tile.addEventListener('click',()=>{preselectedBrand=b[0];go('extra:cards:new');});row.append(tile);
      }note.append(row);s.append(note);
    }
    if(k==='subscriptions')s.append(append(h('div','monthly-spend'),h('span','','В среднем в месяц'),h('strong','',monthlySpend())));
    const list=h('div','collection-list');s.append(list);
    const refresh=()=>{
      list.replaceChildren();const items=[...extras[k]].filter(x=>(x.name||'').toLocaleLowerCase('ru').includes(search.value.trim().toLocaleLowerCase('ru'))).sort((a,b)=> k==='cards' ? Number(!!b.favorite)-Number(!!a.favorite)||(b.updatedAt||0)-(a.updatedAt||0) : (b.updatedAt||0)-(a.updatedAt||0));
      if(!items.length){append(list,append(h('div','empty'),h('div','emoji',f.icon),h('h3','',search.value?'Ничего не найдено':'Здесь пока пусто'),h('p','',search.value?'Попробуйте другое название':f.empty)));return;}
      for(const x of items){const card=h('div','collection-card');
        const detail=append(h('div','grow'),h('strong','',x.name||'Без названия'),h('p','',itemSubtitle(k,x)));
        append(card,k==='cards'?loyaltyTile(x):h('div','collection-icon',f.icon),detail);
        if(k==='cards'){
          card.append(btn('Показать','btn-primary btn-small',()=>showCard(x)));
          card.append(iconButton(x.favorite?'★':'☆',x.favorite?'Убрать из быстрого доступа':'В быстрый доступ',async()=>{const ok=await updateCollection('cards',x.id,{favorite:!x.favorite});if(ok)render();}));
        }
        if(k==='otps')card.append(btn('Код','btn-outline btn-small',()=>showOtp(x)));
        if(k==='documents')card.append(btn('Открыть','btn-outline btn-small',()=>showDocument(x)));
        if(['subscriptions','reminders','documents'].includes(k)&&x.dueDate){const cal=btn('◷','btn-outline btn-small',()=>calendarExport(x,k));cal.title='В календарь';cal.setAttribute('aria-label','Добавить в календарь');card.append(cal);}
        if(k==='reminders' && !x.repeat || k==='reminders' && x.repeat==='none')card.append(btn(x.completed?'↺':'✓','btn-outline btn-small',async()=>{const ok=await updateCollection(k,x.id,{completed:!x.completed});if(ok)render();}));
        card.append(iconButton(x.favorite?'★':'☆',x.favorite?'Убрать с главной':'Показывать на главной',async()=>{
          const ok=await updateCollection(k,x.id,{favorite:!x.favorite});if(ok)go(k);
        }));
        card.append(iconButton('✎','Редактировать',()=>go('extra:'+k+':'+x.id)));
        list.append(card);
      }
    };
    search.addEventListener('input',refresh);refresh();
    if(k==='subscriptions')s.append(h('div','notice-strip','Стоимость вводится вручную. СЕЙФ не подключается к банкам, не получает данные о списаниях и не отменяет подписки автоматически.'));
    if(k==='cards')s.append(h('div','notice-strip','Поддерживаются постоянные Code 128, статичные QR и фото постоянных кодов. Код, который магазин обновляет при каждом открытии, нужно получать в официальном приложении. Показанный здесь код может не приниматься кассой — сначала проверьте на тестовой карте.'));
    if(k==='documents')s.append(h('div','notice-strip','Фото сжимаются и шифруются локально. Для важных оригиналов обязательно храните отдельную резервную копию. До независимого аудита не загружайте паспорт и особо чувствительные документы.'));
    if(k==='reminders')s.append(h('div','notice-strip','СЕЙФ покажет события при открытии. Для уведомлений даже при закрытом приложении используйте кнопку «В календарь» внутри записи.'));
    if(k==='otps')s.append(h('div','notice-strip','Тестовый генератор TOTP. Для важных аккаунтов пока используйте отдельный проверенный аутентификатор и сохраните резервные коды вне СЕЙФА.'));
  }
  const FIELD_SETS={
    cards:[['name','Название карты','text','Например, Магнит Плюс'],['brand','Магазин','text','Название сети'],['number','Номер карты / штрихкода','text','Ввести точные символы с карты'],['codeType','Что показывать на кассе','select',[['code128','Штрихкод (постоянный Code 128)'],['qr','QR (только статичный, с исходным содержимым)'],['image','Фото постоянного кода'],['dynamic','Меняющийся QR (открыть магазин)']]],['qrPayload','Содержимое статичного QR-кода','textarea','Вставьте точные данные QR, не скриншот'],['officialUrl','Сайт магазина (для меняющегося QR)','url','https://...'],['note','Комментарий','textarea','Для себя']],
    subscriptions:[['name','Название подписки','text','Например, Музыка'],['amount','Стоимость','number','299'],['currency','Валюта','select',[['₽','₽'],['€','€'],['$','$']]],['dueDate','Дата ближайшего списания','date',''],['cycle','Периодичность','select',[['monthly','Каждый месяц'],['yearly','Каждый год'],['once','Один раз']]],['remindDays','Напоминать за (дней)','number','3'],['note','Комментарий','textarea','']],
    reminders:[['name','Название события','text','Например, продлить страховку'],['dueDate','Дата','date',''],['repeat','Повторять','select',[['none','Не повторять'],['monthly','Каждый месяц'],['yearly','Каждый год']]],['remindDays','За сколько дней напомнить','number','3'],['note','Заметка','textarea','']],
    documents:[['name','Название документа','text','Например, ОСАГО'],['kind','Тип','text','Страховка, полис, чек, договор'],['dueDate','Действует до (необязательно)','date',''],['note','Заметка','textarea','']],
    notes:[['name','Заголовок','text','Например, важные контакты'],['body','Содержание','textarea','Текст заметки']],
    otps:[['name','Название сервиса','text','Например, тестовый аккаунт'],['account','Логин (необязательно)','text','example@test.invalid'],['secret','Секретный ключ Base32','text','JBSWY3DPEHPK3PXP']]
  };
  // Crop codes on-device: BarcodeDetector if supported, otherwise estimate the
  // high-contrast area. User can drag/resize the crop in the verification screen.
  function clamp(n,min,max){return Math.min(max,Math.max(min,n));}
  function normalizeRect(r){
    return {x:clamp(r.x,0,.95),y:clamp(r.y,0,.95),w:clamp(r.w,.05,1-clamp(r.x,0,.95)),h:clamp(r.h,.05,1-clamp(r.y,0,.95))};
  }
  function fallbackCodeCrop(img){
    const scale=Math.min(1,650/Math.max(img.naturalWidth,img.naturalHeight));
    const cv=document.createElement('canvas');cv.width=Math.max(1,Math.round(img.naturalWidth*scale));cv.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const cx=cv.getContext('2d',{willReadFrequently:true});if(!cx)return{x:.08,y:.2,w:.84,h:.6};
    cx.drawImage(img,0,0,cv.width,cv.height);
    const pixels=cx.getImageData(0,0,cv.width,cv.height).data;
    const W=cv.width,H=cv.height,T=12,cols=Math.ceil(W/T),rows=Math.ceil(H/T);
    const strong=new Uint8Array(cols*rows);
    const ink=new Uint8Array(W*H),white=new Uint8Array(W*H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const a=4*(y*W+x),gray=(pixels[a]*299+pixels[a+1]*587+pixels[a+2]*114)/1000;
      ink[y*W+x]=gray<145?1:0;white[y*W+x]=gray>210?1:0;
    }
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
      const x0=c*T,y0=r*T,x1=Math.min(W,x0+T),y1=Math.min(H,y0+T);
      let black=0,bright=0,edges=0,count=0;
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const ix=y*W+x;black+=ink[ix];bright+=white[ix];count++;
        if(x+1<x1)edges+=ink[ix]!==ink[ix+1]?1:0;
        if(y+1<y1)edges+=ink[ix]!==ink[ix+W]?1:0;
      }
      const density=edges/(2*count);
      if(black/count>.12&&bright/count>.3&&density>.055)strong[r*cols+c]=1;
    }
    // 8-connected components of text/QR-like tiles. Prefer the largest dense block.
    const seen=new Uint8Array(strong.length);let best=null;
    for(let i=0;i<strong.length;i++){
      if(!strong[i]||seen[i])continue;
      const queue=[i];seen[i]=1;let minX=cols,maxX=0,minY=rows,maxY=0;
      for(let k=0;k<queue.length;k++){
        const ix=queue[k],r=Math.floor(ix/cols),c=ix%cols;
        minX=Math.min(minX,c);maxX=Math.max(maxX,c);minY=Math.min(minY,r);maxY=Math.max(maxY,r);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          const xx=c+dx,yy=r+dy;
          if(xx<0||yy<0||xx>=cols||yy>=rows)continue;
          const ni=yy*cols+xx;if(strong[ni]&&!seen[ni]){seen[ni]=1;queue.push(ni);}
        }
      }
      const bW=(maxX-minX+1)*T,bH=(maxY-minY+1)*T;
      if(queue.length>=10&&bW>24&&bH>20){
        const score=queue.length*Math.min(1,(bW*bH)/1600);
        if(!best||score>best.score)best={score,x:minX*T,y:minY*T,w:bW,h:bH};
      }
    }
    if(!best||best.score<20)return{x:.06,y:.1,w:.88,h:.8};
    const m=Math.max(4,Math.min(best.w,best.h)*.035);
    const x=clamp(best.x-m,0,W),y=clamp(best.y-m,0,H);
    return normalizeRect({x:x/W,y:y/H,w:(Math.min(W,best.x+best.w+m)-x)/W,h:(Math.min(H,best.y+best.h+m)-y)/H});
  }
  async function guessCodeCrop(img){
    if(typeof window.BarcodeDetector==='function'){
      try{
        const detector=new window.BarcodeDetector({formats:['qr_code','code_128','ean_13','ean_8','upc_a','pdf417','data_matrix']});
        const found=await detector.detect(img);
        if(found.length){const bounds=found.sort((a,b)=>b.boundingBox.width*b.boundingBox.height-a.boundingBox.width*a.boundingBox.height)[0].boundingBox;
          const m=Math.max(10,Math.max(bounds.width,bounds.height)*.07);
          const x=clamp(bounds.x-m,0,img.naturalWidth),y=clamp(bounds.y-m,0,img.naturalHeight);
          return normalizeRect({x:x/img.naturalWidth,y:y/img.naturalHeight,w:(Math.min(img.naturalWidth,bounds.x+bounds.width+m)-x)/img.naturalWidth,h:(Math.min(img.naturalHeight,bounds.y+bounds.height+m)-y)/img.naturalHeight});
        }
      }catch(_err){} // Local, manual crop remains available.
    }
    return fallbackCodeCrop(img);
  }
  function compressedCrop(img,rect){
    // Critical bug fixed: canvas JPEG data URIs start with
    // "data:image/jpeg;base64,", never "data:image/jpeg,". The old check
    // rejected *every* valid JPEG even when the selected code was tiny.
    // Prefer lossless PNG for crisp QR edges, JPEG for dense photographs.
    // Fallback progressively scales to keep mobile IndexedDB writes small.
    const w=img.naturalWidth*rect.w,h=img.naturalHeight*rect.h;
    if(!Number.isFinite(w)||!Number.isFinite(h)||w<10||h<10)throw Error('Выделите весь код внутри рамки.');
    const sizes=[1250,1050,880,740,620,510,410,330,250];
    const qualities=[.93,.91,.88,.86,.83,.79,.74,.67,.58];
    for(let attempt=0;attempt<sizes.length;attempt++){
      const factor=Math.min(1,sizes[attempt]/Math.max(w,h));
      const cv=document.createElement('canvas');
      cv.width=Math.max(1,Math.round(w*factor));cv.height=Math.max(1,Math.round(h*factor));
      const cx=cv.getContext('2d');if(!cx)throw Error('Не удалось обработать фотографию');
      try{
        cx.fillStyle='#ffffff';cx.fillRect(0,0,cv.width,cv.height);
        cx.imageSmoothingEnabled=true;cx.imageSmoothingQuality='high';
        cx.drawImage(img,img.naturalWidth*rect.x,img.naturalHeight*rect.y,w,h,0,0,cv.width,cv.height);
        // PNG keeps black-and-white QR modules sharp; try it first at high resolution.
        if(attempt<=4){
          const png=cv.toDataURL('image/png');
          if(png.startsWith('data:image/png;base64,')&&png.length<=MAX_IMAGE_DATA_CHARS)return png;
        }
        const jpeg=cv.toDataURL('image/jpeg',qualities[attempt]);
        if(jpeg.startsWith('data:image/jpeg;base64,')&&jpeg.length<=MAX_IMAGE_DATA_CHARS)return jpeg;
      }finally{cv.width=1;cv.height=1;}
    }
    throw Error('Не удалось сохранить изображение. Выделите только код и попробуйте ещё раз.');
  }
  function openCropTool(file,onDone){
    const blobURL=URL.createObjectURL(file);temporaryImageURLs.add(blobURL);
    const img=new Image();img.decoding='async';img.src=blobURL;
    img.onload=async()=>{
      try {
      if(phase!=='unlocked'){revokeImageURL(blobURL);return;}
      if(img.naturalWidth>8500||img.naturalHeight>8500||img.naturalWidth*img.naturalHeight>22000000){revokeImageURL(blobURL);toast('Фото слишком большое. Сделайте скриншот кода и загрузите его вместо исходного фото.',true);return;}
      const body=h('div','crop-body');body.append(h('p','crop-subtitle','СЕЙФ выделяет код автоматически. Если рамка неточная, передвиньте её пальцем; потяните за угол, чтобы изменить размер.'));
      const stage=h('div','crop-stage'),photo=h('img','crop-photo');photo.src=blobURL;photo.alt='Фото для обрезки';
      // iOS screenshots are tall. The former max-height + object-fit letterboxed
      // the image within a wider element: the visible frame and saved crop differed.
      // Set exact image aspect ratio so the green selection matches source pixels.
      const fitStage=()=>{
        const maxWidth=Math.max(180,Math.min(570,window.innerWidth-72));
        const maxHeight=Math.max(230,window.innerHeight*.48);
        const factor=Math.min(maxWidth/img.naturalWidth,maxHeight/img.naturalHeight);
        stage.style.width=Math.round(img.naturalWidth*factor)+'px';
        stage.style.height=Math.round(img.naturalHeight*factor)+'px';
      };
      fitStage();
      const selection=h('div','crop-selection');selection.append(h('div','crop-handle'));
      const stageWrap=h('div','crop-stage-wrap');stage.append(photo,selection);stageWrap.append(stage);body.append(stageWrap);
      const status=h('p','crop-subtitle','Проверьте, чтобы весь код с белыми полями остался внутри рамки.');body.append(status);
      let rect={x:.05,y:.05,w:.9,h:.9};
      const draw=()=>{selection.style.left=(rect.x*100)+'%';selection.style.top=(rect.y*100)+'%';selection.style.width=(rect.w*100)+'%';selection.style.height=(rect.h*100)+'%';};
      const close=()=>{window.removeEventListener('resize',fitStage);popup.close();revokeImageURL(blobURL);};
      const popup=overlay('Обрезать код',body);
      popup.bg.classList.add('crop-backdrop');
      window.addEventListener('resize',fitStage);
      const actions=h('div','crop-actions');
      append(actions,btn('Авторамка','btn-outline btn-small',async()=>{rect=await guessCodeCrop(img);draw();}),btn('Всё фото','btn-outline btn-small',()=>{rect={x:0,y:0,w:1,h:1};draw();}));
      body.append(actions);
      let active=null;
      selection.addEventListener('pointerdown',e=>{
        if(e.button!==undefined&&e.button!==0)return;
        e.preventDefault();selection.setPointerCapture(e.pointerId);
        active={pointer:e.pointerId,x:e.clientX,y:e.clientY,rect:{...rect},resize:e.target.classList?.contains('crop-handle')};
      });
      selection.addEventListener('pointermove',e=>{
        if(!active||e.pointerId!==active.pointer)return;
        e.preventDefault();const r=stage.getBoundingClientRect();const dx=(e.clientX-active.x)/r.width,dy=(e.clientY-active.y)/r.height;
        if(active.resize){rect=normalizeRect({...active.rect,w:clamp(active.rect.w+dx,.07,1-active.rect.x),h:clamp(active.rect.h+dy,.07,1-active.rect.y)});}
        else rect={...active.rect,x:clamp(active.rect.x+dx,0,1-active.rect.w),y:clamp(active.rect.y+dy,0,1-active.rect.h)};
        draw();
      });
      for(const type of ['pointerup','pointercancel','lostpointercapture'])selection.addEventListener(type,()=>{active=null;});
      body.append(btn('✓ Использовать этот фрагмент','btn-primary full',()=>{
        try{const data=compressedCrop(img,rect);onDone(data);close();}
        catch(err){status.textContent=err.message||'Не удалось обрезать снимок';toast(status.textContent,true);}
      }));
      body.append(btn('Отмена','btn-outline full',close));
      // Close on outside tap also revokes the object URL.
      popup.bg.addEventListener('click',ev=>{if(ev.target===popup.bg){window.removeEventListener('resize',fitStage);revokeImageURL(blobURL);}});
      // Paint a safe initial rectangle immediately; detection may be unavailable
      // or expensive on a mobile device. A failure must not close the editor.
      draw();
      try{rect=await guessCodeCrop(img);draw();}catch(_err){status.textContent='Автообрезка недоступна. Передвиньте рамку вручную.';}
      } catch (_err) {
        revokeImageURL(blobURL);
        toast('Не удалось обработать фото. Попробуйте другой скриншот.',true);
      }
    };
    img.onerror=()=>{revokeImageURL(blobURL);toast('Не удалось открыть фото. Выберите PNG или JPEG.',true);};
  }
  // Photos are processed on this device, with bounded size before AES-GCM encryption.
  async function compressDocumentImage(file){
    const url=URL.createObjectURL(file);
    try{
      const img=await new Promise((resolve,reject)=>{
        const element=new Image();element.onload=()=>resolve(element);
        element.onerror=()=>reject(new Error('Не удалось прочитать снимок. Сохраните его как JPEG или PNG.'));
        element.src=url;
      });
      if(!img.naturalWidth||!img.naturalHeight)throw Error('Пустое изображение');
      for(const maxSide of [1600,1400,1200,1000,850,700,550,400]){
        const factor=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
        const cv=document.createElement('canvas');
        cv.width=Math.max(1,Math.round(img.naturalWidth*factor));cv.height=Math.max(1,Math.round(img.naturalHeight*factor));
        const cx=cv.getContext('2d');if(!cx)throw Error('Нет доступа к обработке фото');
        cx.fillStyle='#fff';cx.fillRect(0,0,cv.width,cv.height);
        cx.imageSmoothingEnabled=true;cx.imageSmoothingQuality='high';
        cx.drawImage(img,0,0,cv.width,cv.height);
        const data=cv.toDataURL('image/jpeg',.82);
        cv.width=1;cv.height=1;
        if(data.startsWith('data:image/jpeg;base64,')&&data.length<=MAX_IMAGE_DATA_CHARS)return data;
      }
      throw Error('Не удалось сжать фото. Попробуйте сделать скриншот меньшего размера.');
    }finally{URL.revokeObjectURL(url);}
  }
  function showDocument(item){
    if(phase!=='unlocked')return;
    const content=h('div','document-viewer');
    if(item.imageData){const im=h('img','document-viewer-photo');im.src=item.imageData;im.alt=item.name||'Важный документ';content.append(im);}
    else content.append(h('p','note','Фото пока не прикреплено.'));
    if(item.kind)content.append(h('p','note','Тип: '+item.kind));
    if(item.dueDate)content.append(h('p','note','Действует до: '+dateHuman(item.dueDate)));
    if(item.note)content.append(h('p','note',item.note));
    const pop=overlay(item.name||'Важный документ',content);
    append(content,btn('✎ Редактировать','btn-outline full',()=>{pop.close();go('extra:documents:'+item.id);}),btn('Закрыть','btn-primary full',pop.close));
  }
  function renderExtraEditor(){
    const parts=view.split(':'),k=parts[1],id=parts.slice(2).join(':');if(!FEATURES[k]){go('dashboard');return;}
    const old=id==='new'?null:extras[k].find(x=>x.id===id);if(id!=='new'&&!old){go(k);return;}
    const s=shell();s.append(append(h('div','pagehead'),btn('← Назад','btn-outline btn-small',()=>go(k)),h('h2','',old?'Редактирование':'Новая запись')));
    // These values must live in the editor's scope, not inside if(k==='cards').
    // The old submit handler referenced block-scoped imageData / imageInput and
    // failed with ReferenceError whenever a customer tried to save a photo.
    let imageData=old?.imageData||'';
    let imageInput=null;
    const form=h('form','panel entry-form');form.noValidate=true;form.append(h('h3','',FEATURES[k].title));
    const controls={},grid=h('div','formgrid');
    for(const [name,label,kind,hint] of FIELD_SETS[k]){
      let node;
      if(kind==='textarea'){node=h('textarea','field-input');node.rows=k==='notes'?9:3;node.placeholder=hint;}
      else if(kind==='select'){node=h('select','field-input');for(const [v,t] of hint){const opt=h('option','',t);opt.value=v;node.append(opt);}}
      else{node=input(kind==='date'?'':hint,name==='secret'?'password':kind==='number'?'number':kind);}
      if(kind==='number'){node.min='0';node.max=name==='remindDays'?'365':'1000000000';node.step=name==='amount'?'0.01':'1';}
      node.value=old?.[name]??(name==='dueDate'&&k!=='documents'?todayISO():name==='remindDays'?'3':name==='cycle'?'monthly':name==='repeat'?'none':'');
      if(name==='number'||name==='secret'){node.autocomplete='off';node.spellcheck=false;}
      node.maxLength=(name==='body'?15000:3000);
      controls[name]=node;
      if(name==='secret'){
        const visibility=btn('Показать','btn-outline btn-small',()=>{const show=node.type==='password';node.type=show?'text':'password';visibility.textContent=show?'Скрыть':'Показать';});
        grid.append(field(label,append(h('div','passwordline'),node,visibility),true));
      }else grid.append(field(label,node,kind==='textarea'));
    }
    form.append(grid);
    if(k==='cards'){
      const preset=old?loyaltyBrand(old):LOYALTY_BRANDS.find(x=>x[0]===(preselectedBrand||''));preselectedBrand=null;
      const presetBox=h('div','preset-section');presetBox.append(h('div','field-label','БЫСТРЫЙ ВЫБОР МАГАЗИНА'));
      const row=h('div','loyalty-preset-rail');let brandId=old?.brandId||preset?.[0]||'other';
      const selectBrand=(b)=>{
        brandId=b[0];controls.brand.value=b[1]==='Другая карта'?'':b[1];
        if(!old||!controls.name.value||controls.name.value===old.name)controls.name.value=b[1]==='Другая карта'?'':b[1];
        controls.officialUrl.value=b[3]||'';
        // For Magnit avoid implying a static Code 128 is a working substitute for rotating QR.
        if(!old){controls.codeType.value=b[0]==='magnit'?'dynamic':'code128';refreshCodeMode();}
        for(const el of row.children)el.classList.toggle('chosen',el.dataset.id===b[0]);
      };
      for(const b of LOYALTY_BRANDS){const el=h('button','loyalty-preset');el.type='button';el.dataset.id=b[0];append(el,loyaltyTile({brandId:b[0]}),h('span','',b[1]));el.addEventListener('click',()=>selectBrand(b));row.append(el);}
      presetBox.append(row);form.insertBefore(presetBox,grid);
      const modeHint=h('div','warning');modeHint.setAttribute('aria-live','polite');
      const formatRow=controls.codeType.closest('label');
      const qrRow=controls.qrPayload.closest('label');
      const numberRow=controls.number.closest('label');
      const urlRow=controls.officialUrl.closest('label');
      const imageRow=h('div','field wide card-image-upload');
      const imageTitle=h('div','field-label','ФОТО ШТРИХКОДА ИЛИ QR-КОДА');
      imageInput=h('input','hidden');imageInput.type='file';imageInput.accept='image/*';imageInput.setAttribute('aria-label','Загрузить фотографию карты');
      const imagePreview=h('div','card-image-preview');
      const updatePreview=()=>{
        imagePreview.replaceChildren();
        if(imageData){
          const img=h('img','card-image-thumb');img.src=imageData;img.alt='Обрезанный код';
          const ready=h('strong','image-ready-text','✓ Фото выбрано, но ещё НЕ сохранено');
          const savePhoto=btn('✓ Сохранить фото карты','btn-primary full save-photo-cta',()=>{
            if(typeof form.requestSubmit==='function')form.requestSubmit();else form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
          });
          imagePreview.append(img,ready,savePhoto,h('p','photo-save-hint','Нажмите эту кнопку — фотография будет зашифрована и карта появится в разделе «Карты».'));
        }else imagePreview.append(h('p','note','Фото пока не загружено. Можно выбрать снимок экрана с кодом.'));
      };
      updatePreview();
      const clearImage=btn('Удалить фото','btn-outline btn-small',()=>{imageData='';imageInput.value='';updatePreview();});
      const addImage=btn('📷 Добавить фото или скриншот','btn-primary full',()=>{startPhotoPicker();try{imageInput.click();}catch(_err){finishPhotoPicker();toast('Не удалось открыть медиатеку',true);}});
      const imageHelp=h('p','note','После выбора фото СЕЙФ предложит обрезанный код. Важно: фотография ещё не сохранена! Нажмите внизу «Сохранить карту и открыть». Временные QR магазинов не обновляются автоматически.');
      append(imageRow,imageTitle,addImage,imageInput,imagePreview,clearImage,imageHelp);form.append(imageRow);
      imageInput.addEventListener('change',()=>{
        const file=imageInput.files?.[0];
        // On iPhone the native photo chooser can stay open longer than the normal
        // background grace; reset the clock only for this explicitly initiated flow.
        finishPhotoPicker();
        imageInput.value='';
        if(!file || phase!=='unlocked')return;
        if(!/^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type||'') &&
           !/\.(png|jpe?g|webp|heic|heif)$/i.test(file.name||'')){
          toast('Выберите фотографию: PNG, JPEG или HEIC',true);return;
        }
        if(file.size>12000000){toast('Фото больше 12 МБ. Сделайте скриншот кода и загрузите его.',true);return;}
        try{openCropTool(file,data=>{
          if(phase!=='unlocked')return;
          imageData=data;
          controls.codeType.value='image';refreshCodeMode();updatePreview();
          toast('Фотография готова. Теперь нажмите «Сохранить карту и открыть».');
        });}catch(_err){toast('Не удалось открыть обрезку. Попробуйте другой снимок.',true);}
      });
      const refreshCodeMode=()=>{
        const mode=controls.codeType.value||'code128';
        qrRow.hidden=mode!=='qr';numberRow.hidden=!['code128','dynamic'].includes(mode);urlRow.hidden=mode!=='dynamic';imageRow.hidden=false;
        modeHint.textContent=mode==='qr'
          ?'Вставьте именно исходное содержимое статичного QR-кода. Если есть только картинка с постоянным кодом — выберите «Фото постоянного кода».'
          :mode==='image'
          ?'Выберите скриншот или фотографию кода. Мы предложим автообрезку и сохраним фото зашифрованным. Временный код может перестать работать.'
          :mode==='dynamic'
          ?'Если код магазина меняется, СЕЙФ не сможет выпустить действующий QR без доступа к системе магазина. Мы сделаем кнопку перехода на официальный сайт или в приложение.'
          :'Code 128 можно построить из точного номера, только если именно этот формат принимает магазин. Не все QR-карты поддерживают такой штрихкод.';
      };
      controls.codeType.addEventListener('change',refreshCodeMode);
      controls.codeType.value=old?.codeType||'code128';
      if(!old&&preset&&preset[0]!=='other')selectBrand(preset);
      else for(const el of row.children)el.classList.toggle('chosen',el.dataset.id===brandId);
      refreshCodeMode();form.append(modeHint);
      form.dataset.loyaltyBrandId=brandId;
      // Capture final selected tile even after future edits.
      form.addEventListener('submit',()=>{form.dataset.loyaltyBrandId=brandId;},true);
    }
    if(k==='documents'){
      const imageRow=h('div','field wide document-image-upload');
      const imagePreview=h('div','document-image-preview');
      const preview=()=>{
        imagePreview.replaceChildren();
        if(imageData){const im=h('img','document-image-thumb');im.src=imageData;im.alt='Предпросмотр документа';
          imagePreview.append(im,h('p','note','Фото подготовлено. Для сохранения нажмите «Добавить в СЕЙФ» ниже.'));}
        else imagePreview.append(h('p','note','Можно добавить фотографию, скриншот или чек. Пока только изображения PNG, JPEG, WebP, HEIC (если iPhone умеет прочитать его).'));
      };
      imageInput=h('input','hidden');imageInput.type='file';imageInput.accept='image/*';
      const choose=btn('📷 Сфотографировать или выбрать файл','btn-primary full',()=>{startPhotoPicker();imageInput.click();});
      const remove=btn('Удалить фотографию','btn-outline btn-small',()=>{imageData='';imageInput.value='';preview();});
      imageInput.addEventListener('change',async()=>{
        const file=imageInput.files?.[0];finishPhotoPicker();imageInput.value='';
        if(!file||phase!=='unlocked')return;
        if(file.size>20000000){toast('Фото больше 20 МБ. Выберите скриншот меньшего размера.',true);return;}
        if(!/^image\//.test(file.type||'')&&!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name||'')){toast('Выберите именно изображение документа.',true);return;}
        try{const data=await compressDocumentImage(file);if(phase!=='unlocked')return;imageData=data;preview();toast('Фото готово. Нажмите «Добавить в СЕЙФ» для сохранения.');}
        catch(err){toast(err?.message||'Не удалось обработать фото. Попробуйте скриншот.',true);}
      });
      append(imageRow,h('div','field-label','ФОТО ИЛИ СКРИНШОТ ДОКУМЕНТА'),choose,imageInput,imagePreview,remove,
        h('p','note','Изображение будет зашифровано вместе с остальными записями. СЕЙФ — тестовый продукт: храните оригиналы отдельно.'));
      form.append(imageRow);preview();
    }
    if(k==='otps')form.append(h('p','note','Секреты 2FA требуют особой защиты. В тестовой версии используйте только учебные ключи. Приложение не сканирует QR и не передаёт ключи по сети.'));
    if(k==='subscriptions'||k==='reminders')form.append(h('p','note','Напоминания внутри приложения; для системных уведомлений после сохранения скачайте событие календаря.'));
    // Explicit, encrypted favorite flag for cards, dates, subscriptions, notes,
    // documents, and 2FA. Password records already have their own star toggle.
    const pinLabel=h('label','pin-control');
    const pinCheckbox=h('input','pin-checkbox');pinCheckbox.type='checkbox';pinCheckbox.checked=!!old?.favorite;
    append(pinLabel,pinCheckbox,append(h('span','pin-control-copy'),h('strong','','★ На главную'),h('small','','Отмечайте то, чем пользуетесь каждый день. Можно изменить позже.')));
    form.append(pinLabel);
    const inlineSaveStatus=h('p','save-inline-status');inlineSaveStatus.setAttribute('role','status');inlineSaveStatus.setAttribute('aria-live','polite');
    form.append(inlineSaveStatus);
    const submit=btn(old?'Сохранить изменения':k==='cards'?'✓ Сохранить карту и открыть':'Добавить в СЕЙФ','btn-primary full',null,'submit');form.append(submit);
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();const payload={};for(const [name,node] of Object.entries(controls))payload[name]=node.value.trim();
      if(k==='cards'&&!payload.name){const picked=loyaltyBrand({brandId:form.dataset.loyaltyBrandId});payload.name=picked[0]==='other'?'':picked[1];}
      if(!payload.name){inlineSaveStatus.textContent='Укажите название записи';toast('Введите название записи',true);controls.name.focus();return;}
      if(k==='cards'){
        const mode=imageData?'image':(payload.codeType||'code128');
        payload.codeType=mode;
        if(mode==='code128'&&!code128(payload.number)){toast('Для Code 128 введите 1–64 латинских символа, цифры или знаки. Можно выбрать QR или меняющийся код.',true);controls.number.focus();return;}
        if(mode==='qr'){
          if(!payload.qrPayload || encode.encode(payload.qrPayload).length>160){toast('Введите содержимое статичного QR-кода (до 160 байт).',true);controls.qrPayload.focus();return;}
          try{makeQR(payload.qrPayload);}catch(_err){toast('Не получилось создать QR из введённых данных',true);return;}
        }
        if(mode==='image'&&!imageData){inlineSaveStatus.textContent='Сначала загрузите фото кода';toast('Выберите изображение постоянного кода',true);imageInput?.focus();return;}
        if(mode==='dynamic'&&!approvedStoreUrl(payload.officialUrl)){toast('Укажите ссылку на официальный сайт магазина (https://...).',true);controls.officialUrl.focus();return;}
        if(mode==='image')payload.imageData=imageData;else payload.imageData='';
        payload.brandId=form.dataset.loyaltyBrandId||brandId||'other';
        if(!payload.brand?.trim())payload.brand=loyaltyBrand({brandId:payload.brandId})[1];
      }
      if(k==='documents')payload.imageData=imageData;
      if(k==='subscriptions' && (!payload.dueDate||!Number.isFinite(Number(payload.amount))||Number(payload.amount)<0||payload.amount==='')){toast('Укажите стоимость и дату списания',true);return;}
      if(k==='reminders'&&!payload.dueDate){toast('Укажите дату',true);return;}
      if(k==='notes'&&!payload.body){toast('Введите текст заметки',true);return;}
      if(k==='otps'&&!validSecret(payload.secret)){toast('Введите корректный Base32-ключ (минимум 16 символов)',true);return;}
      if(['subscriptions','reminders'].includes(k)){if(Number(payload.remindDays)>365||Number(payload.remindDays)<0){toast('Количество дней должно быть от 0 до 365',true);return;}}
      const record={...old,...payload,favorite:pinCheckbox.checked,id:old?.id||idNew(),createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
      if(k==='reminders')record.completed=!!old?.completed;
      submit.disabled=true;submit.textContent='Шифруем и сохраняем…';inlineSaveStatus.textContent='Сохраняем зашифрованную запись…';
      const newItems=old?extras[k].map(x=>x.id===record.id?record:x):[...extras[k],record];
      let ok=false;
      try{ok=await commit(entries,{...extras,[k]:newItems});}
      catch(err){console.warn('Vault save failed',err?.name||'error');toast('Не удалось сохранить запись. Попробуйте ещё раз.',true);}
      if(ok){
        go(k);
        if(k==='cards'){
          toast('Карта зашифрована и сохранена');
          const saved=extras.cards.find(x=>x.id===record.id);
          if(saved)showCard(saved); // confirm by showing the saved image full screen
        }
      }
      else{submit.disabled=false;submit.textContent=old?'Сохранить изменения':k==='cards'?'✓ Сохранить карту и открыть':'Добавить в СЕЙФ';inlineSaveStatus.textContent='Не удалось сохранить запись. Проверьте свободное место и повторите.';}
    });
    s.append(form);
    if(old){
      if(k==='cards')s.append(btn('▥ Открыть карту','btn-outline full',()=>showCard(old)));
      if(k==='otps')s.append(btn('✥ Показать код','btn-outline full',()=>showOtp(old)));
      if((k==='subscriptions'||k==='reminders'||k==='documents')&&old.dueDate)s.append(btn('◷ В календарь (.ics)','btn-outline full',()=>calendarExport(old,k)));
      s.append(append(h('div','dangerzone'),h('strong','','Удаление записи'),h('p','note','Удаление нельзя отменить. Для восстановления нужна старая зашифрованная резервная копия.'),btn('Удалить','btn-danger btn-small',async()=>{
        if(!confirm('Удалить «'+old.name+'»?'))return;
        const ok=await commit(entries,{...extras,[k]:extras[k].filter(x=>x.id!==old.id)});if(ok)go(k);
      })));
    }
  }
  async function updateCollection(k,id,delta){return commit(entries,{...extras,[k]:extras[k].map(x=>x.id===id?{...x,...delta,updatedAt:Date.now()}:x)});}
  // Code 128B, with checksum and full termination sequence, rendered locally as SVG.
  const C128=['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
  function code128(text){
    if(!text||text.length>64||!(/^[\x20-\x7E]+$/).test(text))return null;
    const codes=[104];let sum=104;
    for(let i=0;i<text.length;i++){const code=text.charCodeAt(i)-32;codes.push(code);sum+=(i+1)*code;}
    codes.push(sum%103,106);
    const patterns=codes.map(code=>C128[code]);let pos=12;const parts=[];
    for(const sequence of patterns){for(let i=0;i<sequence.length;i++){
      const w=Number(sequence[i]);if(i%2===0)parts.push({x:pos,w});pos+=w;
    }}
    const xmlns='http://www.w3.org/2000/svg';const svg=document.createElementNS(xmlns,'svg');svg.setAttribute('viewBox',`0 0 ${pos+12} 100`);svg.setAttribute('role','img');svg.setAttribute('aria-label','Штрихкод Code 128');svg.classList.add('barcode-svg');
    const bg=document.createElementNS(xmlns,'rect');bg.setAttribute('width','100%');bg.setAttribute('height','100%');bg.setAttribute('fill','#fff');svg.append(bg);
    for(const bar of parts){const rect=document.createElementNS(xmlns,'rect');rect.setAttribute('x',bar.x);rect.setAttribute('y','7');rect.setAttribute('width',bar.w);rect.setAttribute('height','84');rect.setAttribute('fill','#121824');svg.append(rect);}
    return svg;
  }
  // QR library is vendored in qr-local.js and runs on-device, never over an API.
  function makeQR(content){
    const bytes=encode.encode(content||'');
    if(!bytes.length||bytes.length>160||typeof window.SEIF_QR!=='function')throw Error('Нет данных для QR');
    const qr=new window.SEIF_QR(0,0); // ECC M
    // Existing QR8bitByte implementation expects a binary / Latin-1 string.
    let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
    qr.addData(binary);qr.make();
    const n=qr.getModuleCount(),pad=4,dimension=n+2*pad;
    const xmlns='http://www.w3.org/2000/svg',svg=document.createElementNS(xmlns,'svg');
    svg.setAttribute('viewBox',`0 0 ${dimension} ${dimension}`);svg.setAttribute('role','img');
    svg.setAttribute('aria-label','Статичный QR-код карты');svg.setAttribute('shape-rendering','crispEdges');svg.classList.add('qr-svg');
    const bg=document.createElementNS(xmlns,'rect');bg.setAttribute('width','100%');bg.setAttribute('height','100%');bg.setAttribute('fill','#fff');svg.append(bg);
    let d='';for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.isDark(r,c))d+=`M${c+pad},${r+pad}h1v1h-1z`;
    const dots=document.createElementNS(xmlns,'path');dots.setAttribute('d',d);dots.setAttribute('fill','#101010');svg.append(dots);return svg;
  }
  function showCard(item){
    const mode=item.codeType||'code128',b=loyaltyBrand(item);
    const body=h('div','stack scanner-content'),head=h('div','scanner-head');
    append(head,loyaltyTile(item,true),append(h('div',''),h('div','scanner-brand',item.brand||b[1]),h('h2','scanner-title',item.name||'Моя карта')));
    body.append(head);
    if(mode==='image'){
      if(item.imageData&&/^data:image\/(?:png|jpeg|webp);base64,/.test(item.imageData)){
        const holder=h('div','scanner-white scanner-image');const img=h('img','scanner-picture');img.src=item.imageData;img.alt='Фото постоянного кода карты';holder.append(img);body.append(holder);
        body.append(h('div','scanner-caption','ФОТО КОДА · НЕ ОБНОВЛЯЕТСЯ'));
      }else body.append(h('div','warning','Фото не найдено. Отредактируйте карту.'));
      body.append(h('div','scanner-notice','Снимок экрана не обновляется автоматически. Если QR магазина временный, откройте оригинальное приложение — старый код может быть недействительным.'));
    } else if(mode==='dynamic'){
      body.append(h('div','scanner-notice','Этот QR-код создаётся магазином и может меняться. СЕЙФ не может воспроизвести его по номеру карты.'));
      const url=approvedStoreUrl(item.officialUrl)||b[3];
      if(url)body.append(btn('↗ Открыть магазин','btn-primary full',()=>{const a=h('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.click();}));
      else body.append(h('p','note','Откройте оригинальное приложение магазина, чтобы показать действующий код.'));
      if(item.number)body.append(h('div','scanner-number',item.number));
    } else {
      let graphic=null;
      try{graphic=mode==='qr'?makeQR(item.qrPayload||''):code128(item.number);}catch(_err){}
      if(graphic){
        const holder=h('div','scanner-white'+(mode==='qr'?' scanner-qr':' scanner-barcode'));holder.append(graphic);
        body.append(holder);
        body.append(h('div','scanner-caption',mode==='qr'?'СТАТИЧНЫЙ QR-КОД':'ШТРИХКОД CODE 128'));
        if(item.number)body.append(h('div','scanner-number',item.number));
      }else body.append(h('div','warning','Код этой карты не удалось сформировать. Отредактируйте данные или откройте официальное приложение.'));
    }
    const popup=overlay('Карта для кассы',body);popup.bg.classList.add('scanner-backdrop','checkout-backdrop');
    append(body,h('p','scanner-caveat','Проверьте на кассе, подходит ли именно этот тип кода. Для динамических QR используйте магазинное приложение.'),
      btn(item.favorite?'★ В быстром доступе':'☆ В быстрый доступ','btn-outline full',async()=>{
        if(phase!=='unlocked')return;const ok=await updateCollection('cards',item.id,{favorite:!item.favorite});if(ok){popup.close();render();}
      }),
      btn('Закрыть','btn-primary full',()=>popup.close()));
  }
  function validSecret(s){const clean=(s||'').replace(/[\s=-]/g,'').toUpperCase();return /^[A-Z2-7]{16,256}$/.test(clean);}
  function decodeBase32(secret){const symbols='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',clean=secret.replace(/[\s=-]/g,'').toUpperCase();
    let bits=0,buffer=0,bytes=[];for(const c of clean){const value=symbols.indexOf(c);if(value<0)throw new Error('Некорректный Base32-ключ');buffer=(buffer<<5)|value;bits+=5;if(bits>=8){bits-=8;bytes.push((buffer>>bits)&255);buffer&=(1<<bits)-1;}}
    return new Uint8Array(bytes);
  }
  async function totp(secret,epoch=Math.floor(Date.now()/1000)){
    const bytes=decodeBase32(secret),tick=Math.floor(epoch/30),counter=new Uint8Array(8);let count=tick;
    for(let i=7;i>=0;i--){counter[i]=count&255;count=Math.floor(count/256);}
    const k=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-1'},false,['sign']);
    const digest=new Uint8Array(await crypto.subtle.sign('HMAC',k,counter));const off=digest[digest.length-1]&15;
    const binary=((digest[off]&127)<<24)|(digest[off+1]<<16)|(digest[off+2]<<8)|digest[off+3];return String((binary>>>0)%1000000).padStart(6,'0');
  }
  let otpTimer=null;
  function stopOtp(){if(otpTimer){clearInterval(otpTimer);otpTimer=null;}}
  // Timer must not retain a secret when navigating away.
  function showOtp(item){
    stopOtp();const body=h('div','stack');body.append(h('p','','Код обновляется каждые 30 секунд. Не передавайте его посторонним.'));
    const digits=h('div','otp-digits mono','••• •••');const countdown=h('div','otp-countdown','');body.append(digits,countdown);
    const popup=overlay(item.name,body);
    const update=async()=>{if(phase!=='unlocked'||!popup.bg.isConnected){stopOtp();return;}
      try{const epoch=Math.floor(Date.now()/1000);const result=await totp(item.secret,epoch);if(phase==='unlocked'&&popup.bg.isConnected){digits.textContent=result.slice(0,3)+' '+result.slice(3);countdown.textContent='Новый код через '+(30-epoch%30)+' сек.';}}
      catch(_err){digits.textContent='Ошибка ключа';}
    };
    body.append(btn('Скопировать код','btn-primary full',async()=>{try{await copyText(await totp(item.secret),'Код');}catch(_err){toast('Не удалось создать код',true);}}),btn('Закрыть','btn-outline full',()=>{stopOtp();popup.close();}));
    popup.bg.addEventListener('click',ev=>{if(ev.target===popup.bg)stopOtp();});
    update();otpTimer=setInterval(update,1000);
  }
  // iCalendar export is done locally. No push notifications or background server.
  function calendarExport(item,k){
    const date=upcomingDate(item);if(!date){toast('Не указана дата',true);return;}
    const escapeICS=s=>String(s||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
    const d=date.replaceAll('-',''),utc=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    const days=Math.max(0,Math.min(365,Number(item.remindDays??3)||0));
    const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SEIF//LOCAL REMINDERS//RU','BEGIN:VEVENT',`UID:${idNew()}@seif-local`,`DTSTAMP:${utc}`,`DTSTART;VALUE=DATE:${d}`,`SUMMARY:${escapeICS(item.name)}`,`DESCRIPTION:${escapeICS(k==='subscriptions'?'Подписка · '+(item.amount||'')+' '+(item.currency||'₽'):item.note||'Напоминание из СЕЙФА')}`];
    const repeat=item.cycle||item.repeat;
    if(repeat==='monthly')ics.push('RRULE:FREQ=MONTHLY');else if(repeat==='yearly')ics.push('RRULE:FREQ=YEARLY');
    ics.push('BEGIN:VALARM','ACTION:DISPLAY',days===0?'TRIGGER:-PT0S':`TRIGGER:-P${days}D`,`DESCRIPTION:${escapeICS(item.name)}`,'END:VALARM','END:VEVENT','END:VCALENDAR');
    const blob=new Blob([ics.join('\r\n')+'\r\n'],{type:'text/calendar;charset=utf-8'}),url=URL.createObjectURL(blob),a=h('a');
    a.href=url;a.download='seif-'+date+'.ics';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('Событие календаря скачано. Откройте .ics и подтвердите добавление.');
  }
  function passwordScore(){
    const counts=new Map();for(const e of entries)counts.set(e.password,(counts.get(e.password)||0)+1);
    const duplicate=entries.filter(e=>counts.get(e.password)>1);const weak=entries.filter(e=>e.password.length<12||(!/[^a-z\d]/i.test(e.password)&&e.password.length<18));
    return {duplicate,weak};
  }
  function renderSecurity(){
    const s=shell();s.append(pageTitle('Контроль безопасности'));
    const {duplicate,weak}=passwordScore();
    const box=h('div','panel');append(box,h('h3','','Проверка локальных записей'),h('p','note','Проверяем пароли только на этом устройстве — без передачи секретов в сеть. Это приблизительная оценка, а не аудит и не проверка утечек.'));
    for(const [label,list,kind] of [['Повторяющиеся пароли',duplicate,'same'],['Потенциально слабые',weak,'weak']]){
      box.append(append(h('div','health-stat'),h('div','',label),h('strong',list.length?'health-warn':'health-good',String(list.length))));
      if(list.length){for(const x of list.slice(0,12)){
        const b=h('button','health-item');append(b,h('span','',x.name||serviceInfo(x.serviceId)[1]),h('span','','Открыть →'));b.addEventListener('click',()=>go('detail:'+x.id));box.append(b);
      }}
    }
    s.append(box);
    s.append(append(h('div','panel'),h('h3','','Как защищаться лучше'),h('p','note','Используйте уникальные длинные пароли, включайте двухфакторную защиту, сохраняйте резервные коды и зашифрованную копию сейфа вне устройства. Прототип не проверялся независимыми специалистами.')));
  }

  // ===== МОЙ РИТМ · private, local-only, opt-in lifestyle companion =====
  // Sensitive cycle/wellness data and wardrobe photographs are inside the same
  // encrypted vault as other modules. No server, advertising SDK or sharing.
  const RH_SECTIONS=[
    ['cycle','Мой цикл','◕','Календарь и история'],
    ['mood','Самочувствие','♡','Как я сегодня'],
    ['reminders','Напоминания','♧','Важное вовремя'],
    ['care','Уход за собой','✧','Процедуры и записи'],
    ['plans','Мои планы','☑','Идеи и дела'],
    ['wardrobe','Мой гардероб','▧','Личная фотолента'],
    ['feed','Моя лента','▤','Моменты и лайки'],
    ['sport','Мой спорт','◈','Фото тренировок'],
    ['travel','Мои поездки','✈','Путешествия'],
    ['events','Мои события','✧','Памятные дни']
  ];
  const RH_MAP={cycle:'rhythmCycles',mood:'rhythmMood',reminders:'rhythmReminders',care:'rhythmCare',plans:'rhythmPlans',wardrobe:'rhythmWardrobe',feed:'rhythmWardrobe',sport:'rhythmWardrobe',travel:'rhythmWardrobe',events:'rhythmWardrobe'};
  let rhUi={tab:'wardrobe',feedFilter:'all',monthShift:0};
  function rhList(k){return extras[RH_MAP[k]]||[];}
  function rhDate(s){return dayFrom(s)?dateHuman(s):'Без даты';}
  function rhDayAdd(iso,days){const d=dayFrom(iso);if(!d)return '';d.setDate(d.getDate()+days);return isoDate(d);}
  function rhSort(k){return [...rhList(k)].sort((a,b)=>String(b.day||b.dueDate||'').localeCompare(String(a.day||a.dueDate||''))||(b.createdAt||0)-(a.createdAt||0));}
  function rhButton(label,cls,action){const b=h('button','rh-btn '+(cls||''),label);b.type='button';b.addEventListener('click',action);return b;}
  function rhHead(s,title,desc){s.append(append(h('div','rh-page-head'),h('span','rh-eyebrow','МОЙ РИТМ · ЛИЧНОЕ ПРОСТРАНСТВО'),h('h1','',title),h('p','',desc)));}
  function rhFrame(){const s=shell();s.classList.add('rh-shell','rh-theme-'+profileMode());return s;}
  function rhBack(s){s.append(rhButton('← Мой ритм','rh-back',()=>go('rhythm')));}
  function rhSectionCard(k){const f=RH_SECTIONS.find(x=>x[0]===k),b=h('button','rh-section-card rh-section-'+k);
    append(b,h('span','rh-section-icon',f[2]),h('strong','',f[1]),h('small','',f[3]),h('span','rh-arrow','↗'));
    b.addEventListener('click',()=>go('rhythm:'+k));return b;}
  function rhythmDashboardTile(){
    const sec=h('section','rh-launch-section');const b=h('button','rh-launch');b.type='button';
    append(b,h('span','rh-launch-symbol',profileMode()==='man'?'◈':profileMode()==='neutral'?'◌':'✿'),append(h('span','rh-launch-content'),h('small','','МОЁ ПРОСТРАНСТВО'),h('strong','','Мой ритм'),h('span','',profileMode()==='man'?'Лента · стиль · спорт · поездки':profileMode()==='neutral'?'Лента · планы · стиль · события':'Цикл · самочувствие · планы · гардероб')),h('span','rh-launch-arrow','↗'));
    b.classList.add('rh-launch-'+profileMode());
    b.addEventListener('click',()=>go('rhythm'));sec.append(b);return sec;
  }
  function rhUpcoming(){
    const today=todayISO();const all=[...rhList('reminders'),...rhList('care')].filter(x=>x.dueDate&&x.dueDate>=today&&dayDiff(x.dueDate)<=14).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    return all.slice(0,4);
  }
  function renderRhythm(){
    const mode=profileMode();const s=rhFrame();
    rhHead(s,'Мой ритм',mode==='man'?'Твой стиль. Твой путь. Твоя жизнь.':mode==='neutral'?'Личное пространство для твоих событий и планов.':'Всё, что делает день твоим. Красивое, важное и только твоё.');
    const hero=h('section','rh-hero');append(hero,h('span','rh-hero-orbit',mode==='man'?'◈':mode==='neutral'?'◌':'✿'),h('small','',mode==='man'?'МОЙ ПУТЬ · МОИ МОМЕНТЫ':'ПРОСТРАНСТВО ДЛЯ СЕБЯ'),h('h2','',mode==='man'?'Мой стиль. Моя история.':'Моя жизнь. Мои правила.'),h('p','',mode==='man'?'Сохраняй образы, спорт, поездки и события в собственной фотоленте.':'Личные фотографии, настроение, события и планы — в одном месте.'));
    const quick=h('div','rh-hero-actions');append(quick,rhButton('＋ Новый момент','rh-solid',()=>rhWardrobeForm()),rhButton('♡ Моя лента','rh-glass',()=>go('rhythm:feed')));hero.append(quick);s.append(hero);
    const photos=rhSort('wardrobe').filter(x=>x.imageData);if(photos.length){const preview=h('section','rh-feed-preview');append(preview,h('h2','rh-section-heading','Последние моменты'));
      const grid=h('div','rh-preview-grid');for(const x of photos.slice(0,3)){const b=h('button','rh-preview-photo');b.type='button';const im=h('img');im.src=x.imageData;im.alt=x.name||'Момент';append(b,im,h('span','',x.favorite?'♥ '+(x.name||'Момент'):x.name||'Момент'));b.addEventListener('click',()=>rhWardrobeView(x));grid.append(b);}preview.append(grid);preview.append(rhButton('Смотреть всю ленту →','rh-outline rh-wide',()=>go('rhythm:feed')));s.append(preview);}
    s.append(h('h2','rh-section-heading','Моё пространство'));
    const ids=mode==='man'?['feed','wardrobe','sport','travel','events','plans','mood','care','reminders']:mode==='neutral'?['feed','wardrobe','plans','reminders','travel','events','sport','mood','care','cycle']:['cycle','mood','reminders','care','plans','wardrobe','feed','travel','events','sport'];
    const grid=h('div','rh-grid');for(const k of ids)grid.append(rhSectionCard(k));s.append(grid);
    const upcoming=rhUpcoming();if(upcoming.length){const box=h('section','rh-panel');box.append(h('h2','','Скоро важное'));
      for(const x of upcoming){const b=h('button','rh-list-row');append(b,h('span','rh-list-mark','◌'),append(h('span','rh-list-text'),h('strong','',x.name||'Событие'),h('small','',rhDate(x.dueDate))),h('span','rh-chevron','›'));
        b.addEventListener('click',()=>go(rhList('care').some(c=>c.id===x.id)?'rhythm:care':'rhythm:reminders'));box.append(b);}s.append(box);}
    s.append(h('p','rh-privacy','🔒 Личная лента. Сердечки — твои собственные отметки «Нравится». Публичных лайков, подписчиков и публикаций нет. Все фото остаются внутри зашифрованного СЕЙФА.'));
  }
  function renderRhythmSection(k){
    if(!RH_MAP[k]){go('rhythm');return;}
    const s=rhFrame();rhBack(s);const f=RH_SECTIONS.find(x=>x[0]===k);rhHead(s,f[1],{
      cycle:'Здесь нет правильного ритма — только твоя история.',mood:'Заметь, как ты себя чувствуешь. Без оценок и правил.',
      reminders:'Не держи всё в голове.',care:'Маленькие ритуалы, которые радуют.',plans:'Сохраняй идеи и отмечай сделанное.',
      wardrobe:'Личный гардероб с фото, образами и любимыми вещами.',feed:'Твоя жизнь в фотографиях. Лайки и памятные моменты.',sport:'Тренировки, достижения и спортивные моменты.',travel:'Путешествия, города, поездки и воспоминания.',events:'События, встречи и особенные дни.'}[k]);
    if(k==='cycle')rhRenderCycle(s);
    else if(k==='mood')rhRenderMood(s);
    else if(k==='reminders')rhRenderEntries(s,'reminders');
    else if(k==='care')rhRenderEntries(s,'care');
    else if(k==='plans')rhRenderEntries(s,'plans');
    else if(['wardrobe','feed','sport','travel','events'].includes(k))rhRenderWardrobe(s,k);
  }
  function rhTextField(label,value='',placeholder='',max=200){const wrap=h('label','rh-field');wrap.append(h('span','',label));const inp=h('input','rh-input');inp.value=value;inp.placeholder=placeholder;inp.maxLength=max;wrap.append(inp);return {wrap,inp};}
  function rhDateField(label,value){const a=rhTextField(label,value||todayISO());a.inp.type='date';return a;}
  function rhTextArea(label,value='',placeholder=''){const a=rhTextField(label,value,placeholder,1200);const area=h('textarea','rh-input rh-area');area.value=value;area.placeholder=placeholder;area.maxLength=1200;a.inp.replaceWith(area);a.inp=area;return a;}
  function rhModal(title,build){const bg=h('div','rh-modal-backdrop');const sheet=h('section','rh-modal');sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label',title);
    const close=()=>{bg.remove();};append(sheet,append(h('div','rh-modal-head'),h('h2','',title),rhButton('✕','rh-x',close)));build(sheet,close);bg.append(sheet);bg.addEventListener('click',e=>{if(e.target===bg)close();});document.body.append(bg);return close;}
  async function rhSave(k,record,close){const col=RH_MAP[k];if(!col)return false;const old=rhList(k);const fresh={...record,id:record.id||idNew(),updatedAt:Date.now(),createdAt:record.createdAt||Date.now()};
    const next=old.some(x=>x.id===fresh.id)?old.map(x=>x.id===fresh.id?fresh:x):[...old,fresh];
    if(k==='wardrobe'&&next.length>250){toast('Достигнут лимит 250 фотографий. Сохраните резервную копию и освободите место.',true);return false;}
    const ok=await commit(entries,{...extras,[col]:next});if(ok){close?.();render();}return ok;}
  function rhDelete(k,record){if(!confirm('Удалить запись «'+String(record.name||'').slice(0,70)+'»? Отменить действие нельзя.'))return;
    const col=RH_MAP[k];commit(entries,{...extras,[col]:rhList(k).filter(x=>x.id!==record.id)}).then(ok=>{if(ok)render();});}
  function rhCalendar(s,marked,predicted){const now=new Date();const d=new Date(now.getFullYear(),now.getMonth()+rhUi.monthShift,1,12);const first=d.getDay()===0?6:d.getDay()-1;const days=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
    const box=h('section','rh-panel rh-calendar');const header=h('div','rh-calendar-head');append(header,rhButton('‹','rh-cal-nav',()=>{rhUi.monthShift--;render();}),h('strong','',d.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})),rhButton('›','rh-cal-nav',()=>{rhUi.monthShift++;render();}));box.append(header);
    const grid=h('div','rh-calendar-grid');for(const day of ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'])grid.append(h('span','rh-calendar-week',day));
    for(let i=0;i<first;i++)grid.append(h('span','rh-calendar-blank',''));
    for(let day=1;day<=days;day++){const iso=isoDate(new Date(d.getFullYear(),d.getMonth(),day,12));let cls='rh-calendar-day';
      if(iso===todayISO())cls+=' today';if(marked.has(iso))cls+=' marked';else if(predicted.has(iso))cls+=' predicted';
      const cell=h('span',cls,String(day));cell.title=marked.has(iso)?'Отмеченная менструация':predicted.has(iso)?'Ориентировочный прогноз':'';grid.append(cell);}
    box.append(grid);box.append(h('p','rh-calendar-legend','● Отмеченные дни    ◌ Предполагаемые дни'));s.append(box);}
  function rhRenderCycle(s){
    const settings=rhList('cycle').find(x=>x.kind==='settings')||{length:28,period:5};
    const periods=rhList('cycle').filter(x=>x.kind==='period'&&dayFrom(x.day)).sort((a,b)=>b.day.localeCompare(a.day));
    const length=Math.max(18,Math.min(60,Number(settings.length)||28));const duration=Math.max(1,Math.min(12,Number(settings.period)||5));
    const marked=new Set(),predicted=new Set();for(const p of periods){const count=Math.max(1,Math.min(12,Number(p.duration)||duration));for(let i=0;i<count;i++)marked.add(rhDayAdd(p.day,i));}
    let next=periods.length?rhDayAdd(periods[0].day,length):'';for(let i=0;next&&next<todayISO()&&i<1000;i++)next=rhDayAdd(next,length);if(next)for(let i=0;i<duration;i++)predicted.add(rhDayAdd(next,i));
    const hero=h('section','rh-cycle-hero');append(hero,h('small','','МОЙ КАЛЕНДАРЬ'),h('h2','',next?new Date(next+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'}):'Начни со своей даты'),h('p','',next?'Ориентировочное начало следующей менструации':'Отметь первый день, и здесь появится календарь.'));s.append(hero);
    const actions=h('div','rh-actions');append(actions,rhButton('＋ Отметить начало','rh-solid',()=>rhCyclePeriodForm()),rhButton('⚙ Длина цикла','rh-outline',()=>rhCycleSettingsForm(settings)));s.append(actions);
    rhCalendar(s,marked,predicted);
    const hist=h('section','rh-panel');hist.append(h('h2','','История'));if(!periods.length)hist.append(h('p','rh-muted','Пока нет записей. Можно добавить дату предыдущего цикла.'));
    for(const p of periods.slice(0,24)){const row=h('div','rh-list-row');append(row,h('span','rh-list-mark','◕'),append(h('span','rh-list-text'),h('strong','',rhDate(p.day)),h('small','',`${p.duration||duration} дн.`)),rhButton('Удалить','rh-mini',()=>rhDelete('cycle',p)));hist.append(row);}s.append(hist);
    s.append(h('p','rh-privacy','Прогноз приблизительный и не предназначен для контрацепции, определения овуляции или медицинской диагностики. При необычных симптомах обратитесь к врачу. Уведомления о цикле на экран блокировки не отправляются.'));
  }
  function rhCyclePeriodForm(){rhModal('Начало менструации',(sheet,close)=>{const date=rhDateField('Первый день',todayISO());const duration=rhTextField('Сколько дней', '5');duration.inp.type='number';duration.inp.min='1';duration.inp.max='12';append(sheet,date.wrap,duration.wrap,rhButton('Сохранить','rh-solid rh-wide',async()=>{
    if(!dayFrom(date.inp.value)||Number(duration.inp.value)<1||Number(duration.inp.value)>12){toast('Проверьте дату и длительность',true);return;}
    await rhSave('cycle',{kind:'period',name:'Менструация',day:date.inp.value,duration:Number(duration.inp.value)},close);}));});}
  function rhCycleSettingsForm(settings){rhModal('Мои настройки',(sheet,close)=>{const length=rhTextField('Обычная длина цикла, дней',String(settings.length||28));length.inp.type='number';length.inp.min='18';length.inp.max='60';const duration=rhTextField('Обычная длительность, дней',String(settings.period||5));duration.inp.type='number';duration.inp.min='1';duration.inp.max='12';append(sheet,length.wrap,duration.wrap,rhButton('Сохранить','rh-solid rh-wide',async()=>{
    const l=Number(length.inp.value),d=Number(duration.inp.value);if(!Number.isInteger(l)||l<18||l>60||!Number.isInteger(d)||d<1||d>12){toast('Введите длительность от 18 до 60 и от 1 до 12 дней',true);return;}
    await rhSave('cycle',{...settings,kind:'settings',name:'Настройки цикла',length:l,period:d},close);}));});}
  function rhRenderMood(s){const today=todayISO(),current=rhList('mood').find(x=>x.day===today);const box=h('section','rh-mood-hero');append(box,h('span','rh-mood-flower','♡'),h('h2','','Как ты сегодня?'),h('p','','Можно просто отметить настроение и продолжить свой день.'));s.append(box);
    const moods=[['✨','Прекрасно'],['🙂','Хорошо'],['😐','Спокойно'],['😔','Грустно'],['😴','Усталость'],['🌧️','Тяжело']];
    const opts=h('div','rh-mood-options');let selected=current?.mood||'Хорошо';const buttons=[];for(const [emoji,label] of moods){const b=rhButton(emoji+' '+label,'rh-mood-choice'+(selected===label?' selected':''),()=>{selected=label;buttons.forEach(x=>x.classList.toggle('selected',x===b));});buttons.push(b);opts.append(b);}s.append(opts);
    const note=rhTextArea('Что хочется запомнить?',current?.note||'','Немного о сегодняшнем дне…');s.append(note.wrap);
    s.append(rhButton('♡ Сохранить сегодняшний день','rh-solid rh-wide',async()=>{
      await rhSave('mood',{...current,kind:'mood',name:'Самочувствие',day:today,mood:selected,note:note.inp.value.trim()},null);
    }));
    const hist=h('section','rh-panel rh-mood-history');hist.append(h('h2','','Мои дни'));const logs=rhSort('mood');if(!logs.length)hist.append(h('p','rh-muted','Твои записи появятся здесь.'));
    for(const x of logs.slice(0,45)){const row=h('div','rh-list-row');append(row,h('span','rh-list-mark',moods.find(m=>m[1]===x.mood)?.[0]||'♡'),append(h('span','rh-list-text'),h('strong','',x.mood||'Самочувствие'),h('small','',rhDate(x.day)+(x.note?' · '+x.note.slice(0,70):''))),rhButton('×','rh-mini',()=>rhDelete('mood',x)));hist.append(row);}s.append(hist);
  }
  function rhEntryForm(k,item){const title=k==='plans'?'Мой план':k==='care'?'Уход за собой':'Напоминание';rhModal(item?'Изменить запись':'Добавить · '+title,(sheet,close)=>{
    const name=rhTextField('Название',item?.name||'',k==='care'?'Маникюр, массаж, стрижка…':k==='plans'?'Что хочу сделать?':'О чём напомнить?');
    const date=rhDateField(k==='plans'?'Дата (необязательно)':'Дата',item?.dueDate||todayISO());
    const note=rhTextArea('Заметка',item?.note||'','Необязательно');append(sheet,name.wrap,date.wrap,note.wrap);
    if(k==='plans'){const done=h('label','rh-checkbox');const ck=h('input');ck.type='checkbox';ck.checked=!!item?.done;append(done,ck,h('span','','Выполнено'));sheet.append(done);sheet.append(rhButton('Сохранить','rh-solid rh-wide',async()=>{
      if(!name.inp.value.trim()){toast('Напишите название',true);return;}await rhSave(k,{...item,name:name.inp.value.trim(),dueDate:date.inp.value,note:note.inp.value.trim(),done:ck.checked},close);}));}
    else sheet.append(rhButton('Сохранить','rh-solid rh-wide',async()=>{
      if(!name.inp.value.trim()||!dayFrom(date.inp.value)){toast('Напишите название и укажите дату',true);return;}
      await rhSave(k,{...item,name:name.inp.value.trim(),dueDate:date.inp.value,note:note.inp.value.trim()},close);}));
  });}
  function rhRenderEntries(s,k){const isPlan=k==='plans';const header=h('div','rh-actions');header.append(rhButton(isPlan?'＋ Новый план':k==='care'?'＋ Запись на уход':'＋ Напоминание','rh-solid',()=>rhEntryForm(k)));s.append(header);
    const all=rhSort(k);const panel=h('section','rh-panel');panel.append(h('h2','',isPlan?'Мои идеи и дела':k==='care'?'Мои процедуры':'Не забыть'));
    if(!all.length)panel.append(h('p','rh-muted',isPlan?'Пусть здесь живут планы — от маленьких до самых смелых.':'Добавь первую запись. Она появится здесь и в ближайших событиях.'));
    for(const item of all){const row=h('div','rh-list-row');const left=append(h('span','rh-list-text'),h('strong',''+(item.done?' rh-done':''),item.name),h('small','',rhDate(item.dueDate)+(item.note?' · '+item.note.slice(0,90):'')));
      const ico=isPlan?rhButton(item.done?'☑':'☐','rh-mini',async()=>{await rhSave('plans',{...item,done:!item.done});}):h('span','rh-list-mark',k==='care'?'✧':'◷');
      const buttons=h('div','rh-row-actions');if(k!=='plans'&&item.dueDate)buttons.append(rhButton('↗','rh-mini',()=>calendarExport({name:item.name,dueDate:item.dueDate,note:item.note||'',remindDays:1},'reminders')));
      append(buttons,rhButton('✎','rh-mini',()=>rhEntryForm(k,item)),rhButton('×','rh-mini',()=>rhDelete(k,item)));
      append(row,ico,left,buttons);panel.append(row);
    }s.append(panel);
    s.append(h('p','rh-privacy','Напоминания показываются внутри СЕЙФА. Для системного уведомления откройте ↗ и добавьте событие в календарь телефона. Сам СЕЙФ пока не отправляет фоновые push-уведомления.'));
  }
  function rhWardrobeForm(item){let imageData=item?.imageData||'';let selectedPhotos=item?[imageData]:[];rhModal(item?'Мой образ · изменить':'Добавить образ',(sheet,close)=>{
    const upload=h('label','rh-upload');const inputFile=h('input');inputFile.type='file';inputFile.accept='image/*';inputFile.multiple=!item;inputFile.setAttribute('aria-label','До пяти фотографий образа');
    // On iOS the system offers camera and photo library for image/*.
    const preview=h('div','rh-upload-preview');function update(){preview.replaceChildren();if(selectedPhotos.length){for(const src of selectedPhotos){const img=h('img');img.src=src;img.alt='Предпросмотр';preview.append(img);}preview.append(h('small','',selectedPhotos.length+' из 5 фото'));}else preview.append(h('span','','＋\nСфотографировать или выбрать фото'));}
    append(upload,preview,inputFile);sheet.append(upload);update();
    inputFile.addEventListener('click',()=>startPhotoPicker());
    inputFile.addEventListener('change',async()=>{const files=Array.from(inputFile.files||[]);finishPhotoPicker();if(!files.length)return;
      if(files.length>5){toast('Можно выбрать не более пяти фотографий',true);return;}
      const results=[];
      for(const file of files){
        if(file.size>25*1024*1024){toast('Фото слишком большое (максимум 25 МБ)',true);return;}
        if(!/^image\//.test(file.type)&&!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)){toast('Выберите фотографии',true);return;}
        try{results.push(await compressDocumentImage(file));}catch(err){toast(err.message||'Не удалось обработать фото',true);return;}
      }
      if(phase!=='unlocked')return;selectedPhotos=results;imageData=results[0];update();
    });
    const name=rhTextField('Название образа',item?.name||'','Например: любимый образ');
    const category=h('select','rh-input');const defaultAlbum=({sport:'sport',travel:'travel',events:'events'})[view.slice(7)]||'looks';for(const [value,label] of [['looks','Мои образы'],['casual','Повседневный стиль'],['business','Деловой стиль'],['sport','Спорт и тренировки'],['evening','Вечер и события'],['shoes','Обувь и аксессуары'],['fitting','Примерки'],['wishlist','Хочу купить'],['travel','Поездки'],['events','События'],['other','Другие моменты']]){const o=h('option','',label);o.value=value;if((item?.category||defaultAlbum)===value)o.selected=true;category.append(o);}
    const catWrap=h('label','rh-field');append(catWrap,h('span','','Альбом'),category);
    const note=rhTextArea('Подпись',item?.note||'','Где это было, что понравилось, с чем сочетать…');
    append(sheet,name.wrap,catWrap,note.wrap,rhButton('♡ Сохранить в гардероб','rh-solid rh-wide',async()=>{
      if(!imageData){toast('Сначала выберите фотографию',true);return;}
      const caption=name.inp.value.trim()||'Мой момент';
      if(item){await rhSave('wardrobe',{...item,name:caption,category:category.value,note:note.inp.value.trim(),imageData,day:item?.day||todayISO(),favorite:item?.favorite||false},close);return;}
      const old=rhList('wardrobe');if(old.length+selectedPhotos.length>250){toast('Превышен лимит 250 фотографий',true);return;}
      const groupId=idNew(),now=Date.now();
      const additions=selectedPhotos.map((src,i)=>({id:idNew(),groupId,photoIndex:i,name:caption,category:category.value,note:note.inp.value.trim(),imageData:src,day:todayISO(),favorite:false,createdAt:now,updatedAt:now}));
      const ok=await commit(entries,{...extras,rhythmWardrobe:[...additions,...old]});if(ok){close();render();toast('Сохранено фотографий: '+additions.length);}
    }));
  });}
  function rhWardrobeView(item){rhModal(item.name||'Мой образ',(sheet,close)=>{
    const im=h('img','rh-full-photo');im.src=item.imageData;im.alt=item.name||'Мой образ';sheet.append(im);
    sheet.append(h('h3','rh-photo-title',item.name||'Мой образ'));
    if(item.note)sheet.append(h('p','rh-photo-note',item.note));
    const actions=h('div','rh-actions');append(actions,rhButton(item.favorite?'♥ Нравится':'♡ Нравится','rh-outline',async()=>{const ok=await rhSave('wardrobe',{...item,favorite:!item.favorite},close);if(ok)toast('Обновлено');}),rhButton('✎ Изменить','rh-outline',()=>{close();rhWardrobeForm(item);}));sheet.append(actions);
    sheet.append(rhButton('Удалить фотографию','rh-delete',()=>{close();rhDelete('wardrobe',item);}));
  });}
  function rhRenderWardrobe(s,section='wardrobe'){const hero=h('div','rh-wardrobe-intro');append(hero,h('span','',section==='wardrobe'?'◈ МОЙ LOOKBOOK':'◈ МОЯ ЛИЧНАЯ ХРОНИКА'),h('h2','',section==='wardrobe'?'Образы, к которым возвращаются.':'Моменты, которые остаются.'),h('p','',section==='wardrobe'?'Зеркало, примерочная, любимые вещи и готовые комплекты.':'Стиль, спорт, путешествия, встречи и маленькие победы — твоя приватная фотолента.'));s.append(hero);
    s.append(rhButton('＋ Добавить фото / сделать снимок','rh-solid rh-wide',()=>rhWardrobeForm()));
    const tabs=h('div','rh-feed-filters');for(const [id,label] of [['all','Все'],['favorites','♥ Нравится'],['looks','Образы'],['casual','На каждый день'],['business','Деловой'],['sport','Спорт'],['travel','Поездки'],['events','События'],['evening','Вечер'],['fitting','Примерки'],['shoes','Аксессуары'],['wishlist','Хочу купить'],['other','Моменты']]){
      const b=rhButton(label,'rh-filter'+(rhUi.feedFilter===id?' selected':''),()=>{rhUi.feedFilter=id;render();});tabs.append(b);}s.append(tabs);
    const photos=rhSort('wardrobe').filter(x=>x.imageData&&(rhUi.feedFilter==='all'||(rhUi.feedFilter==='favorites'?x.favorite:x.category===rhUi.feedFilter)));
    const feed=h('div','rh-photo-feed');feed.setAttribute('aria-label','Личная лента образов');
    if(!photos.length)feed.append(append(h('div','rh-empty-photo'),h('div','','✿'),h('strong','','Здесь будет твоя история в фотографиях'),h('p','','Добавь первое фото — из примерочной, зеркала или галереи.')));
    const groups=[];const seen=new Set();for(const photo of photos){const gid=photo.groupId||photo.id;if(seen.has(gid))continue;seen.add(gid);groups.push(photos.filter(x=>(x.groupId||x.id)===gid).sort((a,b)=>(a.photoIndex||0)-(b.photoIndex||0)));}
    for(const group of groups){const photo=group[0];const card=h('article','rh-post');const top=append(h('div','rh-post-head'),h('span','rh-post-avatar',profileMode()==='man'?'◈':'✿'),append(h('div','rh-post-name'),h('strong','',section==='wardrobe'?'Мой гардероб':'Моя лента'),h('small','',rhDate(photo.day))),h('span','rh-post-private','🔒 Лично'));
      const photoButton=h('button','rh-post-photo');photoButton.setAttribute('aria-label','Открыть фото '+photo.name);const img=h('img');img.src=photo.imageData;img.alt=photo.name||'Образ';img.loading='lazy';photoButton.append(img);
      let current=0;const showPhoto=()=>{img.src=group[current].imageData;img.alt=group[current].name||'Фото';counter.textContent=(current+1)+' / '+group.length;};
      const counter=h('span','rh-photo-counter',group.length>1?'1 / '+group.length:'');
      photoButton.addEventListener('click',()=>rhWardrobeView(group[current]));
      if(group.length>1){const nav=h('div','rh-carousel-nav');const prev=rhButton('‹','rh-carousel-arrow',()=>{current=(current-1+group.length)%group.length;showPhoto();});const next=rhButton('›','rh-carousel-arrow',()=>{current=(current+1)%group.length;showPhoto();});append(nav,prev,counter,next);card.append(top,photoButton,nav);}
      const actions=h('div','rh-post-actions');append(actions,rhButton(photo.favorite?'♥ Нравится':'♡ Нравится','rh-heart'+(photo.favorite?' liked':''),async()=>{await rhSave('wardrobe',{...photo,favorite:!photo.favorite});}),rhButton('Открыть ↗','rh-open',()=>rhWardrobeView(photo)));
      append(card,...(group.length>1?[]:[top,photoButton]),actions,h('strong','rh-post-caption',photo.name||'Мой образ'));if(photo.note)card.append(h('p','rh-post-note',photo.note));feed.append(card);
    }s.append(feed);s.append(h('p','rh-privacy','♥ Лайки здесь — личные отметки на своих фотографиях. Другие пользователи их не видят. Фото не публикуются и хранятся в зашифрованном сейфе. Перед удалением приложения сделай резервную копию.'));
  }

  startup();
})();
