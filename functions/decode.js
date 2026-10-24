// 雲端重描的解碼 Worker（sam.js 開 CPUS 個）：每個一份 MobileSAM 解碼器、單執行緒，岩點分給各 Worker 同時解碼。
// 解碼器一次只描一個框，一個解碼器開多執行緒吃不滿 CPU；一次送多個框也不會比較快（每個框都要整張照片特徵跑一次）。
const { parentPort, workerData } = require('worker_threads');
const ort = require('onnxruntime-node');

const ready = ort.InferenceSession.create(workerData.model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1 });
let emb = null, w = 0, h = 0;

// 遮罩（w×h，1＝岩點）裡包含 (cx, cy) 的那塊（沒有就取最大塊）的外輪廓（跟 samrefine.js 的 outline 一樣）
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
  let sx = -1, sy = -1;
  for (let i = 0; i < w * h && sx < 0; i++) if (lab[i] === hit) { sx = i % w; sy = (i / w) | 0; }
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const pts = [[sx, sy]];
  let x = sx, y = sy, d = 6;
  for (let guard = 0; guard < 4 * (w + h) * 4; guard++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8, nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (on(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
    }
    if (!moved || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts.length >= 3 ? pts : null;
}

// 訊息：{ emb, w, h }＝換一張照片的特徵；{ i, hd }＝描第 i 顆，回傳 { i, poly }（poly 是 null 表示切不出來）
async function decode(dec, hd) {
  const [x0, y0, x1, y1] = hd.box;
  const r = await dec.run({
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', new Float32Array([x0, y0, x1, y1]), [1, 2, 2]),
    point_labels: new ort.Tensor('float32', new Float32Array([2, 3]), [1, 2]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', new Float32Array([h, w]), [2]),
  });
  // 只看框外擴一倍的範圍（跟 samrefine.js 一樣）
  const m = r.masks.data, g = Math.max(x1 - x0, y1 - y0);
  const rx0 = Math.max(0, Math.floor(x0 - g)), ry0 = Math.max(0, Math.floor(y0 - g));
  const rx1 = Math.min(w, Math.ceil(x1 + g)), ry1 = Math.min(h, Math.ceil(y1 + g)), rw = rx1 - rx0, rh = ry1 - ry0;
  let poly = null;
  if (rw >= 3 && rh >= 3) {
    const mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mask[y * rw + x] = m[(ry0 + y) * w + rx0 + x] > 0 ? 1 : 0;
    const pts = outline(mask, rw, rh, hd.c[0] - rx0, hd.c[1] - ry0);
    if (pts) poly = pts.map(([x, y]) => [x + rx0 + 0.5, y + ry0 + 0.5]);
  }
  return poly;
}

ready.then(() => parentPort.postMessage({ ready: true }), (e) => parentPort.postMessage({ error: String((e && e.message) || e) }));
parentPort.on('message', async (m) => {
  if (m.emb) { emb = new ort.Tensor('float32', m.emb, [1, 256, 64, 64]); w = m.w; h = m.h; return; }
  try { parentPort.postMessage({ i: m.i, poly: await decode(await ready, m.hd) }); }
  catch (e) { parentPort.postMessage({ i: m.i, error: String((e && e.message) || e) }); }
});
