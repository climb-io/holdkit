# holdkit

攀岩牆岩點階段的分析：偵測框 → 岩點外框、MobileSAM 重描外框、每顆岩點的彩色範圍與顏色。Apache-2.0。

岩點偵測（照片 → 框）在 [climb-io/holdscan](https://github.com/climb-io/holdscan)（AGPL-3.0），
App 是 Climbio。三者之間只交換資料（框的陣列、[岩點資料包](SPEC.md)），holdkit 不含、也不呼叫 holdscan 的程式。

## 結構

| 路徑 | 內容 |
|---|---|
| `holdkit.js` | 分析函式（瀏覽器全域 `HoldKit`，Node 用 `require`）：外框、彩色範圍、代表色、色調、外框指紋 |
| `samrefine.js`、`samworker.js` | 瀏覽器的 MobileSAM 重描（全域 `HoldRefiner`）：照片在雲端分析一次、整面牆一起描，照片特徵存在瀏覽器；之後單顆重描在 Worker 裡只跑解碼器（CPU） |
| `functions/` | 雲端重描函式 `retrace`（Firebase，asia-east1，CPU）：分析照片、整面牆重描、回傳照片特徵 |
| `models/` | MobileSAM 的 ONNX 模型，來源見 `models/README.md`：encoder（28 MB）只在雲端函式用，瀏覽器只下載 decoder（16 MB） |
| `SPEC.md` | 岩點資料包 v1 的格式 |

## 用法（瀏覽器）

把整個資料夾放在網站上（`samrefine.js` 用相對路徑 `models/` 抓模型），依序載入：

```html
<script src="holdkit/holdkit.js"></script>
<script src="holdkit/samrefine.js"></script>
```

```js
// 偵測框（例如 holdscan 回傳的 boxes）→ 外框
const ana = HoldKit.analysis(photoCanvas, W, H);          // 分析用縮圖（長邊 1200）
const octx = HoldKit.outlineContext(ana, boxes);
const holds = boxes.map(([x0, y0, x1, y1], i) => ({ id: `h${i}`, source: 'detect',
  poly: HoldKit.simplifyPoly(HoldKit.boxToPoly(x0, y0, x1, y1, octx)) }));

// 每顆岩點的資料（岩點資料包的 px）
const px = {};
for (const h of holds) px[h.id] = { ...HoldKit.holdEntry(h, { img: photoCanvas, W, H, holds }), s: HoldKit.maskSig(h.poly) };

// 選同色
HoldKit.colorName(px.h0.c);   // '紅'、'藍'…（COLOR 的 key）

// MobileSAM 重描：整面牆送雲端（照片特徵跟著存在瀏覽器的 IndexedDB，每張照片一份）
HoldRefiner.configure({ t: myTranslate, db: 'my-sam', cloudUrl: RETRACE_URL, idToken: () => user.getIdToken() });
HoldRefiner.warm();                                    // 背景下載、載入解碼器
const res = await HoldRefiner.traceWall(photoCanvas, wallId, holds.map((h, i) => ({ id: h.id, poly: h.poly, box: boxes[i] })));

// 單顆重描（Worker，CPU 只跑解碼器）：框當提示，或沒偵測到的岩點用一個點當提示；沒有這張照片的特徵就先跟雲端要
const poly = await HoldRefiner.refine(photoCanvas, wallId, holds[0].poly, console.log);
const added = await HoldRefiner.refine(photoCanvas, wallId, null, console.log, { point: [x, y] });
HoldRefiner.forget(wallId);                            // 刪掉這張照片的特徵（牆刪了）；clear() 全部刪掉
```

同一張照片、同一個提示的 `refine` 共用同一份結果：可以先呼叫一次（例如手指按下、長按還沒成立時），之後再呼叫拿到的是同一個 Promise。

`holdEntry` 要畫布：瀏覽器用 `document.createElement('canvas')`，Worker 用 `OffscreenCanvas`，Node 傳 `createCanvas`（例如 node-canvas）。

## 版本

用 git 標記（`v1.0.0`…）發布。App 依標記下載整個資料夾（模型超過 jsDelivr 單檔上限，不用 CDN），
同一個標記的結果固定。改了 `holdEntry` 的算法要加 `MASK_VER`（舊資料自動重算），改 `boxToPoly` 的做法 App 自己決定要不要重新辨識。

## 雲端重描

`POST https://asia-east1-firebase-climbio.cloudfunctions.net/retrace`

- 標頭：`Authorization: Bearer <Firebase ID token>`（匿名登入也可以）
- 內容：`{ "img": "<JPEG base64，長邊 1024>", "holds": [{ "id", "box": [x0, y0, x1, y1], "c": [cx, cy] }] }`（座標是送上來的照片座標；`holds` 可以是空的，只要照片特徵）
- 回傳：`{ "holds": [{ "id", "poly" }], "emb": { "q": "<base64，256×64×64 個 uint8>", "lo": [256], "sc": [256], "w", "h" }, "ms": {...} }`
  - `emb` 是照片特徵（MobileSAM 的 image_embeddings），每個通道 `lo + q × sc`（int8 量化，跟 float32 解碼出來的遮罩 IoU 平均 0.999）；`w`、`h` 是送上來的照片大小

照片只在處理當下存在伺服器記憶體中，不存檔、不留紀錄。

部署（Firebase 專案 firebase-climbio，codebase `holdkit`）：

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions:holdkit
```

predeploy 把 `models/` 的兩個模型複製進 `functions/models/`；`functions/.npmrc` 關掉 onnxruntime-node 安裝時下載 GPU（CUDA）版本。

## 授權

Apache-2.0（見 `LICENSE`）。第三方元件（MobileSAM、Acly 的 ONNX 匯出、ONNX Runtime）見 `NOTICE`。
