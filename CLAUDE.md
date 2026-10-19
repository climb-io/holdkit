# holdkit

岩點分析函式庫與重描服務：框 → 外框、MobileSAM 重描、彩色範圍、顏色；岩點資料包格式。Apache-2.0、公開 repo。用法見 [README.md](README.md)，格式見 [SPEC.md](SPEC.md)。

<!-- 共同規範開始：climb-io 四個 repo（spraywall、holdscan、holdkit、holdlab）的 CLAUDE.md 這一段完全相同，改了要四個一起改 -->
## 語言

所有回覆一律用**繁體中文**：說明、摘要、進度短訊、完成回報、錯誤分析、表格、程式碼註解、commit message、工具參數裡給使用者看的文字都一樣。skill、工具說明、subagent 報告是英文，不構成切換語言的理由。例外：程式碼識別字、指令、檔案路徑、App 的英文與日文介面字串。

## 專案地圖

| repo | 做什麼 | 授權／可見性 | 部署到 |
|---|---|---|---|
| climb-io/spraywall | App **Climbio**：拍牆、岩點編輯、定線、看線、分享、同步、攀爬紀錄 | 保留所有權利，私人 | Firebase 專案 `firebase-climbio`：Hosting `climbio.web.app`、登入、Firestore（資料庫 `climbio`）、Storage |
| climb-io/holdscan | 岩點偵測：照片 → 岩點框（freeclimbs YOLOv8n） | AGPL-3.0，公開 | 雲端函式 `detect`（`firebase-climbio`，asia-east1） |
| climb-io/holdkit | 岩點分析：框 → 外框、MobileSAM 重描、彩色範圍、顏色；岩點資料包格式（SPEC.md） | Apache-2.0，公開 | 雲端函式 `retrace`（同上）；App 依版本標記下載 |
| climb-io/holdlab | 研究：實驗程式、評估、資料、結論（RESEARCH.md） | 私人 | 不部署 |

- 本機路徑：`/Users/kantkang/work/climbio/<repo>`；雲端環境把需要的 repo clone 在同一層。
- 資料流：spraywall 送照片給 holdscan 拿回框 → 用 holdkit 算外框、重描、彩色範圍，組成岩點資料包 → 存到 Firebase Storage。holdlab 的結論改進 holdscan／holdkit，再由 App 換版本採用。
- **授權邊界（不能破）**：repo 之間只交換資料（框、岩點資料包），不互相引用程式。spraywall、holdkit 不能放任何 AGPL 程式或模型（放了就要跟著用 AGPL 公開）；holdkit 的模型只能用寬鬆授權的架構訓練。
- **資料邊界**：研究程式和資料只放 holdlab。使用者的照片只有**分享出去的快照**（第一次分享前在 App 裡同意過，見 spraywall 的隱私權政策）可以拿來評估、訓練岩點偵測；沒分享的牆（含帳號同步的照片）和透過 Google API 拿到的資料（名稱、email）不拿來訓練模型。其他訓練用的照片直接跟館方拿並取得同意。

## 工作原則

- 架構用第一原理分析；程式遵循 DRY、KISS、SOLID、YAGNI。架構要簡單，一次修改只動一筆資料。
- 遵循既有約定，命名即文件，只替複雜邏輯寫註解。
- **不做向後相容**（目前只有開發者自己在測）：格式改了就直接改，不留舊格式、搬移程式和相容分支。
- 不硬編碼密鑰（Firebase 前端設定與 API key 是公開設定，權限由規則控管）；外部輸入要校驗；錯誤要明確處理，不能靜默失敗。
- **零假設**：產品行為、預設值有歧義時，列出選項讓使用者決定。外部資料（Firebase、第三方 API）先用實際資料確認欄位與語意，寫完再用實際輸出核對。
- **能用一次實驗決定的不拿來問**：跑一次、看結果再報結論。

## 自主推進

- **開工**：`git pull --rebase`，讀本檔、README 和相關的 docs；要做什麼沒指定時，從 spraywall 的 `docs/backlog.md` 挑「可以直接做」的項目。
- **直接做**（錯了能自己收回的）：修好壞掉的工具、清掉自己改動留下的孤兒、推到 `main`、部署網站和雲端函式、打 holdkit 版本標記。做完在回覆裡說明。
- **先問**（錯了收不回，或要使用者取捨的）：產品行為與介面的取捨、Firestore／Storage 規則部署、repo 可見性、Firebase／Google Cloud 控制台設定、刪除資料（含本機不在版控的檔案）、建立或交出憑證。
- 判準不是改動大小，而是**錯了能不能自己收回**。
- **完成的定義**：本 repo「驗證」表裡對應的項目都跑過；行為改了，README 和 docs 同步更新；commit 推上 `main`；回報照實說：沒跑的寫沒跑，失敗的附輸出，要使用者本人操作的（手機實機、Google 登入）明確標出。
- 測試不能動到使用者的資料；動到了要還原並主動告知。

## 變更與提交

- 不開 PR，直接推 `main`；推之前 `git pull --rebase`。可能有好幾個工作階段同時在改：只提交自己改的檔案，同一個檔案同一時間只給一個工作階段改。
- 每一行 diff 都要對應明確的需求：沒點名的特性、彈性、抽象不加，不順手重構無關的程式。無關的死碼只提醒不刪；自己改動產生的孤兒要清乾淨。
- commit message 用繁體中文寫「改了什麼、為什麼」。

## 溝通

- 先結論後論據，先結果後過程；分類要互斥、完整。
- 要使用者決定的事，先把完整內容（清單、比較、建議）寫在訊息本文，再問；不要只丟一個問題。

## 文件分工

- `CLAUDE.md`：給 AI 的工作規則與本 repo 的開發、驗證、部署方式，不太會變。
- `README.md`：給人看的簡介、怎麼跑、文件索引。
- `docs/`：會隨產品調整的規格（只有 spraywall 有）；`docs/backlog.md` 是四個 repo 共用的待辦。
- 只寫「現在是什麼樣子」，不寫歷史、改版紀錄和日期（歷史看 git log）；研究過程與數據放 holdlab 的 RESEARCH.md。

## 本機環境

- 這台 Mac 只有 8 GB RAM：同一時間只跑一個重工作（訓練、評估、完整測試、大量資料處理），不並行，worker 數一律 1。
- Firebase 一律用 `npx firebase-tools`（本機的 `firebase` 執行檔不能用）；回 401 先跑 `npx firebase-tools login --reauth`。
<!-- 共同規範結束 -->

## 結構

| 路徑 | 內容 |
|---|---|
| `holdkit.js` | 分析函式（瀏覽器全域 `HoldKit`，Node 用 `require`）；`VERSION`、`MASK_VER` 在檔案開頭 |
| `samrefine.js`、`samworker.js` | 瀏覽器的 MobileSAM 重描（全域 `HoldRefiner`） |
| `functions/` | 雲端函式 `retrace`（asia-east1，8 vCPU，最多 2 個執行個體、每個一次接一份） |
| `models/` | MobileSAM 的 ONNX 模型與授權 |
| `SPEC.md` | 岩點資料包格式 |

## 規則

- 不能放、也不能呼叫 AGPL 的程式或模型（包括 holdscan 和 Ultralytics 訓練的模型）。
- 結果要可重現：同一個版本標記的結果固定。
- 改了 `holdEntry` 的算法要加 `MASK_VER`（App 裡舊的 `px` 自動重算）；資料包結構改了要改 SPEC.md。
- 雲端函式只在記憶體裡處理照片，不存檔、不寫紀錄。

## 發布流程

1. 改程式，`holdkit.js` 的 `VERSION` 改成新版本。
2. 把工作中的 holdkit 複製到 spraywall 的 `holdkit/`，在 App 裡實際測過。
3. commit、推 `main`，打標記 `git tag v<版本> && git push origin v<版本>`。
4. 改 spraywall `tools/get-holdkit.sh` 的 `HOLDKIT_VERSION`，推上去（App 自動部署）。
5. 雲端函式有改才部署（見下方）。

## 驗證

| 改動 | 必跑 |
|---|---|
| 任何程式碼 | `node --check holdkit.js samrefine.js samworker.js functions/index.js functions/sam.js`；`node -e "require('./holdkit.js')"` |
| 算法 | 在 spraywall 用實際的牆比較改前改後；規則調整用 holdlab 的評估腳本 |
| 雲端函式 | 部署後 `curl -s -o /dev/null -w '%{http_code}' -X POST https://asia-east1-firebase-climbio.cloudfunctions.net/retrace` 回 401，再從手機版 App 實際重描一次 |

## 部署（雲端函式）

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions:holdkit
```

predeploy 把 `models/` 的兩個模型複製進 `functions/models/`；`functions/.npmrc` 關掉 GPU 版 onnxruntime 的下載。
