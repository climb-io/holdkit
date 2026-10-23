// 雲端重描輪廓（MobileSAM，CPU）：手機把長邊縮到 1024 的照片和要重描的岩點框送上來，在這裡分析一次照片、逐顆切出岩點，回傳新外框。
// 跟 samrefine.js 同一套模型、同一種提示（只用框）和外輪廓追蹤，結果跟電腦版、手機版一樣。
// 模型部署時從 models/ 複製進來（firebase.json 的 predeploy，同一份檔案不另外進版控），載入後同一個執行個體留在記憶體。
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const fs = require('fs');
const path = require('path');
let sessions = null;
const CPUS = Number(process.env.SAM_CPUS) || 8;

async function loadModels() {
  if (sessions) return sessions;
  const t0 = Date.now();
  // 部署時模型已經複製進 functions/models；本機測試沒有複製就直接讀 repo 的 models/
  const get = async (name) => {
    const local = [path.join(__dirname, 'models', name), path.join(__dirname, '..', 'models', name)].find(f => fs.existsSync(f));
    if (!local) throw new Error(`model ${name} not found`);
    return new Uint8Array(fs.readFileSync(local));
  };
  const [e, d] = await Promise.all([get('mobilesam-encoder.onnx'), get('mobilesam-decoder.onnx')]);
  // 執行緒數照雲端函式分到的 vCPU（index.js 的 CPUS）：系統回報的核心數是整台主機的，照那個開會互搶，反而慢
  const opt = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: CPUS, interOpNumThreads: 1 };
  sessions = { enc: await ort.InferenceSession.create(e, opt), dec: await ort.InferenceSession.create(d, opt), loadMs: Date.now() - t0 };
  return sessions;
}

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

// jpeg：長邊 1024 的照片；holds：[{ id, box: [x0, y0, x1, y1], c: [cx, cy] }]（都在這張照片的座標）
// 回傳 { holds: [{ id, poly }]（同一個座標，poly 是 null 表示切不出來）, emb: 照片特徵, ms: { load, encode, decode: [...] } }；holds 可以是空的（只要照片特徵）
async function refineAll(jpeg, holds) {
  const s = await loadModels(), first = s.loadMs;
  s.loadMs = 0;   // 只有冷啟動那次要算下載、載入
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, input = new Float32Array(w * h * 3);
  for (let i = 0; i < input.length; i++) input[i] = data[i];
  const t0 = Date.now();
  const emb = (await s.enc.run({ input_image: new ort.Tensor('float32', input, [h, w, 3]) })).image_embeddings;
  const encode = Date.now() - t0, decode = [], out = [];
  // 照片特徵也回傳（int8：每個通道 lo + q × sc，約 1 MB），手機存起來之後單顆重描只跑解碼器（samrefine.js）
  const ed = emb.data, N = 64 * 64, q = Buffer.alloc(256 * N), lo = [], sc = [];
  for (let c = 0; c < 256; c++) {
    let a = Infinity, b = -Infinity;
    for (let k = c * N; k < (c + 1) * N; k++) { a = Math.min(a, ed[k]); b = Math.max(b, ed[k]); }
    const step = (b - a) / 255 || 1;
    for (let k = c * N; k < (c + 1) * N; k++) q[k] = Math.round((ed[k] - a) / step);
    lo.push(a); sc.push(step);
  }
  for (const hd of holds) {
    const t1 = Date.now();
    const [x0, y0, x1, y1] = hd.box;
    const r = await s.dec.run({
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
    out.push({ id: hd.id, poly });
    decode.push(Date.now() - t1);
  }
  return { holds: out, emb: { q: q.toString('base64'), lo, sc, w, h }, ms: { load: first, encode, decode }, cpus: [CPUS, require('os').cpus().length] };
}

module.exports = { refineAll };
