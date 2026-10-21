// 岩點重描輪廓（只有電腦版）：MobileSAM 以目前輪廓的外框當提示，重新切出這顆岩點。
// 手機的 GPU 實測會算錯（Adreno 7xx），只用 CPU 要 7–9 秒，所以手機不開這個功能。
//
// 模型（models/，來源與授權見 models/README.md、NOTICE）：跟 samrefine.js 放在一起，相對路徑是 models/
//   encoder：整張照片（長邊 1024）算一次特徵，同一張照片之後重描都用快取
//   decoder：每次重描跑一次（電腦約 0.1 秒）
// 第一次使用時跟岩點偵測一樣先檢查 GPU 算得對不對（WebGPU 和 CPU 結果比對），不對就用 CPU；結論記在 localStorage。
//
// 用法：
//   HoldRefiner.available()                       → 這台裝置要不要重描
//   const poly = await HoldRefiner.refine(canvas, key, poly, status, { box })   // key：照片換了就換 key（例如牆面 id）
//     box：提示用的框 [x0, y0, x1, y1]（偵測框），不給就用輪廓的外框
//     status(文字, 進度 0–1 或 null)：下載模型、檢查執行方式、分析照片時回報
//   HoldRefiner.msPerHold()                       → 最近每顆重描花的毫秒數（估剩餘時間用）
//   HoldRefiner.configure({ t, keyPrefix, db, cloudUrl, idToken })   第一次重描之前設定（都可以不給）：
//     t(key, ...參數)：訊息翻譯（不給就用內建英文）；keyPrefix、db：localStorage key 的開頭、IndexedDB 名稱；
//     cloudUrl、idToken()：雲端重描（functions/ 的 retrace 網址、取得 Firebase ID token 的函式），兩個都給才開
(() => {
  'use strict';
  const ORT_VERSION = '1.30.0';
  const base = document.currentScript.src;
  const ENC_URL = new URL('models/mobilesam-encoder.onnx', base).href;
  const DEC_URL = new URL('models/mobilesam-decoder.onnx', base).href;
  const cfg = { t: null, keyPrefix: 'holdkit.', db: 'holdkit-sam', cloudUrl: null, idToken: null };
  const configure = (o) => Object.assign(cfg, o);
  const CHOICE_KEY = () => cfg.keyPrefix + 'samBackend.v1';
  const SIDE = 1024;
  const MSG = {
    ortLoadFail: 'Couldn’t load onnxruntime-web. Check your connection.', modelHttp: (s) => `Model download failed (HTTP ${s})`,
    samDownload: (mb) => `Downloading the outline model ${mb} / 45 MB (first time only)`, samFirstRun: 'First run: finding the best mode for this computer (5–10 s)…',
    samAnalyzing: 'Analyzing the photo…', samTimeout: 'The outline model stopped responding. Try again later.',
  };
  const T = (k, ...a) => cfg.t ? cfg.t(k, ...a) : typeof MSG[k] === 'function' ? MSG[k](...a) : MSG[k] || k;

  // 電腦：滑鼠（精細指標、可以懸停），而且不是手機或平板的瀏覽器
  function available() {
    const mm = (q) => window.matchMedia && window.matchMedia(q).matches;
    return mm('(pointer: fine)') && mm('(hover: hover)') && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  let ortReady = null;
  function loadOrt() {
    if (window.ort) return Promise.resolve();
    if (!ortReady) {
      ortReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.js`;
        s.onload = () => {
          ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
          ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
          resolve();
        };
        s.onerror = () => { ortReady = null; s.remove(); reject(new Error(T('ortLoadFail'))); };
        document.head.append(s);
      });
    }
    return ortReady;
  }

  let bufs = null, enc = null, dec = null, backend = null, cache = null, busy = null;

  // 下載兩個模型，回報已下載的 MB（第二次起從快取拿，很快）
  async function download(status) {
    if (bufs) return bufs;
    const TOTAL = 44.7e6, got = [0, 0];
    const tell = () => { const mb = (got[0] + got[1]) / 1e6; status(T('samDownload', mb.toFixed(0)), Math.min(1, (got[0] + got[1]) / TOTAL)); };
    const get = async (u, k) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(T('modelHttp', r.status));
      if (!r.body || !r.body.getReader) return r.arrayBuffer();
      const rd = r.body.getReader(), parts = [];
      let last = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); got[k] += value.length;
        if (performance.now() - last > 200) { last = performance.now(); tell(); }
      }
      const out = new Uint8Array(got[k]); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out.buffer;
    };
    tell();
    const [e, d] = await Promise.all([get(ENC_URL, 0), get(DEC_URL, 1)]);
    tell();   // 下載很快時中間來不及更新，最後補一次
    bufs = { e, d };
    return bufs;
  }
  const create = (buf, kind) => ort.InferenceSession.create(buf, {
    executionProviders: [kind === 'wasm' ? 'wasm' : { name: 'webgpu', preferredLayout: kind.split('-')[1] }], graphOptimizationLevel: 'all',
  });

  // 照片 → encoder 的輸入：長邊縮到 1024，HWC、0–255（正規化和補邊在模型裡）
  function toInput(src) {
    const s = SIDE / Math.max(src.width, src.height), w = Math.round(src.width * s), h = Math.round(src.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, out = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) { out[i * 3] = px[j]; out[i * 3 + 1] = px[j + 1]; out[i * 3 + 2] = px[j + 2]; }
    return { tensor: new ort.Tensor('float32', out, [h, w, 3]), s, w, h };
  }
  async function embed(sess, input) {
    const r = await sess.run({ input_image: input.tensor });
    return new Float32Array(r.image_embeddings.data);
  }

  // 執行方式：記住的就直接用；第一次拿這張照片同時用 CPU 和 WebGPU 算，結果一致才用 WebGPU
  async function pickBackend(input, status) {
    let key = null;
    if (navigator.gpu && self.isSecureContext) {
      try {
        const a = await navigator.gpu.requestAdapter(), i = (a && a.info) || {};
        if (a) key = [ORT_VERSION, navigator.userAgent, i.vendor, i.architecture, i.device, i.description].join('|');
      } catch (e) { /* 沒有 GPU */ }
    }
    let saved = null;
    try { saved = key && JSON.parse(localStorage.getItem(CHOICE_KEY()) || '{}')[key]; } catch (e) { /* 忽略 */ }
    if (!key) return { kind: 'wasm', sess: await create(bufs.e, 'wasm'), emb: null };
    if (saved) { try { return { kind: saved, sess: await create(bufs.e, saved), emb: null }; } catch (e) { /* 重新檢查 */ } }
    status(T('samFirstRun'), null);
    const wasm = await create(bufs.e, 'wasm');
    const ref = await embed(wasm, input);
    let pick = { kind: 'wasm', sess: wasm, emb: ref };
    for (const kind of ['webgpu-NCHW', 'webgpu-NHWC']) {
      let sess = null;
      try {
        sess = await create(bufs.e, kind);
        const got = await embed(sess, input);
        let m = 0, r = 0;
        for (let i = 0; i < ref.length; i++) { if (!Number.isFinite(got[i])) { m = Infinity; break; } m = Math.max(m, Math.abs(ref[i] - got[i])); r = Math.max(r, Math.abs(ref[i])); }
        if (m / (r || 1) < 0.02) { await wasm.release(); pick = { kind, sess, emb: got }; break; }
      } catch (e) { /* 這種設定不支援 */ }
      if (sess) await sess.release();
    }
    try { const c = JSON.parse(localStorage.getItem(CHOICE_KEY()) || '{}'); c[key] = pick.kind; localStorage.setItem(CHOICE_KEY(), JSON.stringify(c)); } catch (e) { /* 忽略 */ }
    return pick;
  }

  // decoder 每顆都要跑：GPU 約 0.05 秒、CPU 約 0.14 秒。第一次用固定的提示和 CPU 結果比，遮罩幾乎一樣才用 GPU；結論跟 encoder 記在一起
  const DEC_KEY = () => cfg.keyPrefix + 'samDecoder.v1';
  async function pickDecoder(w, h) {
    const wasm = await create(bufs.d, 'wasm');
    if (!backend || backend === 'wasm') return wasm;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DEC_KEY()) || '{}')[navigator.userAgent]; } catch (e) { /* 忽略 */ }
    if (saved === 'wasm') return wasm;
    let gpu = null;
    try {
      gpu = await create(bufs.d, 'webgpu-NCHW');
      if (saved !== 'webgpu') {
        let s = 1; const emb = new Float32Array(256 * 64 * 64).map(() => ((s = (s * 9301 + 49297) % 233280) / 233280) - 0.5);
        const f = feeds(emb, [w * 0.3, h * 0.3, w * 0.6, h * 0.7], w, h);
        const a = (await wasm.run(f)).masks.data, b = (await gpu.run(f)).masks.data;
        let i = 0, u = 0;
        for (let k = 0; k < a.length; k++) { const x = a[k] > 0, y = b[k] > 0; if (x && y) i++; if (x || y) u++; }
        const ok = !u || i / u > 0.98;
        try { const c = JSON.parse(localStorage.getItem(DEC_KEY()) || '{}'); c[navigator.userAgent] = ok ? 'webgpu' : 'wasm'; localStorage.setItem(DEC_KEY(), JSON.stringify(c)); } catch (e) { /* 忽略 */ }
        if (!ok) { await gpu.release(); return wasm; }
      }
      await wasm.release();
      return gpu;
    } catch (e) { if (gpu) await gpu.release().catch(() => {}); return wasm; }
  }
  function feeds(emb, box, w, h) {
    return {
      image_embeddings: new ort.Tensor('float32', emb, [1, 256, 64, 64]),
      point_coords: new ort.Tensor('float32', new Float32Array(box), [1, 2, 2]),
      point_labels: new ort.Tensor('float32', new Float32Array([2, 3]), [1, 2]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
      orig_im_size: new ort.Tensor('float32', new Float32Array([h, w]), [2]),
    };
  }
  async function ensure(src, key, status) {
    if (cache && cache.key === key && cache.src === src) return cache;
    await loadOrt();
    await download(status);
    const input = toInput(src);
    let emb = null;
    if (!enc) {
      const p = await pickBackend(input, status);
      enc = p.sess; backend = p.kind; emb = p.emb;
    }
    if (!dec) dec = await pickDecoder(input.w, input.h, emb || null);
    if (!emb) { status(T('samAnalyzing'), null); emb = await embed(enc, input); }
    cache = { key, src, emb, s: input.s, w: input.w, h: input.h };
    return cache;
  }

  // 遮罩（w×h，1＝岩點）裡包含 (cx, cy) 的那塊（沒有就取最大塊）的外輪廓
  function outline(mask, w, h, cx, cy) {   // mask 已經只剩框附近（見 refine），整張掃一遍也很快
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, hit = 0, n = 0;
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
    hit = lab[ci] || best;
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

  let msAvg;   // 上次記下的每顆毫秒數：第一次用到才讀（configure 之後，keyPrefix 才對）
  const savedMs = () => {
    if (msAvg === undefined) { msAvg = null; try { msAvg = +localStorage.getItem(cfg.keyPrefix + 'samMs') || null; } catch (e) { /* 忽略 */ } }
    return msAvg;
  };
  const msPerHold = () => (stats.decodes.length ? stats.decodes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, stats.decodes.length) : 0) || savedMs() || (backend && backend !== 'wasm' ? 70 : 170);
  async function refine(src, key, poly, status = () => {}, { box = null } = {}) {
    while (busy) await busy.catch(() => {});
    let done;
    busy = new Promise(r => { done = r; });
    try {
      const c = await ensure(src, key, status);
      const t0 = performance.now();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
      for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
      cx /= poly.length; cy /= poly.length;
      if (box) [x0, y0, x1, y1] = box;
      const s = c.s;
      const out = await dec.run(feeds(c.emb, [x0 * s, y0 * s, x1 * s, y1 * s], c.w, c.h));   // 提示只用框（100 顆實測比「點＋框」好一點）
      // 只看框外擴一倍的範圍（岩點不會超出太多），小岩點不用整張掃
      const m = out.masks.data, g = Math.max(x1 - x0, y1 - y0) * s;
      const rx0 = Math.max(0, Math.floor(x0 * s - g)), ry0 = Math.max(0, Math.floor(y0 * s - g));
      const rx1 = Math.min(c.w, Math.ceil(x1 * s + g)), ry1 = Math.min(c.h, Math.ceil(y1 * s + g)), rw = rx1 - rx0, rh = ry1 - ry0;
      if (rw < 3 || rh < 3) return null;
      const mask = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mask[y * rw + x] = m[(ry0 + y) * c.w + rx0 + x] > 0 ? 1 : 0;
      const pts = outline(mask, rw, rh, cx * s - rx0, cy * s - ry0);
      const ms = performance.now() - t0;
      msAvg = savedMs() ? msAvg * 0.9 + ms * 0.1 : ms;
      try { localStorage.setItem(cfg.keyPrefix + 'samMs', String(Math.round(msAvg))); } catch (e) { /* 忽略 */ }
      return pts ? pts.map(([x, y]) => [+((x + rx0 + 0.5) / s).toFixed(1), +((y + ry0 + 0.5) / s).toFixed(1)]) : null;
    } finally { busy = null; done(); }
  }

  // ---------- 手機試作：定線點到的岩點才重描（一次一顆），在 Worker 裡用 CPU 算 ----------
  // 整張照片的特徵（約 4 MB）存在 IndexedDB（最近 3 張），同一張照片之後打開不用再分析。
  // stats 記每一步花的時間，給使用者實測：download 下載模型、load 載入、encode 分析照片（0＝用存起來的）、decode 最近一顆重描
  const CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const stats = { download: null, load: null, encode: null, decode: null, decodes: [] };
  let worker = null, wReady = null, wSeq = 0, onProg = null, pcache = null, pbusy = null, curStatus = () => {};   // curStatus：目前在等的那一次的進度回報（先在背景準備、之後才有人等也看得到下載進度）
  const wWait = new Map();
  const tapAvailable = () => !available() && typeof Worker !== 'undefined';
  // Worker 當掉（例如手機記憶體不足被系統關掉）或太久沒回應：整個重來，下次用到再重新載入；等著的都回報錯誤，不會卡住
  function resetWorker(err) {
    for (const p of wWait.values()) p.no(err);
    wWait.clear();
    if (worker) worker.terminate();
    worker = null; wReady = null; pcache = null;
  }
  function call(msg, transfer = [], ms = 120000) {
    if (!worker) return Promise.reject(new Error(T('samTimeout')));
    return new Promise((ok, no) => {
      const id = ++wSeq, timer = setTimeout(() => resetWorker(new Error(T('samTimeout'))), ms);
      wWait.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }
  function initWorker(status) {
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
    curStatus = status;
    onProg = (b) => curStatus(T('samDownload', (b / 1e6).toFixed(0)), Math.min(1, b / 44.7e6));
    status(T('samDownload', 0), 0);
    const ready = call({ type: 'init', ort: CDN + 'ort.wasm.min.js', wasm: CDN, enc: ENC_URL, dec: DEC_URL }, [], 10 * 60000)   // 下載 45 MB：慢的網路給 10 分鐘
      .then(r => { stats.download = r.dl; stats.load = r.load; return r; })
      .catch(e => { if (wReady === ready) resetWorker(e); throw e; });
    wReady = ready;
    return ready;
  }
  function embDb() {
    return new Promise((ok, no) => {
      const r = indexedDB.open(cfg.db, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('emb');
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  }
  async function embGet(k) {
    try { const db = await embDb(); return await new Promise(ok => { const q = db.transaction('emb').objectStore('emb').get(k); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); }
    catch (e) { return null; }
  }
  const idbDone = (tx) => new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = tx.onabort = () => no(tx.error); });
  async function embPut(k, emb) {
    try {
      const db = await embDb();
      const put = db.transaction('emb', 'readwrite'); put.objectStore('emb').put({ t: Date.now(), emb }, k); await idbDone(put);
      // 只留最近 3 張：先讀出每筆的時間，再用另一個交易刪（在 Promise 之後才刪，有的瀏覽器交易已經結束了）
      const rd = db.transaction('emb'), all = [];
      const c = rd.objectStore('emb').openCursor();
      c.onsuccess = () => { const x = c.result; if (x) { all.push([x.key, x.value.t]); x.continue(); } };
      await idbDone(rd);
      const old = all.sort((a, b) => b[1] - a[1]).slice(3);
      if (old.length) { const del = db.transaction('emb', 'readwrite'), st = del.objectStore('emb'); for (const [key] of old) st.delete(key); await idbDone(del); }
    } catch (e) { /* 存不了就下次再分析 */ }
  }
  async function ensurePhone(src, key, status) {
    curStatus = status;
    if (pcache && pcache.key === key && pcache.src === src) return pcache;
    await initWorker(status);
    const s = SIDE / Math.max(src.width, src.height), w = Math.round(src.width * s), h = Math.round(src.height * s), ek = `${key}|${w}x${h}`;
    const saved = await embGet(ek);
    if (saved) { await call({ type: 'setEmb', emb: saved.emb }); stats.encode = 0; }   // 存起來的照片特徵
    else {
      curStatus(T('samAnalyzing'), null);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data, data = new Float32Array(w * h * 3);
      for (let i = 0, j = 0; i < w * h; i++, j += 4) { data[i * 3] = px[j]; data[i * 3 + 1] = px[j + 1]; data[i * 3 + 2] = px[j + 2]; }
      const r = await call({ type: 'embed', data, w, h }, [data.buffer], 5 * 60000);
      stats.encode = r.ms;
      embPut(ek, r.emb);
    }
    pcache = { key, src, s, w, h };
    return pcache;
  }
  // point：[x, y]（照片座標）用一個點當提示（沒偵測到的岩點：使用者點在岩點上），找這一點附近的範圍；poly 不用
  async function refineTap(src, key, poly, status = () => {}, { box = null, point = null } = {}) {
    curStatus = status;
    while (pbusy) await pbusy.catch(() => {});
    let done;
    pbusy = new Promise(r => { done = r; });
    try {
      const c = await ensurePhone(src, key, status);
      const s = c.s;
      let x0, y0, x1, y1, cx, cy, g;
      if (point) {
        [cx, cy] = point; x0 = x1 = cx; y0 = y1 = cy;
        g = Math.max(c.w, c.h) * 0.15;   // 一個點：岩點多大不知道，找附近長邊 15% 的範圍（大顆的量體也夠）
      } else {
        x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; cx = 0; cy = 0;
        for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
        cx /= poly.length; cy /= poly.length;
        if (box) [x0, y0, x1, y1] = box;
        g = Math.max(x1 - x0, y1 - y0) * s;
      }
      const rx0 = Math.max(0, Math.floor(x0 * s - g)), ry0 = Math.max(0, Math.floor(y0 * s - g));
      const rx1 = Math.min(c.w, Math.ceil(x1 * s + g)), ry1 = Math.min(c.h, Math.ceil(y1 * s + g)), rw = rx1 - rx0, rh = ry1 - ry0;
      if (rw < 3 || rh < 3) return null;
      const r = await call(point ? { type: 'decode', point: [cx * s, cy * s], w: c.w, h: c.h, region: { rx0, ry0, rw, rh } }
        : { type: 'decode', box: [x0 * s, y0 * s, x1 * s, y1 * s], w: c.w, h: c.h, region: { rx0, ry0, rw, rh } }, [], 60000);
      stats.decode = r.ms; stats.decodes.push(r.ms);
      const pts = outline(r.mask, rw, rh, cx * s - rx0, cy * s - ry0);
      return pts ? pts.map(([x, y]) => [+((x + rx0 + 0.5) / s).toFixed(1), +((y + ry0 + 0.5) / s).toFixed(1)]) : null;
    } finally { pbusy = null; done(); }
  }
  // 背景準備：不帶照片只下載、載入模型；有照片再分析。失敗留到實際使用時重試。
  async function warmTap(src = null, key = null) {
    if (!tapAvailable()) return;
    while (pbusy) await pbusy.catch(() => {});
    let done;
    pbusy = new Promise(r => { done = r; });
    try {
      if (src) await ensurePhone(src, key, () => {});
      else await initWorker(() => {});
    } catch (e) { /* 用到時再試 */ } finally { pbusy = null; done(); }
  }

  // ---------- 雲端重描（試作）：手機整面牆一次送到雲端函式（functions/ 的 retrace）算，照片只在伺服器記憶體裡算、不存檔 ----------
  // 照片縮到長邊 1024（模型的輸入大小）用 JPEG 傳；回傳的外框換回照片座標。stats.cloud 記各段時間（實測用）
  // 整面牆一次送一份：分份同時送時常拿不到第二個執行個體，塞進同一台或新開的冷執行個體每顆都變慢，總時間沒有比較短
  const cloudAvailable = () => !available() && !!(cfg.cloudUrl && cfg.idToken) && navigator.onLine !== false;
  async function refineCloud(src, items) {
    const s = SIDE / Math.max(src.width, src.height), w = Math.round(src.width * s), h = Math.round(src.height * s);
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
    const send = async (chunk) => {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 290000);
      try {
        const r = await fetch(cfg.cloudUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ img, holds: chunk }), signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(timer); }
    };
    // 失敗（多半是雲端一時開不出執行個體：HTTP 500「no available instance」或 429）等 3、6、12 秒再試；登入、請求本身的錯（400、401、413）重試也沒用
    let j = null;
    for (let i = 0; ; i++) {
      try { j = await send(holds); break; }
      catch (e) { if (i >= 3 || /HTTP 4(00|01|13)/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 3000 * 2 ** i)); }
    }
    stats.cloud = { load: j.ms.load, encode: j.ms.encode, decode: j.ms.decode, total: j.ms.total, client: performance.now() - t0, kb: blob.size / 1024, n: items.length };
    return j.holds.map(x => ({ id: x.id, poly: x.poly ? x.poly.map(([px, py]) => [+(px / s).toFixed(1), +(py / s).toFixed(1)]) : null }));
  }

  window.HoldRefiner = { configure, available, refine, msPerHold, tapAvailable, refineTap, warmTap, cloudAvailable, refineCloud, stats, get backend() { return backend; } };
})();
