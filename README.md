# holdkit

攀岩牆岩點階段的分析：偵測框 → 岩點外框、MobileSAM 重描外框、顏色名稱。Apache-2.0。

岩點偵測（照片 → 框）在 [climb-io/holdscan](https://github.com/climb-io/holdscan)（AGPL-3.0），
App 是 Climbio。三者之間只交換資料（框的陣列、[岩點資料包](SPEC.md)），holdkit 不含、也不呼叫 holdscan 的程式。

## 結構

| 路徑 | 內容 |
|---|---|
| `holdkit.js` | 分析函式（瀏覽器全域 `HoldKit`，Node 用 `require`）：外框、顏色名稱 |
| `samrefine.js`、`samworker.js` | 瀏覽器的 MobileSAM 重描（全域 `HoldRefiner`）：照片在雲端分析一次、整面牆一起描，照片特徵存在瀏覽器；之後單顆重描在 Worker 裡只跑解碼器（CPU） |
| `functions/` | 雲端重描函式 `retrace`（Firebase，asia-east1，CPU）：分析照片、整面牆重描（岩點分給每個 vCPU 一個解碼 Worker 同時描，`decode.js`）、回傳照片特徵 |
| `models/` | MobileSAM 的 ONNX 模型，來源見 `models/README.md`：encoder（28 MB）只在雲端函式用，瀏覽器只下載 decoder（16 MB） |
| `SPEC.md` | 岩點資料包 v2 的格式 |

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

// 顏色名稱（Lab 顏色 → '紅'、'藍'…，COLOR 的 key；選同色用）
HoldKit.colorName(lab);

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

`analysis` 要畫布：瀏覽器用 `document.createElement('canvas')`，Worker 用 `OffscreenCanvas`，Node 傳 `createCanvas`（例如 node-canvas）。

## 版本

用 git 標記（`v1.0.0`…）發布。App 依標記下載整個資料夾（模型超過 jsDelivr 單檔上限，不用 CDN），
同一個標記的結果固定。改 `boxToPoly` 的做法 App 自己決定要不要重新辨識。

## 雲端重描

`POST https://asia-east1-firebase-climbio.cloudfunctions.net/retrace`

- 標頭：`Authorization: Bearer <Firebase ID token>`（匿名登入也可以）
- 內容：`{ "img": "<JPEG base64，長邊 1024>", "holds": [{ "id", "box": [x0, y0, x1, y1], "c": [cx, cy] }] }`（座標是送上來的照片座標；`holds` 可以是空的，只要照片特徵）
- 回傳：`{ "holds": [{ "id", "poly" }], "emb": { "q": "<base64，256×64×64 個 uint8>", "lo": [256], "sc": [256], "w", "h" }, "ms": {...} }`
  - `emb` 是照片特徵（MobileSAM 的 image_embeddings），每個通道 `lo + q × sc`（int8 量化，跟 float32 解碼出來的遮罩 IoU 平均 0.999）；`w`、`h` 是送上來的照片大小

`GET` 同一個網址＝預熱：執行個體開機、載入模型後回 204（不帶資料、不用登入）。App 在使用者選照片時先送一個，等真的送整面牆來就不用再等冷啟動。

照片只在處理當下存在伺服器記憶體中，不存檔、不寫進紀錄（紀錄只有岩點數和耗時）。

## 授權

Apache-2.0（見 `LICENSE`）。第三方元件（MobileSAM、Acly 的 ONNX 匯出、ONNX Runtime）見 `NOTICE`。
