// 雲端重描輪廓（MobileSAM，CPU）：手機把長邊縮到 1024 的照片和要重描的岩點框送上來，在這裡分析一次照片，岩點分給解碼 Worker（decode.js）同時切出來，回傳新外框。
// 跟 samrefine.js 同一套模型、同一種提示（只用框）和外輪廓追蹤，結果跟瀏覽器一樣。
// 模型部署時從 models/ 複製進來（firebase.json 的 predeploy，同一份檔案不另外進版控），載入後同一個執行個體留在記憶體。
const ort = require('onnxruntime-node');
const { Worker } = require('worker_threads');
const sharp = require('sharp');

const fs = require('fs');
const path = require('path');
let sessions = null;
const CPUS = Number(process.env.SAM_CPUS) || 8;

async function loadModels() {
  if (sessions) return sessions;
  const t0 = Date.now();
  // 部署時模型已經複製進 functions/models；本機測試沒有複製就直接讀 repo 的 models/
  const find = (name) => {
    const local = [path.join(__dirname, 'models', name), path.join(__dirname, '..', 'models', name)].find(f => fs.existsSync(f));
    if (!local) throw new Error(`model ${name} not found`);
    return local;
  };
  // encoder 的執行緒數、解碼 Worker 數照雲端函式分到的 vCPU（CPUS）：系統回報的核心數是整台主機的，照那個開會互搶，反而慢
  const opt = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: CPUS, interOpNumThreads: 1 };
  const decoders = Array.from({ length: CPUS }, () => new Worker(path.join(__dirname, 'decode.js'), { workerData: { model: find('mobilesam-decoder.onnx') } }));
  try {
    const [enc] = await Promise.all([
      ort.InferenceSession.create(new Uint8Array(fs.readFileSync(find('mobilesam-encoder.onnx'))), opt),
      ...decoders.map(wk => new Promise((ok, no) => {
        wk.once('message', m => m.ready ? ok() : no(new Error(m.error)));
        wk.once('error', no);
      })),
    ]);
    sessions = { enc, decoders, loadMs: Date.now() - t0 };
  } catch (e) { decoders.forEach(wk => wk.terminate()); throw e; }
  return sessions;
}

// 岩點分給解碼 Worker（decode.js）：哪個做完就接下一顆，回傳跟 holds 同順序的 [{ id, poly }]
function decodeAll(decoders, ed, w, h, holds) {
  if (!holds.length) return Promise.resolve([]);
  const out = new Array(holds.length);
  let next = 0;
  return Promise.all(decoders.map(wk => new Promise((ok, no) => {
    const send = () => {
      if (next < holds.length) { const i = next++; wk.postMessage({ i, hd: holds[i] }); return; }
      wk.off('message', got); wk.off('error', no); ok();
    };
    const got = (m) => {
      if (m.error) { wk.off('message', got); wk.off('error', no); return no(new Error(m.error)); }
      out[m.i] = { id: holds[m.i].id, poly: m.poly };
      send();
    };
    wk.on('message', got); wk.on('error', no);
    wk.postMessage({ emb: ed, w, h });
    send();
  }))).then(() => out);
}

// jpeg：長邊 1024 的照片；holds：[{ id, box: [x0, y0, x1, y1], c: [cx, cy] }]（都在這張照片的座標）
// 回傳 { holds: [{ id, poly }]（同一個座標，poly 是 null 表示切不出來）, emb: 照片特徵, ms: { load, encode, decode }（毫秒） }；holds 可以是空的（只要照片特徵）
async function refineAll(jpeg, holds) {
  const s = await loadModels(), first = s.loadMs;
  s.loadMs = 0;   // 只有冷啟動那次要算下載、載入
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, input = new Float32Array(w * h * 3);
  for (let i = 0; i < input.length; i++) input[i] = data[i];
  const t0 = Date.now();
  const emb = (await s.enc.run({ input_image: new ort.Tensor('float32', input, [h, w, 3]) })).image_embeddings;
  const encode = Date.now() - t0;
  // 照片特徵也回傳（int8：每個通道 lo + q × sc，約 1 MB），手機存起來之後單顆重描只跑解碼器（samrefine.js）
  const ed = emb.data, N = 64 * 64, q = Buffer.alloc(256 * N), lo = [], sc = [];
  for (let c = 0; c < 256; c++) {
    let a = Infinity, b = -Infinity;
    for (let k = c * N; k < (c + 1) * N; k++) { a = Math.min(a, ed[k]); b = Math.max(b, ed[k]); }
    const step = (b - a) / 255 || 1;
    for (let k = c * N; k < (c + 1) * N; k++) q[k] = Math.round((ed[k] - a) / step);
    lo.push(a); sc.push(step);
  }
  const t1 = Date.now();
  let out;
  try { out = await decodeAll(s.decoders, ed, w, h, holds); }
  catch (e) { s.decoders.forEach(wk => wk.terminate()); sessions = null; throw e; }   // Worker 出錯：下一份重新載入
  const decode = Date.now() - t1;
  return { holds: out, emb: { q: q.toString('base64'), lo, sc, w, h }, ms: { load: first, encode, decode } };
}

// 預熱（handler.js 的 GET）：先載入模型，載入時間不算進下一份重描
async function warm() { (await loadModels()).loadMs = 0; }

module.exports = { refineAll, warm };
