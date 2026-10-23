// holdkit：岩點階段的分析（偵測框 → 外框、彩色範圍、代表色、色調），Apache-2.0。
// 不依賴任何 App 的狀態：照片、框、外框都從參數傳入。瀏覽器用 <script src="holdkit.js"> 載入成全域 HoldKit；
// Node 用 require('./holdkit.js')（holdEntry 要畫布，傳 ctx.createCanvas，例如 node-canvas 的 createCanvas）。
//
// 主要介面（座標都是照片像素；外框 poly＝[[x, y], ...]）：
//   analysis(img, W, H)                 → 分析用縮圖 { data, w, h, s }（長邊最多 1200）
//   outlineContext(ana, boxes)          → 辨識外框用的資料（整張 Lab、每個像素被幾個框蓋到）
//   boxToPoly(x0, y0, x1, y1, octx)     → 偵測框 → 岩點外框（凸包；失敗時是框的內切橢圓）
//   simplifyPoly(poly)                  → 外框精簡
//   holdEntry(hold, { img, W, H, holds }) → 岩點資料包的一筆（彩色範圍或 none、代表色 c、色調 t；不含 s）
//   maskSig(poly)                       → 外框指紋 s（外框改了就要重算）
//   cleanPx(px)                         → 檢查、清理收到的 px（格式見 SPEC.md）
//   colorName(c)、COLOR、SAME_DE        → 選同色用
(function (root, factory) {
  const HK = factory();
  if (typeof module === 'object' && module.exports) module.exports = HK;
  else root.HoldKit = HK;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.7.0';

  // ---------- 幾何 ----------
  function bbox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1 };
  }
  function centroid(poly) { let x = 0, y = 0; for (const p of poly) { x += p[0]; y += p[1]; } return [x / poly.length, y / poly.length]; }
  function tracePoly(c, poly) {
    c.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) c.lineTo(poly[i][0], poly[i][1]);
    c.closePath();
  }
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function ellipsePoly(cx, cy, rx, ry, n = 20) {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [+(cx + rx * Math.cos(a)).toFixed(1), +(cy + ry * Math.sin(a)).toFixed(1)];
    });
  }
  // 輪廓精簡：合併太近的頂點（< 岩點大小 8%），再用 Douglas–Peucker 拿掉幾乎在直線上的點（偏差 < 3.5%）
  function simplifyPoly(poly) {
    if (poly.length <= 4) return poly;
    const b = bbox(poly), size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const minD = Math.max(2, size * 0.08), eps = Math.max(1.5, size * 0.035);
    const d2 = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1]);
    const merged = [];
    for (const q of poly) if (!merged.length || d2(q, merged[merged.length - 1]) >= minD) merged.push(q);
    while (merged.length > 3 && d2(merged[0], merged[merged.length - 1]) < minD) merged.pop();
    if (merged.length < 3) return poly;
    // 封閉多邊形：從第 0 點和離它最遠的點切成兩段，各自做 Douglas–Peucker
    let far = 0, fd = -1;
    merged.forEach((q, i) => { const d = d2(q, merged[0]); if (d > fd) { fd = d; far = i; } });
    const segDist = (q, a, c) => {
      const dx = c[0] - a[0], dy = c[1] - a[1], L = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L));
      return Math.hypot(q[0] - a[0] - k * dx, q[1] - a[1] - k * dy);
    };
    const dp = (pts) => {
      if (pts.length <= 2) return pts;
      let mi = 0, md = -1;
      for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > md) { md = d; mi = i; } }
      if (md <= eps) return [pts[0], pts[pts.length - 1]];
      return dp(pts.slice(0, mi + 1)).slice(0, -1).concat(dp(pts.slice(mi)));
    };
    const a = dp(merged.slice(0, far + 1)), c = dp(merged.slice(far).concat([merged[0]]));
    const out = a.slice(0, -1).concat(c.slice(0, -1));
    return out.length >= 3 ? out : merged;
  }

  // ---------- 顏色 ----------
  // 顏色用 Lab，亮度的權重減半，陰影和反光比較不會被當成不同顏色。
  // RGBA 像素 → Lab（L 乘 0.5）
  function toLab(data, n) {
    const lab = new Float32Array(n * 3), lin = (v) => (v /= 255) > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    for (let i = 0; i < n; i++) {
      const r = lin(data[i * 4]), g = lin(data[i * 4 + 1]), b = lin(data[i * 4 + 2]);
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505), fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b), fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
      lab[i * 3] = (116 * fy - 16) * 0.5; lab[i * 3 + 1] = 500 * (fx - fy); lab[i * 3 + 2] = 200 * (fy - fz);
    }
    return lab;
  }
  // 從 pts（Lab 平面陣列）均勻取最多 max 個點
  function samplePts(pts, max) {
    const n = pts.length / 3, step = Math.max(1, Math.floor(n / max)), out = [];
    for (let i = 0; i < n; i += step) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    return out;
  }
  function kmeans(pts, k, iters = 6) {
    const n = pts.length / 3;
    if (n <= k) return pts.slice();
    const c = [];
    for (let j = 0; j < k; j++) { const i = Math.floor(j * (n - 1) / (k - 1)); c.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]); }
    const sum = new Float64Array(k * 3), cnt = new Uint32Array(k);
    for (let it = 0; it < iters; it++) {
      sum.fill(0); cnt.fill(0);
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < k; j++) {
          const d0 = pts[i * 3] - c[j * 3], d1 = pts[i * 3 + 1] - c[j * 3 + 1], d2 = pts[i * 3 + 2] - c[j * 3 + 2], d = d0 * d0 + d1 * d1 + d2 * d2;
          if (d < bd) { bd = d; best = j; }
        }
        sum[best * 3] += pts[i * 3]; sum[best * 3 + 1] += pts[i * 3 + 1]; sum[best * 3 + 2] += pts[i * 3 + 2]; cnt[best]++;
      }
      for (let j = 0; j < k; j++) if (cnt[j]) for (let q = 0; q < 3; q++) c[j * 3 + q] = sum[j * 3 + q] / cnt[j];
    }
    return c;
  }
  // 到最近代表色的距離
  function nearest(l, a, b, c) {
    let bd = Infinity;
    for (let j = 0; j < c.length; j += 3) { const d0 = l - c[j], d1 = a - c[j + 1], d2 = b - c[j + 2], d = d0 * d0 + d1 * d1 + d2 * d2; if (d < bd) bd = d; }
    return Math.sqrt(bd);
  }
  // 代表色：用到的像素裡彩度最高的一半，各取中位數（陰影、鎂粉的彩度低，比較不會被拉走）；存整數，亮度換回真的 L
  function repColor(lab, n, use) {
    const L = [], A = [], B = [], C = [];
    for (let p = 0; p < n; p++) if (use(p)) { L.push(lab[p * 3]); A.push(lab[p * 3 + 1]); B.push(lab[p * 3 + 2]); C.push(Math.hypot(lab[p * 3 + 1], lab[p * 3 + 2])); }
    if (C.length < 3) return 0;
    const mc = Float32Array.from(C).sort()[C.length >> 1], idx = [];
    for (let i = 0; i < C.length; i++) if (C[i] >= mc) idx.push(i);
    const med = (arr) => Float32Array.from(idx, i => arr[i]).sort()[idx.length >> 1];
    return [Math.round(med(L) * 2), Math.round(med(A)), Math.round(med(B))];
  }
  // 選同色：候選＝顏色名稱一樣，或代表色差 < SAME_DE（亮度權重減半）；點到白／灰時名稱常認錯（偏暗的白被叫成灰），只看色差
  const SAME_DE = 14;
  // 顏色名稱（key 是中文，顯示時由 App 翻譯）與代表的 RGB
  const COLOR = { 白: [232, 232, 226], 灰: [128, 128, 128], 黑: [32, 32, 34], 黃: [238, 212, 30], 橙: [240, 118, 30], 紅: [205, 30, 40],
    粉: [238, 88, 160], 紫: [118, 64, 160], 藍: [30, 88, 196], 蒂芬妮: [70, 196, 186], 綠: [40, 150, 64] };
  const labTrue = (r, g, b) => { const l = toLab([r, g, b, 255], 1); return [l[0] * 2, l[1], l[2]]; };   // toLab 的亮度是減半的
  const COLOR_LAB = Object.entries(COLOR).map(([n, c]) => [n, labTrue(...c)]);
  // 代表色 [L, a, b] → 顏色名稱（COLOR 的 key）
  function colorName([L, a, b]) {
    const C = Math.hypot(a, b), hue = Math.atan2(b, a) * 180 / Math.PI;
    let best = null, bd = Infinity;
    for (const [n, [pl, pa, pb]] of COLOR_LAB) {
      let d;
      if (n === '白' || n === '灰' || n === '黑') d = Math.abs(L - pl) * 0.5 + Math.max(0, C - 10) * 2;   // 黑白灰看亮度，彩度高就不是
      else { const dh = Math.abs(((hue - Math.atan2(pb, pa) * 180 / Math.PI + 540) % 360) - 180); d = dh * 0.6 + Math.abs(L - pl) * 0.3 + Math.max(0, 10 - C) * 2; }
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ---------- 遮罩 ----------
  // 方形的膨脹（dilate）／侵蝕：邊長 2r+1，分成橫、直兩次做；範圍外當作 0
  function morph(m, bw, bh, r, dilate) {
    const pass = (src, horiz) => {
      const out = new Uint8Array(src.length), len = horiz ? bw : bh, lines = horiz ? bh : bw;
      for (let ln = 0; ln < lines; ln++) {
        const at = (k) => horiz ? ln * bw + k : k * bw + ln;
        for (let k = 0; k < len; k++) {
          let v = dilate ? 0 : 1;
          for (let d = -r; d <= r; d++) {
            const kk = k + d;
            const px = kk < 0 || kk >= len ? 0 : src[at(kk)];
            if (dilate ? px : !px) { v = dilate ? 1 : 0; break; }
          }
          out[at(k)] = v;
        }
      }
      return out;
    };
    return pass(pass(m, true), false);
  }
  // 閉運算（補縫）：四周先墊 r 格空白再做，免得貼著框邊的岩點被撐到框邊
  function closeMask(m, bw, bh, r) {
    const W = bw + 2 * r, H = bh + 2 * r, pad = new Uint8Array(W * H);
    for (let y = 0; y < bh; y++) pad.set(m.subarray(y * bw, y * bw + bw), (y + r) * W + r);
    const c = morph(morph(pad, W, H, r, true), W, H, r, false), out = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) out.set(c.subarray((y + r) * W + r, (y + r) * W + r + bw), y * bw);
    return out;
  }
  // 遮罩壓縮：0、1 交錯的連續長度（從 0 開始），36 進位用逗號接起來
  function encodeRuns(on) {
    const out = []; let v = 0, n = 0;
    for (let p = 0; p < on.length; p++) { if (on[p] !== v) { out.push(n.toString(36)); v = on[p]; n = 0; } n++; }
    out.push(n.toString(36));
    return out.join(',');
  }
  // encodeRuns 的反向：長度 n 的 0／1 陣列
  function decodeRuns(r, n) {
    const a = new Uint8Array(n);
    let p = 0, v = 0;
    for (const s of r.split(',')) { const k = parseInt(s, 36); if (v) a.fill(1, p, p + k); p += k; v ^= 1; }
    return a;
  }
  // 外框指紋：只看這顆岩點自己的外框（隔壁岩點改了影響很小，不重算）。算法改了就加 MASK_VER，舊的資料全部重算
  // 版本：2＝手動改過、手畫、MobileSAM 重描過的岩點整個外框都上色（不做顏色判斷）
  // 3＝每筆加上代表色 c、色調 t（整面牆在岩點階段就算好）；4＝深處被判成板子太多就整個外框上色
  const MASK_VER = 4;
  function maskSig(poly) {
    let x = 0x811c9dc5 ^ MASK_VER;
    for (const [a, b] of poly) for (const v of [Math.round(a * 10), Math.round(b * 10)]) { x ^= v & 0xffff; x = Math.imul(x, 16777619); x ^= v >>> 16; x = Math.imul(x, 16777619); }
    return (x >>> 0).toString(36);
  }

  // ---------- 偵測框 → 岩點輪廓 ----------
  // 每個框各自分辨「岩點」和「牆」：牆的顏色取框外一圈（不含別的岩點框），岩點的顏色取框中央的幾個代表色
  //（大岩點有亮面、陰影、鎂粉，一個顏色代表不了）。每個像素看離哪一邊的代表色近，迭代兩次修正代表色，
  // 再去雜點、補鎂粉和螺絲孔的洞，取包含框中央最多的連通區域的凸包。抓不到合理區域時退回框的內切橢圓。
  const newCanvas = (w, h) => {
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
    c.width = w; c.height = h; return c;
  };
  // 分析用的縮圖（長邊最多 1200）：img 是畫布或圖片，W、H 是照片尺寸
  function analysis(img, W, H, createCanvas = newCanvas) {
    const s = Math.min(1, 1200 / Math.max(W, H));
    const w = Math.round(W * s), h = Math.round(H * s);
    const ac = createCanvas(w, h).getContext('2d'); ac.drawImage(img, 0, 0, w, h);
    return { data: ac.getImageData(0, 0, w, h).data, w, h, s };
  }
  // ana：analysis() 的結果（整張 Lab 第一次用到時算好、存在 ana.lab）；boxes：偵測框 [[x0, y0, x1, y1], ...]（照片座標）
  function outlineContext(ana, boxes) {
    const { data, w, h, s } = ana;
    if (!ana.lab) ana.lab = toLab(data, w * h);   // 整張只算一次
    const cover = new Uint8Array(w * h);   // 有幾個偵測框蓋到這個像素
    for (const [x0, y0, x1, y1] of boxes) {
      const bx0 = Math.max(0, Math.floor(x0 * s)), bx1 = Math.min(w - 1, Math.ceil(x1 * s));
      for (let y = Math.max(0, Math.floor(y0 * s)); y <= Math.min(h - 1, Math.ceil(y1 * s)); y++)
        for (let x = bx0; x <= bx1; x++) if (cover[y * w + x] < 255) cover[y * w + x]++;
    }
    return { lab: ana.lab, cover, w, h, s };
  }
  function boxToPoly(x0, y0, x1, y1, ctx) {
    const { w, h, s, lab, cover } = ctx;
    const ax0 = Math.max(0, Math.floor(x0 * s)), ay0 = Math.max(0, Math.floor(y0 * s));
    const ax1 = Math.min(w - 1, Math.ceil(x1 * s)), ay1 = Math.min(h - 1, Math.ceil(y1 * s));
    const bw = ax1 - ax0 + 1, bh = ay1 - ay0 + 1;
    const ellipse = () => ellipsePoly((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 * 0.9, (y1 - y0) / 2 * 0.9);
    if (bw < 5 || bh < 5) return ellipse();
    // 牆：框外一圈（寬＝框的 12%），不含別的岩點框；四周都是岩點時改用框的邊
    const mg = Math.max(3, Math.floor(0.12 * Math.max(bw, bh)));
    const bg = [];
    for (let y = Math.max(0, ay0 - mg); y <= Math.min(h - 1, ay1 + mg); y++) for (let x = Math.max(0, ax0 - mg); x <= Math.min(w - 1, ax1 + mg); x++) {
      if (x >= ax0 && x <= ax1 && y >= ay0 && y <= ay1) continue;
      const i = y * w + x;
      if (!cover[i]) bg.push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    }
    if (bg.length < 60) for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
      if (x !== ax0 && x !== ax1 && y !== ay0 && y !== ay1) continue;
      const i = y * w + x; bg.push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    }
    // 框內像素（Lab）與中央 40%
    const P = new Float32Array(bw * bh * 3), center = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (ay0 + y) * w + ax0 + x, k = (y * bw + x) * 3;
      P[k] = lab[i * 3]; P[k + 1] = lab[i * 3 + 1]; P[k + 2] = lab[i * 3 + 2];
      if (y >= Math.floor(bh * 0.3) && y < Math.ceil(bh * 0.7) && x >= Math.floor(bw * 0.3) && x < Math.ceil(bw * 0.7)) center.push(P[k], P[k + 1], P[k + 2]);
    }
    let BG = kmeans(samplePts(bg, 600), 3), FG = kmeans(samplePts(center, 600), 3);
    const fgKeep = [];   // 中央跟牆很像的代表色（框中央露出的牆）不算岩點
    for (let j = 0; j < FG.length; j += 3) if (nearest(FG[j], FG[j + 1], FG[j + 2], BG) > 12) fgKeep.push(FG[j], FG[j + 1], FG[j + 2]);
    if (fgKeep.length) FG = fgKeep;
    let mask = new Uint8Array(bw * bh);
    for (let it = 0; it < 2; it++) {
      const fg = [], rest = bg.slice();
      for (let p = 0; p < bw * bh; p++) {
        const l = P[p * 3], a = P[p * 3 + 1], b = P[p * 3 + 2];
        mask[p] = nearest(l, a, b, FG) < nearest(l, a, b, BG) * 0.85 ? 1 : 0;
        if (mask[p]) fg.push(l, a, b); else rest.push(l, a, b);
      }
      if (fg.length < 30) return ellipse();
      FG = kmeans(samplePts(fg, 800), 4); BG = kmeans(samplePts(rest, 800), 4);
    }
    // 去雜點（3×3 開運算）、補縫（閉運算）、補洞
    mask = morph(morph(mask, bw, bh, 1, false), bw, bh, 1, true);
    const r = Math.max(1, Math.floor(0.04 * Math.max(bw, bh)));
    mask = closeMask(mask, bw, bh, r);
    const outside = new Uint8Array(bw * bh), stack = [];   // 從框邊灌進來的背景；灌不到的洞補起來
    for (let x = 0; x < bw; x++) for (const y of [0, bh - 1]) if (!mask[y * bw + x] && !outside[y * bw + x]) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    for (let y = 0; y < bh; y++) for (const x of [0, bw - 1]) if (!mask[y * bw + x] && !outside[y * bw + x]) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    while (stack.length) {
      const p = stack.pop(), x = p % bw, y = (p / bw) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1])
        if (q >= 0 && !mask[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
    }
    for (let p = 0; p < mask.length; p++) if (!outside[p]) mask[p] = 1;
    // 包含框中央最多的連通區域
    const lab2 = new Int32Array(bw * bh);
    const cx0 = bw * 0.25, cx1 = bw * 0.75, cy0 = bh * 0.25, cy1 = bh * 0.75;
    let best = null, bestCentral = 0, n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || lab2[i]) continue;
      const id = ++n, st = [i], pts = []; lab2[i] = id; let central = 0;
      while (st.length) {
        const p = st.pop(), x = p % bw, y = (p / bw) | 0;
        pts.push(p);
        if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) central++;
        if (x > 0 && mask[p - 1] && !lab2[p - 1]) { lab2[p - 1] = id; st.push(p - 1); }
        if (x < bw - 1 && mask[p + 1] && !lab2[p + 1]) { lab2[p + 1] = id; st.push(p + 1); }
        if (y > 0 && mask[p - bw] && !lab2[p - bw]) { lab2[p - bw] = id; st.push(p - bw); }
        if (y < bh - 1 && mask[p + bw] && !lab2[p + bw]) { lab2[p + bw] = id; st.push(p + bw); }
      }
      if (central > bestCentral) { bestCentral = central; best = pts; }
    }
    if (!best || best.length < 0.10 * bw * bh) return ellipse();
    const hull = convexHull(best.map(p => [ax0 + (p % bw), ay0 + ((p / bw) | 0)]));
    if (hull.length < 3) return ellipse();
    return hull.map(([x, y]) => [+((x + 0.5) / s).toFixed(1), +((y + 0.5) / s).toFixed(1)]);
  }

  // ---------- 岩點資料包的一筆（格式見 SPEC.md） ----------
  // 路線岩點保留彩色的範圍：只留岩點本身。外框是凸多邊形，凹處和邊緣會包到板子，
  // 所以外框內的像素跟外圍一圈的板子顏色比（不含別的岩點），比較像板子的維持灰階。
  // 外框中央 50% 一定保留，板子跟岩點同色時不會整顆變灰；判斷出來太少（< 28%）就整個外框都保留。
  // 外框是準的（改過、手畫，或 MobileSAM 重描過：source 不是 'detect'，或 traced）就整個外框都上色：顏色判斷碰到深色岩點會把它的影子
  // 當成牆，反而把岩點本身切掉（例如黑色大岩點只剩 30% 有顏色）
  // - 彩色範圍（x, y, w, h, r）；外框是準的就是 none＝整個外框
  // - c：代表色 [L, a, b]（彩色範圍內彩度最高的一半的中位數；扣掉像板子的像素，選同色比較準）
  // - t：路線色調用的顏色 [a, b]（外框中央 50% 的平均）
  // ctx：{ img（有 getContext('2d') 的照片畫布）, W, H（照片尺寸）, holds（整面牆的岩點，用來排除別的岩點）, createCanvas?(w, h) }
  function holdEntry(h, ctx) {
    const mk = ctx.createCanvas || newCanvas;
    const exact = h.source !== 'detect' || h.traced;
    const W = ctx.W, H = ctx.H, b = bbox(h.poly);
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0), mg = Math.max(4, Math.round(size * 0.15));
    const x0 = Math.max(0, Math.floor(b.x0) - mg), y0 = Math.max(0, Math.floor(b.y0) - mg);
    const x1 = Math.min(W, Math.ceil(b.x1) + mg), y1 = Math.min(H, Math.ceil(b.y1) + mg), w = x1 - x0, hh = y1 - y0;
    if (w < 4 || hh < 4) return { none: 1, c: 0, t: [0, 0] };
    // 範圍圖：紅＝這顆外框內、綠＝中央 50%、藍＝別的岩點
    const g = mk(w, hh).getContext('2d'); g.translate(-x0, -y0);
    g.fillStyle = 'rgb(0,0,255)';
    if (!exact) for (const o of ctx.holds) {
      if (o === h) continue;
      const ob = bbox(o.poly);
      if (ob.x1 < x0 || ob.x0 > x1 || ob.y1 < y0 || ob.y0 > y1) continue;
      g.beginPath(); tracePoly(g, o.poly); g.fill();
    }
    g.fillStyle = 'rgb(255,0,0)'; g.beginPath(); tracePoly(g, h.poly); g.fill();
    const [cx, cy] = centroid(h.poly);
    g.fillStyle = 'rgb(255,255,0)'; g.beginPath(); tracePoly(g, h.poly.map(([x, y]) => [cx + (x - cx) * 0.5, cy + (y - cy) * 0.5])); g.fill();
    const reg = g.getImageData(0, 0, w, hh).data;
    const lab = toLab(ctx.img.getContext('2d').getImageData(x0, y0, w, hh).data, w * hh);
    let ta = 0, tb = 0, tn = 0;
    for (let p = 0; p < w * hh; p++) if (reg[p * 4] > 127 && reg[p * 4 + 1] > 127) { ta += lab[p * 3 + 1]; tb += lab[p * 3 + 2]; tn++; }
    const t = tn ? [Math.round(ta / tn), Math.round(tb / tn)] : [0, 0];
    // 外框 75% 的範圍（深處）：判斷成板子的像素跑到深處，多半是鎂粉、反光讓岩點變淡，不是板子（板子只會在外框邊緣、凹處露出來）
    let mid = null;
    if (!exact) {
      const mg2 = mk(w, hh).getContext('2d'); mg2.translate(-x0, -y0); mg2.fillStyle = '#fff';
      mg2.beginPath(); tracePoly(mg2, h.poly.map(([x, y]) => [cx + (x - cx) * 0.75, cy + (y - cy) * 0.75])); mg2.fill();
      mid = mg2.getImageData(0, 0, w, hh).data;
    }
    const on = exact ? null : colorMask(reg, lab, w, hh, size, mid);
    const c = repColor(lab, w * hh, on ? (p) => on[p] : (p) => reg[p * 4] > 127);
    return on ? { x: x0, y: y0, w, h: hh, r: encodeRuns(on), c, t } : { none: 1, c, t };
  }
  // 彩色範圍：外框內的像素跟外圍一圈的板子顏色比（不含別的岩點），比較像板子的不算；判斷失敗回傳 null（整個外框都上色）
  // reg：範圍圖（RGBA；紅＝外框內、綠＝中央 50%、藍＝別的岩點），mid：外框 75% 的範圍（RGBA，紅＝內）
  function colorMask(reg, lab, w, hh, size, mid) {
    const inPts = [], bgPts = [];
    let inside = 0;
    for (let p = 0; p < w * hh; p++) {
      const l = lab[p * 3], a = lab[p * 3 + 1], bb = lab[p * 3 + 2];
      if (reg[p * 4] > 127) { inside++; inPts.push(l, a, bb); } else if (reg[p * 4 + 2] < 128) bgPts.push(l, a, bb);
    }
    if (!inside || bgPts.length < 60) return null;
    const BG = kmeans(samplePts(bgPts, 600), 3);
    let FG = kmeans(samplePts(inPts, 600), 3);
    const keep = [];
    for (let j = 0; j < FG.length; j += 3) if (nearest(FG[j], FG[j + 1], FG[j + 2], BG) > 12) keep.push(FG[j], FG[j + 1], FG[j + 2]);
    if (keep.length) FG = keep;
    let on = new Uint8Array(w * hh), cnt = 0;
    for (let p = 0; p < w * hh; p++) {
      if (reg[p * 4] <= 127) continue;
      const l = lab[p * 3], a = lab[p * 3 + 1], bb = lab[p * 3 + 2];
      if (reg[p * 4 + 1] > 127 || nearest(l, a, bb, FG) < nearest(l, a, bb, BG) * 1.15) { on[p] = 1; cnt++; }
    }
    if (cnt < 0.28 * inside) return null;   // 中央 50% 就佔約 25%：幾乎只剩中央表示判斷失敗
    on = closeMask(on, w, hh, Math.max(1, Math.round(size * 0.03)));   // 補鎂粉、螺絲孔造成的小缺口
    for (let p = 0; p < w * hh; p++) if (reg[p * 4] <= 127) on[p] = 0;   // 補縫可能補到外框外，先切回外框內
    // 被岩點整個圍住的灰色區塊（陰影、反光被當成板子）補回來：從外框外面灌不到的就是洞
    const reach = new Uint8Array(w * hh), st = [];
    for (let p = 0; p < w * hh; p++) if (!on[p] && reg[p * 4] <= 127) { reach[p] = 1; st.push(p); }
    while (st.length) {
      const p = st.pop(), x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < hh - 1 ? p + w : -1])
        if (q >= 0 && !on[q] && !reach[q]) { reach[q] = 1; st.push(q); }
    }
    for (let p = 0; p < w * hh; p++) if (!reach[p]) on[p] = 1;
    for (let p = 0; p < w * hh; p++) if (reg[p * 4] <= 127) on[p] = 0;
    // 深處（外框 75% 內、中央 50% 外）有超過 15% 被判成板子：判斷不可靠（例如完攀點上半部沾滿鎂粉），整個外框都上色
    let deep = 0, off = 0;
    for (let p = 0; p < w * hh; p++) if (mid[p * 4] > 127 && reg[p * 4 + 1] <= 127) { deep++; if (!on[p]) off++; }
    if (deep && off > deep * 0.15) return null;
    return on;
  }
  // 收到的 px（不可信的資料）：格式不對的整筆丟掉，只留規格裡的欄位（SPEC.md）
  function cleanPx(px) {
    const out = {};
    if (!px || typeof px !== 'object') return out;
    for (const [id, m] of Object.entries(px)) {
      if (!m || typeof m.s !== 'string') continue;
      let e = null;
      if (m.none === 1) e = { s: m.s, none: 1 };
      else if ([m.x, m.y, m.w, m.h].every(Number.isInteger) && m.w > 0 && m.h > 0 && m.w * m.h <= 4e6 && typeof m.r === 'string' && /^[0-9a-z,]*$/.test(m.r))
        e = { s: m.s, x: m.x, y: m.y, w: m.w, h: m.h, r: m.r };
      const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
      if (!e || !(m.c === 0 || nums(m.c, 3)) || !nums(m.t, 2)) continue;   // 代表色（0＝判斷不出來）、色調都要有
      e.c = m.c; e.t = m.t; out[id] = e;
    }
    return out;
  }

  return {
    VERSION, MASK_VER, SAME_DE, COLOR,
    bbox, centroid, tracePoly, convexHull, ellipsePoly, simplifyPoly,
    toLab, samplePts, kmeans, nearest, repColor, colorName,
    morph, closeMask, encodeRuns, decodeRuns, maskSig,
    analysis, outlineContext, boxToPoly, holdEntry, colorMask, cleanPx,
  };
});
