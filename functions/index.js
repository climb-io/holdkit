// 雲端函式 retrace：分析照片（MobileSAM 的 encoder，手機算太慢），整面牆的岩點輪廓一次重描，照片特徵也回傳給 App 存起來（之後單顆重描只跑解碼器）。
// 要登入（Firebase 的 ID token，匿名也可以）才能用；照片只在記憶體裡算，不存檔。
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { refineAll, warm } = require('./sam');

admin.initializeApp();

const ORIGINS = ['https://climb-io.github.io', 'https://climbio.web.app', 'https://climbio-dev.web.app', 'https://climbio.firebaseapp.com', 'http://localhost:8765', 'http://127.0.0.1:8765'];
const PREVIEW = /^https:\/\/climbio--[a-z0-9-]+\.web\.app$/;   // Hosting 預覽網址（測試用）
const MAX_HOLDS = 3000, MAX_BYTES = 6e6;

exports.retrace = onRequest({ region: 'asia-east1', invoker: 'public', memory: '4GiB', cpu: 8, timeoutSeconds: 300, concurrency: 1, maxInstances: 2 }, async (req, res) => {
  const origin = req.get('origin');
  if (ORIGINS.includes(origin) || PREVIEW.test(origin || '')) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    return res.status(204).send('');
  }
  // 預熱：App 在使用者選照片時送一個 GET，執行個體先開機、載入模型，等真的送整面牆來就不用再等（不帶資料、不用登入）
  if (req.method === 'GET') {
    try { await warm(); return res.status(204).send(''); } catch (e) { console.error(e); return res.status(500).send(''); }
  }
  if (req.method !== 'POST') return res.status(405).send('POST only');
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    await admin.auth().verifyIdToken(token);
  } catch (e) { return res.status(401).json({ error: 'not signed in' }); }
  try {
    const { img, holds } = req.body || {};
    if (typeof img !== 'string' || !Array.isArray(holds) || holds.length > MAX_HOLDS) return res.status(400).json({ error: 'bad request' });
    const jpeg = Buffer.from(img, 'base64');
    if (jpeg.length > MAX_BYTES) return res.status(413).json({ error: 'image too large' });
    const ok = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
    if (!holds.every(h => typeof h.id === 'string' && ok(h.box, 4) && ok(h.c, 2))) return res.status(400).json({ error: 'bad holds' });
    const t0 = Date.now();
    const r = await refineAll(jpeg, holds);
    r.ms.total = Date.now() - t0;
    // 只記數字（岩點數、各段耗時），不記照片和座標：用來看每顆岩點要多久
    const dec = r.ms.decode;
    console.log(JSON.stringify({ retrace: { n: holds.length, load: r.ms.load, encode: r.ms.encode, decode: dec, perHold: holds.length ? Math.round(dec / holds.length) : 0, total: r.ms.total } }));
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});
