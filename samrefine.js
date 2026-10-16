// 岩點重描輪廓（只有電腦版）：MobileSAM 以目前輪廓的外框當提示，重新切出這顆岩點。
// 手機的 GPU 實測會算錯（Adreno 7xx），只用 CPU 要 7–9 秒，所以手機不開這個功能。
//
// 模型（web/models/，來源與授權見 web/models/README.md）：
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
(() => {
  'use strict';
  const ORT_VERSION = (window.HoldDetector && window.HoldDetector.ORT_VERSION) || '1.30.0';
  const base = document.currentScript.src;
  const ENC_URL = new URL('web/models/mobilesam-encoder.onnx', base).href;
  const DEC_URL = new URL('web/models/mobilesam-decoder.onnx', base).href;
  const CHOICE_KEY = 'spraywall.samBackend.v1';
  const SIDE = 1024;
  const T = (zh, en) => (document.documentElement.lang || '').startsWith('zh') ? zh : en;

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
        s.onerror = () => { ortReady = null; s.remove(); reject(new Error(T('無法載入 onnxruntime-web（請確認網路）', 'Could not load onnxruntime-web (check your connection)'))); };
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
    const tell = () => { const mb = (got[0] + got[1]) / 1e6; status(T(`下載描輪廓模型 ${mb.toFixed(0)}／45 MB（只有第一次）`, `Downloading the outline model ${mb.toFixed(0)} / 45 MB (first time only)`), Math.min(1, (got[0] + got[1]) / TOTAL)); };
    const get = async (u, k) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(T(`模型下載失敗（HTTP ${r.status}）`, `Model download failed (HTTP ${r.status})`));
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
    try { saved = key && JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}')[key]; } catch (e) { /* 忽略 */ }
    if (!key) return { kind: 'wasm', sess: await create(bufs.e, 'wasm'), emb: null };
    if (saved) { try { return { kind: saved, sess: await create(bufs.e, saved), emb: null }; } catch (e) { /* 重新檢查 */ } }
    status(T('第一次使用：檢查這台電腦最快又正確的執行方式（約 5–10 秒）…', 'First run: finding the fastest reliable mode for this computer (5–10 s)…'), null);
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
    try { const c = JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}'); c[key] = pick.kind; localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch (e) { /* 忽略 */ }
    return pick;
  }

  // decoder 每顆都要跑：GPU 約 0.05 秒、CPU 約 0.14 秒。第一次用固定的提示和 CPU 結果比，遮罩幾乎一樣才用 GPU；結論跟 encoder 記在一起
  const DEC_KEY = 'spraywall.samDecoder.v1';
  async function pickDecoder(w, h) {
    const wasm = await create(bufs.d, 'wasm');
    if (!backend || backend === 'wasm') return wasm;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DEC_KEY) || '{}')[navigator.userAgent]; } catch (e) { /* 忽略 */ }
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
        try { const c = JSON.parse(localStorage.getItem(DEC_KEY) || '{}'); c[navigator.userAgent] = ok ? 'webgpu' : 'wasm'; localStorage.setItem(DEC_KEY, JSON.stringify(c)); } catch (e) { /* 忽略 */ }
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
    if (!emb) { status(T('分析照片中…', 'Analysing the photo…'), null); emb = await embed(enc, input); }
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

  let msAvg = null;
  try { msAvg = +localStorage.getItem('spraywall.samMs') || null; } catch (e) { /* 忽略 */ }
  const msPerHold = () => msAvg || (backend && backend !== 'wasm' ? 70 : 170);
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
      msAvg = msAvg ? msAvg * 0.9 + ms * 0.1 : ms;
      try { localStorage.setItem('spraywall.samMs', String(Math.round(msAvg))); } catch (e) { /* 忽略 */ }
      return pts ? pts.map(([x, y]) => [+((x + rx0 + 0.5) / s).toFixed(1), +((y + ry0 + 0.5) / s).toFixed(1)]) : null;
    } finally { busy = null; done(); }
  }

  window.HoldRefiner = { available, refine, msPerHold, get backend() { return backend; } };
})();
