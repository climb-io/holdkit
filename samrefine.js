// 岩點重描輪廓（MobileSAM）：照片在雲端分析一次，之後重描只在瀏覽器的 Worker 裡跑解碼器。
//   整面牆：traceWall 把照片（長邊 1024）和岩點框送雲端函式（functions/ 的 retrace），拿回每顆的外框和照片特徵；
//     照片特徵（int8，約 1 MB）存 IndexedDB，每張照片一份（key 由呼叫端給，例如牆面 id），之後重描不用再上傳照片
//   單顆：refine 用存好的照片特徵在 Worker 裡解碼（CPU，手機約 0.6 秒）；沒有照片特徵就先跟雲端要一次（traceWall 不帶岩點）
//   同一張照片、同一個提示的重描共用同一份結果：長按還沒成立就先呼叫一次，長按成立時再呼叫拿的是同一個（不用再等）
// 模型（models/，來源與授權見 models/README.md、NOTICE）：瀏覽器只下載解碼器（約 16 MB）；分析照片的 encoder 只在雲端函式用。
//
// 用法：
//   HoldRefiner.configure({ t, db, cloudUrl, idToken })   第一次用之前設定：
//     t(key, ...參數)：訊息翻譯（不給就用內建英文）；db：IndexedDB 名稱；cloudUrl、idToken()：retrace 網址、取得 Firebase ID token 的函式
//   const res = await HoldRefiner.traceWall(src, key, items, status)   → [{ id, poly }]（poly 是 null＝切不出來）
//     items：[{ id, poly, box }]（照片座標；box 是提示用的框，不給就用 poly 的外框）；空的＝只要照片特徵
//   const poly = await HoldRefiner.refine(src, key, poly, status, { box, point })   → 外框或 null
//     box：提示用的框，不給就用 poly 的外框；point：[x, y] 用一個點當提示（沒偵測到的岩點），poly 不用
//     status(文字, 進度 0–1 或 null)：下載模型、跟雲端要照片特徵時回報
//   HoldRefiner.warm()                     背景下載、載入解碼器
//   HoldRefiner.hasEmb(key)、forget(key)、clear()   有沒有這張照片的特徵、刪掉一張、全部刪掉
//   HoldRefiner.stats                      download、load、decode（最近一顆）、decodes、cloud（雲端各段時間）
(() => {
  'use strict';
  const ORT_VERSION = '1.30.0';
  const base = document.currentScript.src;
  const DEC_URL = new URL('models/mobilesam-decoder.onnx', base).href, DEC_BYTES = 16.5e6;
  const CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const cfg = { t: null, db: 'holdkit-sam', cloudUrl: null, idToken: null };
  const configure = (o) => Object.assign(cfg, o);
  const SIDE = 1024;
  const MSG = {
    samDownload: (mb) => `Downloading the outline model ${mb} / 17 MB (first time only)`, samAnalyzing: 'Analyzing the photo…',
    samTimeout: 'The outline model stopped responding. Try again later.', samOffline: 'Outlines need an internet connection for this photo.',
  };
  const T = (k, ...a) => cfg.t ? cfg.t(k, ...a) : typeof MSG[k] === 'function' ? MSG[k](...a) : MSG[k] || k;
  const stats = { download: null, load: null, decode: null, decodes: [], cloud: null };
  const scaleOf = (src) => { const s = SIDE / Math.max(src.width, src.height); return { s, w: Math.round(src.width * s), h: Math.round(src.height * s) }; };

  // ---------- 照片特徵：IndexedDB，每張照片一份 { q: Uint8Array, lo, sc: Float32Array（每個通道的最小值、間距）, w, h } ----------
  function embDb() {
    return new Promise((ok, no) => {
      const r = indexedDB.open(cfg.db, 2);
      r.onupgradeneeded = () => { const d = r.result; if (d.objectStoreNames.contains('emb')) d.deleteObjectStore('emb'); d.createObjectStore('emb'); };   // 只是快取：換格式就清掉
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  }
  async function embTx(mode, fn) {
    const d = await embDb();
    return new Promise((ok, no) => {
      const tx = d.transaction('emb', mode), q = fn(tx.objectStore('emb'));
      tx.oncomplete = () => ok(q && q.result); tx.onerror = tx.onabort = () => no(tx.error);
    });
  }
  const embGet = (k) => embTx('readonly', st => st.get(k)).then(v => v || null);
  const hasEmb = (k) => embTx('readonly', st => st.count(k)).then(n => n > 0, () => false);
  const forget = (k) => { if (wKey === k) wKey = null; memo = null; return embTx('readwrite', st => st.delete(k)).catch(() => {}); };
  const clear = () => { wKey = null; memo = null; return embTx('readwrite', st => st.clear()).catch(() => {}); };

  // ---------- Worker：只有解碼器（samworker.js） ----------
  let worker = null, wReady = null, wKey = null, wSeq = 0, onProg = null, curStatus = () => {};
  const wWait = new Map();
  // Worker 當掉（例如手機記憶體不足被系統關掉）或太久沒回應：整個重來，下次用到再重新載入；等著的都回報錯誤，不會卡住
  function resetWorker(err) {
    for (const p of wWait.values()) p.no(err);
    wWait.clear();
    if (worker) worker.terminate();
    worker = null; wReady = null; wKey = null; memo = null;
  }
  function call(msg, transfer = [], ms = 120000) {
    if (!worker) return Promise.reject(new Error(T('samTimeout')));
    return new Promise((ok, no) => {
      const id = ++wSeq, timer = setTimeout(() => resetWorker(new Error(T('samTimeout'))), ms);
      wWait.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }
  function initWorker(status = () => {}) {
    curStatus = status;
    if (wReady) return wReady;
    worker = new Worker(new URL('samworker.js', base));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (onProg) onProg(m.bytes); return; }
      const p = wWait.get(m.id); if (!p) return;
      wWait.delete(m.id);
      if (m.error) p.no(new Error(m.error)); else p.ok(m);
    };
    worker.onerror = (e) => resetWorker(new Error(e.message || T('samTimeout')));
    onProg = (b) => curStatus(T('samDownload', (b / 1e6).toFixed(0)), Math.min(1, b / DEC_BYTES));
    const ready = call({ type: 'init', ort: CDN + 'ort.wasm.min.js', wasm: CDN, dec: DEC_URL }, [], 10 * 60000)   // 慢的網路給 10 分鐘
      .then(r => { stats.download = r.dl; stats.load = r.load; return r; })
      .catch(e => { if (wReady === ready) resetWorker(e); throw e; });
    wReady = ready;
    return ready;
  }
  const warm = () => initWorker().catch(() => { /* 用到時再試 */ });

  // ---------- 雲端（functions/ 的 retrace）：照片只在伺服器記憶體裡算、不存檔 ----------
  // 整面牆一次送一份：分份同時送時常拿不到第二個執行個體，塞進同一台或新開的冷執行個體每顆都變慢，總時間沒有比較短
  async function traceWall(src, key, items, status = () => {}) {
    if (!cfg.cloudUrl || !cfg.idToken) throw new Error('HoldRefiner: cloudUrl / idToken not configured');
    if (navigator.onLine === false) throw new Error(T('samOffline'));
    const { s, w, h } = scaleOf(src);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(src, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const img = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); });
    const holds = items.map(({ id, poly, box }) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
      for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
      if (box) [x0, y0, x1, y1] = box;
      return { id, box: [x0 * s, y0 * s, x1 * s, y1 * s], c: [cx / poly.length * s, cy / poly.length * s] };
    });
    const token = await cfg.idToken(), t0 = performance.now();
    const send = async () => {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 290000);
      try {
        const r = await fetch(cfg.cloudUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ img, holds }), signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(timer); }
    };
    // 失敗（多半是雲端一時開不出執行個體：HTTP 500「no available instance」或 429）等 3、6、12 秒再試；登入、請求本身的錯（400、401、413）重試也沒用
    let j = null;
    for (let i = 0; ; i++) {
      try { j = await send(); break; }
      catch (e) { if (i >= 3 || /HTTP 4(00|01|13)/.test(e.message)) throw e; status(T('samAnalyzing'), null); await new Promise(r => setTimeout(r, 3000 * 2 ** i)); }
    }
    const e = j.emb, bin = atob(e.q), q = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) q[i] = bin.charCodeAt(i);
    if (q.length !== 256 * 64 * 64 || e.lo.length !== 256 || e.sc.length !== 256 || e.w !== w || e.h !== h) throw new Error('retrace: bad embedding');
    const rec = { q, lo: Float32Array.from(e.lo), sc: Float32Array.from(e.sc), w, h };
    await embTx('readwrite', st => st.put(rec, key)).catch(() => { /* 存不了：下次重描再跟雲端要 */ });
    if (wKey === key) wKey = null;   // Worker 裡的、記著的結果是舊的（同一面牆重新偵測）
    memo = null;
    stats.cloud = { load: j.ms.load, encode: j.ms.encode, decode: j.ms.decode, total: j.ms.total, client: performance.now() - t0, kb: blob.size / 1024, n: items.length };
    return j.holds.map(x => ({ id: x.id, poly: x.poly ? x.poly.map(([px, py]) => [+(px / s).toFixed(1), +(py / s).toFixed(1)]) : null }));
  }

  // 遮罩（w×h，1＝岩點）裡包含 (cx, cy) 的那塊（沒有就取最大塊）的外輪廓（跟 functions/sam.js 一樣）
  function outline(mask, w, h, cx, cy) {
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      const id = ++n, st = [i]; lab[i] = id; let cnt = 0;
      while (st.length) {
        const p = st.pop(), x = p % w, y = (p / w) | 0; cnt++;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; st.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; st.push(p + 1); }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; st.push(p - w); }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; st.push(p + w); }
      }
      if (cnt > bestN) { bestN = cnt; best = id; }
    }
    const ci = Math.min(h - 1, Math.max(0, Math.round(cy))) * w + Math.min(w - 1, Math.max(0, Math.round(cx)));
    const hit = lab[ci] || best;
    if (!hit) return null;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === hit;
    // 起點：最上面一列最左邊的像素；Moore 鄰域沿外緣走一圈（順時針）
    let sx = -1, sy = -1;
    for (let i = 0; i < w * h && sx < 0; i++) if (lab[i] === hit) { sx = i % w; sy = (i / w) | 0; }
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const pts = [[sx, sy]];
    let x = sx, y = sy, d = 6;   // 上一步從上方進來
    for (let guard = 0; guard < 4 * (w + h) * 4; guard++) {
      let moved = false;
      for (let k = 0; k < 8; k++) {
        const nd = (d + 6 + k) % 8, nx = x + dirs[nd][0], ny = y + dirs[nd][1];   // 從左後方開始順時針找
        if (on(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
      }
      if (!moved || (x === sx && y === sy)) break;
      pts.push([x, y]);
    }
    return pts.length >= 3 ? pts : null;
  }

  // ---------- 單顆重描：Worker 一次只做一顆，照順序排隊 ----------
  let queue = Promise.resolve(), memo = null;   // memo：最近一次的提示和結果（長按還沒成立就先算的那次）
  // Worker 裡換成這張照片的特徵：存好的直接用；沒有就跟雲端要一次
  async function useEmb(src, key, status) {
    if (wKey === key) return;
    let rec = await embGet(key).catch(() => null);
    if (!rec) { status(T('samAnalyzing'), null); await traceWall(src, key, [], status); rec = await embGet(key); }
    if (!rec) throw new Error(T('samTimeout'));
    await call({ type: 'setEmb', q: rec.q, lo: rec.lo, sc: rec.sc });
    wKey = key;
  }
  function refine(src, key, poly, status = () => {}, { box = null, point = null } = {}) {
    const { s, w, h } = scaleOf(src);
    let x0, y0, x1, y1, cx, cy, g;
    if (point) {
      [cx, cy] = point; x0 = x1 = cx; y0 = y1 = cy;
      g = Math.max(w, h) * 0.15;   // 一個點：岩點多大不知道，找附近長邊 15% 的範圍（大顆的量體也夠）
    } else {
      x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; cx = 0; cy = 0;
      for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
      cx /= poly.length; cy /= poly.length;
      if (box) [x0, y0, x1, y1] = box;
      g = Math.max(x1 - x0, y1 - y0) * s;
    }
    const sig = JSON.stringify([key, w, h, point ? [cx, cy] : [x0, y0, x1, y1, cx, cy]]);
    if (memo && memo.sig === sig) { curStatus = status; return memo.p; }
    const p = queue.then(async () => {
      await initWorker(status);
      await useEmb(src, key, status);
      const rx0 = Math.max(0, Math.floor(x0 * s - g)), ry0 = Math.max(0, Math.floor(y0 * s - g));
      const rx1 = Math.min(w, Math.ceil(x1 * s + g)), ry1 = Math.min(h, Math.ceil(y1 * s + g)), rw = rx1 - rx0, rh = ry1 - ry0;
      if (rw < 3 || rh < 3) return null;
      // 提示只用框（100 顆實測比「點＋框」好一點）；只回傳框外擴一倍的範圍（岩點不會超出太多），小岩點不用整張掃
      const r = await call(point ? { type: 'decode', point: [cx * s, cy * s], w, h, region: { rx0, ry0, rw, rh } }
        : { type: 'decode', box: [x0 * s, y0 * s, x1 * s, y1 * s], w, h, region: { rx0, ry0, rw, rh } }, [], 60000);
      stats.decode = r.ms; stats.decodes.push(r.ms);
      const pts = outline(r.mask, rw, rh, cx * s - rx0, cy * s - ry0);
      return pts ? pts.map(([x, y]) => [+((x + rx0 + 0.5) / s).toFixed(1), +((y + ry0 + 0.5) / s).toFixed(1)]) : null;
    });
    queue = p.catch(() => {});
    memo = { sig, p };
    p.catch(() => { if (memo && memo.p === p) memo = null; });   // 失敗的不留，下次重算
    return p;
  }

  window.HoldRefiner = { configure, traceWall, refine, warm, hasEmb, forget, clear, stats };
})();
