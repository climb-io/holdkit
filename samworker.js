// 手機重描輪廓用的 Worker（試作）：MobileSAM 只用 CPU（手機 GPU 實測會算錯），在 Worker 裡算，分析照片的 7–9 秒不會卡住畫面。
// 主程式（samrefine.js）傳訊息進來：
//   init { ort, wasm, enc, dec }   載入 onnxruntime（只有 CPU 的版本）、下載兩個模型；下載中回報 { type: 'progress', bytes }
//   embed { data, w, h }           整張照片（長邊 1024，HWC、0–255）→ 特徵，記在 Worker 裡，也回傳一份給主程式存起來
//   setEmb { emb }                 用存起來的特徵（同一張照片不用再分析）
//   decode { box | point, w, h, region }   框（或一個點：沒偵測到的岩點，點在岩點上）當提示切出岩點，只回傳 region 範圍的遮罩（Uint8Array）
let enc = null, dec = null, emb = null;

async function fetchModel(url, got, report) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(), parts = [];
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got.n += value.length; report();
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const handlers = {
  async init(m) {
    const t0 = performance.now();
    if (!self.ort) {
      importScripts(m.ort);
      ort.env.wasm.wasmPaths = m.wasm;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    }
    const got = { n: 0 };
    let last = 0;
    const report = () => { if (performance.now() - last > 200) { last = performance.now(); postMessage({ type: 'progress', bytes: got.n }); } };
    const [e, d] = await Promise.all([fetchModel(m.enc, got, report), fetchModel(m.dec, got, report)]);
    const t1 = performance.now();
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    enc = await ort.InferenceSession.create(e, opt);
    dec = await ort.InferenceSession.create(d, opt);
    return { dl: t1 - t0, load: performance.now() - t1 };
  },
  async embed(m) {
    const t0 = performance.now();
    const r = await enc.run({ input_image: new ort.Tensor('float32', m.data, [m.h, m.w, 3]) });
    emb = new Float32Array(r.image_embeddings.data);
    const copy = emb.slice();
    return { emb: copy, ms: performance.now() - t0, transfer: [copy.buffer] };
  },
  async setEmb(m) { emb = m.emb; return {}; },
  async decode(m) {
    const t0 = performance.now();
    const out = await dec.run({
      image_embeddings: new ort.Tensor('float32', emb, [1, 256, 64, 64]),
      // 框：左上、右下兩點（標記 2、3）；一個點：前景點（1）加一個補位的點（-1，沒有框時模型要的）
      point_coords: new ort.Tensor('float32', new Float32Array(m.point ? [m.point[0], m.point[1], 0, 0] : m.box), [1, 2, 2]),
      point_labels: new ort.Tensor('float32', new Float32Array(m.point ? [1, -1] : [2, 3]), [1, 2]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
      orig_im_size: new ort.Tensor('float32', new Float32Array([m.h, m.w]), [2]),
    });
    const d = out.masks.data, { rx0, ry0, rw, rh } = m.region, mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mask[y * rw + x] = d[(ry0 + y) * m.w + rx0 + x] > 0 ? 1 : 0;
    return { mask, ms: performance.now() - t0, transfer: [mask.buffer] };
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const r = await handlers[m.type](m);
    const transfer = r.transfer || []; delete r.transfer;
    postMessage({ id: m.id, ...r }, transfer);
  } catch (err) {
    postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
