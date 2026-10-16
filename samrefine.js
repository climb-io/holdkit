// 岩點重描輪廓（只有電腦版）：MobileSAM 以目前輪廓的外框當提示，重新切出這顆岩點。
// 手機的 GPU 實測會算錯（Adreno 7xx），只用 CPU 要 7–9 秒，所以手機不開這個功能。
//
// 模型（web/models/，來源與授權見 web/models/README.md）：
//   encoder：整張照片（長邊 1024）算一次特徵，同一張照片之後重描都用快取
//   decoder：每次重描跑一次（電腦約 0.1 秒）
// 第一次使用時跟岩點偵測一樣先檢查 GPU 算得對不對（WebGPU 和 CPU 結果比對），不對就用 CPU；結論記在 localStorage。
//
// 用法：
//   HoldRefiner.available()                       → 這台裝置要不要顯示重描
//   const poly = await HoldRefiner.refine(canvas, key, poly, status)   // key：照片換了就換 key（例如牆面 id）
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

  async function download(status) {
    if (bufs) return bufs;
    status(T('下載重描模型（約 45 MB，只有第一次）…', 'Downloading the outline model (about 45 MB, first time only)…'));
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(T(`模型下載失敗（HTTP ${r.status}）`, `Model download failed (HTTP ${r.status})`)); return r.arrayBuffer(); };
    const [e, d] = await Promise.all([get(ENC_URL), get(DEC_URL)]);
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
    status(T('第一次使用：檢查這台電腦最快又正確的執行方式（約 5–10 秒）…', 'First run: finding the fastest reliable mode for this computer (5–10 s)…'));
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
    if (!dec) dec = await create(bufs.d, 'wasm');   // decoder 很小，用 CPU 就夠快
    if (!emb) { status(T('分析照片中…', 'Analysing the photo…')); emb = await embed(enc, input); }
    cache = { key, src, emb, s: input.s, w: input.w, h: input.h };
    return cache;
  }

  // 遮罩（w×h，1＝岩點）裡包含 (cx, cy) 的那塊（沒有就取最大塊）的外輪廓
  function outline(mask, w, h, cx, cy) {
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

  async function refine(src, key, poly, status = () => {}) {
    while (busy) await busy.catch(() => {});
    let done;
    busy = new Promise(r => { done = r; });
    try {
      const c = await ensure(src, key, status);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
      for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
      cx /= poly.length; cy /= poly.length;
      const s = c.s;
      const feeds = {   // 提示只用外框（100 顆實測比「點＋框」好一點）
        image_embeddings: new ort.Tensor('float32', c.emb, [1, 256, 64, 64]),
        point_coords: new ort.Tensor('float32', new Float32Array([x0 * s, y0 * s, x1 * s, y1 * s]), [1, 2, 2]),
        point_labels: new ort.Tensor('float32', new Float32Array([2, 3]), [1, 2]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([c.h, c.w]), [2]),
      };
      const out = await dec.run(feeds);
      const m = out.masks.data, mask = new Uint8Array(c.w * c.h);
      for (let i = 0; i < mask.length; i++) mask[i] = m[i] > 0 ? 1 : 0;
      const pts = outline(mask, c.w, c.h, cx * s, cy * s);
      return pts ? pts.map(([x, y]) => [+((x + 0.5) / s).toFixed(1), +((y + 0.5) / s).toFixed(1)]) : null;
    } finally { busy = null; done(); }
  }

  window.HoldRefiner = { available, refine, get backend() { return backend; } };
})();
