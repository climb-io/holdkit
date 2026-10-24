// holdkit：岩點階段的分析（偵測框 → 外框、顏色），Apache-2.0。
// 不依賴任何 App 的狀態：照片、框、外框都從參數傳入。瀏覽器用 <script src="holdkit.js"> 載入成全域 HoldKit；
// Node 用 require('./holdkit.js')（analysis 要畫布，傳 createCanvas，例如 node-canvas 的 createCanvas）。
//
// 主要介面（座標都是照片像素；外框 poly＝[[x, y], ...]）：
//   analysis(img, W, H)                 → 分析用縮圖 { data, w, h, s }（長邊最多 1200）
//   outlineContext(ana, boxes)          → 辨識外框用的資料（整張 Lab、每個像素被幾個框蓋到）
//   boxToPoly(x0, y0, x1, y1, octx)     → 偵測框 → 岩點外框（凸包；失敗時是框的內切橢圓）
//   simplifyPoly(poly)                  → 外框精簡
//   colorName(c)、COLOR、SAME_DE        → 選同色用
(function (root, factory) {
  const HK = factory();
  if (typeof module === 'object' && module.exports) module.exports = HK;
  else root.HoldKit = HK;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.8.0';

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

  return {
    VERSION, SAME_DE, COLOR,
    bbox, centroid, tracePoly, convexHull, ellipsePoly, simplifyPoly,
    toLab, samplePts, kmeans, nearest, repColor, colorName,
    morph, closeMask,
    analysis, outlineContext, boxToPoly,
  };
});
