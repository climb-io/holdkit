# holdkit

岩點分析函式庫與重描服務：框 → 外框、MobileSAM 重描、顏色；岩點資料包格式。Apache-2.0、公開 repo。結構、用法與雲端重描的介面見 [README.md](README.md)，格式見 [SPEC.md](SPEC.md)。

<!-- 共同規範開始：climb-io 四個 repo（spraywall、holdscan、holdkit、holdlab）的 CLAUDE.md 這一段完全相同，改了要四個一起改 -->
## 語言

- 回覆、文件（README、docs）、程式碼註解、commit message、工具參數裡給使用者看的文字，一律用**繁體中文**。例外：程式碼識別字、指令、檔案路徑、App 的英文與日文介面字串。
- 沒有例外情境：對話壓縮後接續、背景任務或 CI 通知後的回覆、進度短訊、完成回報都一樣；skill、工具說明、subagent 報告、工具輸出是英文，也不跟著換。送出前檢查一次語言。
- 引用英文原文（錯誤訊息、外部說明、網頁內容）先寫中文意思；原文只在需要查證時附在後面。

## 專案地圖

| repo | 做什麼 | 授權／可見性 | 部署到 |
|---|---|---|---|
| climb-io/spraywall | App **Climbio**：拍牆、岩點編輯、定線、看線、分享、同步、攀爬紀錄 | 保留所有權利，私人 | Firebase 專案 `firebase-climbio`：Hosting `climbio.web.app`、登入、Firestore（資料庫 `climbio`）、Storage |
| climb-io/holdscan | 岩點偵測：照片 → 岩點框（freeclimbs YOLOv8n） | AGPL-3.0，公開 | 雲端函式 `detect`（`firebase-climbio`，asia-east1） |
| climb-io/holdkit | 岩點分析：框 → 外框、MobileSAM 重描、顏色；岩點資料包格式（SPEC.md） | Apache-2.0，公開 | 雲端函式 `retrace`（同上）；App 依版本標記下載 |
| climb-io/holdlab | 研究：實驗程式、評估、資料、結論（RESEARCH.md） | 私人 | 不部署 |

- 本機路徑：`/Users/kantkang/work/climbio/<repo>`；雲端環境把需要的 repo clone 在同一層。
- 資料流：spraywall 送照片給 holdscan 拿回框 → 用 holdkit 算外框、重描，組成岩點資料包 → 存到 Firebase Storage。holdlab 的結論改進 holdscan／holdkit，再由 App 換版本採用。
- **授權邊界（不能破）**：repo 之間只交換資料（框、岩點資料包），不互相引用程式。spraywall、holdkit 不能放任何 AGPL 程式或模型（放了就要跟著用 AGPL 公開）；holdkit 的模型只能用寬鬆授權的架構訓練。
- **私有邊界**：不想讓別人直接拿去用的優化（外框整理、調過的參數和門檻、自己訓練或改良的模型權重、靠使用者資料才做得出來的功能）放 spraywall 的雲端函式（`spraywall/functions`，App 只拿到結果；例如 `tidy`）。不放公開的 holdkit／holdscan，也不放 App 的前端程式（誰都下載得到）。
- **資料邊界**：研究程式和資料只放 holdlab。使用者的照片只有**分享出去的快照**（第一次分享前在 App 裡同意過，見 spraywall 的隱私權政策）可以拿來評估、訓練岩點偵測；沒分享的牆（含帳號同步的照片）和透過 Google API 拿到的資料（名稱、email）不拿來訓練模型。其他訓練用的照片直接跟館方拿並取得同意。例外：開發者自己拍、館方同意的標註牆（holdlab `tools/label_cloud.py` 放進自己的帳號，牆 id 開頭 `label-`）可以從帳號同步讀回來當標註。

## 工作原則

- 架構用第一原理分析；程式遵循 DRY、KISS、SOLID、YAGNI。架構要簡單，一次修改只動一筆資料。
- 遵循既有約定，命名即文件，只替複雜邏輯寫註解。
- **不做向後相容**（目前只有開發者自己在測）：格式改了就直接改，不留舊格式、搬移程式和相容分支。
- 不硬編碼密鑰（Firebase 前端設定與 API key 是公開設定，權限由規則控管）；外部輸入要校驗；錯誤要明確處理，不能靜默失敗。
- **零假設**：產品行為、預設值有歧義時，列出選項讓使用者決定。外部資料（Firebase、第三方 API）先用實際資料確認欄位與語意，寫完再用實際輸出核對。
- **能用一次實驗決定的不拿來問**：跑一次、看結果再報結論。

## 自主推進

- **開工**：讀本檔、README 和相關的 docs；要做什麼沒指定時，從 spraywall 的 `docs/backlog.md` 挑「可以直接做」的項目。
- 判準是**錯了能不能自己收回**，不是改動大小：
  - **直接做**：修好壞掉的工具、清掉自己改動留下的孤兒、推到 `main`（部署到開發版）、部署雲端函式、打 holdkit 版本標記。做完在回覆裡說明。
  - **先問**：發布正式版（推到 `release`）、產品行為與介面的取捨、Firestore／Storage 規則部署、repo 可見性、Firebase／Google Cloud 控制台設定、刪除資料（含本機不在版控的檔案）、建立或交出憑證。
- **按改動範圍驗證**：本機跑快速檢查與受影響功能的案例；完整回歸只在發布正式版前跑（GitHub Actions 不跑測試），也不因碰到共用檔案就自動全跑。測試已通過且相關內容沒再變動時不重跑；新增行為補必要測試，整合失敗才擴大驗證。spraywall 的案例選擇與共用測試鎖見 `docs/development.md`。
- **部署追到成功**：推送或觸發部署後，追蹤對應 commit 的部署結果，「已推送」「部署中」不算完成。失敗時自己讀紀錄、找原因、修正、跑對應驗證，再推送並追到成功；不能只回報失敗，也不能跳過檢查、刪測試或靠重試掩蓋（時好時壞的案例照樣算失敗，要修）。成功後確認網站開得起來、版本號跟預期一致。需要新權限、憑證、不可逆操作或產品取捨時，先做完不受影響的部分，再具體說明阻礙。
- **同一分支只由最後推送者追蹤部署**：自己的流程被新提交取代時，確認新提交包含自己的 commit 後交給最新推送者，不重開流程、不重跑測試、不一起輪詢；回報時只說本機驗證與提交完成，不宣稱部署成功。沒有後續提交接手，就自己追到底。
- **完成的定義**：本 repo「驗證」表裡對應的項目都跑過；行為改了，README 和 docs 同步更新；commit 推上 `main`；回報照實說：沒跑的寫沒跑，失敗的附輸出，要使用者本人操作的（手機實機、Google 登入）明確標出。
- 測試不能動到使用者的資料；動到了要還原並主動告知。

## 變更與提交

- 不開 PR，直接推 `main`；推之前 `git pull --rebase`。只提交自己改的檔案。
- **每個工作階段在自己的 worktree 改**：開工就 `git fetch`，從 `origin/main` 在自己的暫存資料夾開一個 `git worktree`（新分支），修改、測試、提交、推送都在那裡做，做完刪掉 worktree 和分支；主資料夾只拿來看最新狀態，不直接改。預覽伺服器各用自己的埠。
- **同時開工按區塊分工**：避開熱點檔同時大改（spraywall 的 `js/app.js`、`css/app.css`、`index.html`、語言包）；改動小、盡快推。同時寫程式的工作階段以 2–3 個為上限（8 GB，瀏覽器測試一次只能跑一組）。
- 每一行 diff 都要對應明確的需求：沒點名的特性、彈性、抽象不加，不順手重構無關的程式。無關的死碼只提醒不刪；自己改動產生的孤兒要清乾淨。
- commit message 寫「改了什麼、為什麼」。

## 溝通

- 先結論後論據，先結果後過程；分類要互斥、完整。
- 要使用者決定的事（含提出方案），先把完整內容（方案、清單、比較、建議）寫在訊息本文，再問。最後的「下一步」框（wrap_up）只放一兩句摘要和一個問題，使用者在框裡看不到細節。
- **給使用者在 Mac 執行的指令**：一段可以整段貼上的 zsh 指令，不用另外改。
  - 用 `cd /Users/kantkang/work/climbio/<repo>` 這種絕對路徑，先 `git pull --rebase`，步驟之間用 `&&` 串起來，前一步失敗就停。
  - 不放 `#` 註解（zsh 互動模式會把 `#` 當成參數），也不放 `<...>` 佔位字。
  - 最後接驗證指令（例如 curl 印出狀態碼）。
  - 指令外寫清楚：正常的結果長什麼樣子、失敗時先做什麼（例如回 401 先 `npx firebase-tools login --reauth`）。

## 文件分工

- `CLAUDE.md`：給 AI 的工作規則與本 repo 的開發、驗證、部署方式。
- `README.md`：給人看的簡介、怎麼跑、文件索引。
- `docs/`：會隨產品調整的規格（只有 spraywall 有）；`docs/backlog.md` 是四個 repo 共用的待辦。
- 只寫「現在是什麼樣子」，不寫歷史、改版紀錄和日期（歷史看 git log）；研究過程與數據放 holdlab 的 RESEARCH.md。

## 本機環境

- 這台 Mac 只有 8 GB RAM：同一時間只跑一個重工作（訓練、評估、完整測試、大量資料處理），不並行，worker 數一律 1。
- Firebase 一律用 `npx firebase-tools`（本機的 `firebase` 執行檔不能用）；回 401 先跑 `npx firebase-tools login --reauth`。
<!-- 共同規範結束 -->

## 規則

- 不能放、也不能呼叫 AGPL 的程式或模型（包括 holdscan 和 Ultralytics 訓練的模型）。
- 結果要可重現：同一個版本標記的結果固定。
- 資料包結構改了要改 SPEC.md。
- 雲端函式只在記憶體裡處理照片：照片不存檔、不寫進紀錄（紀錄只記岩點數和耗時）。

## 發布流程

1. 改程式，`holdkit.js` 開頭的 `VERSION` 改成新版本。
2. 把工作中的 holdkit 複製到 spraywall 的 `holdkit/`，在 App 裡實際測過。
3. commit、推 `main`，打標記 `git tag v<版本> && git push origin v<版本>`。
4. 改 spraywall `tools/get-holdkit.sh` 的 `HOLDKIT_VERSION` 和 `HOLDKIT_COMMIT`，推上去（App 自動部署）。
5. 雲端函式有改才部署（見下方）。

## 驗證

| 改動 | 必跑 |
|---|---|
| 任何程式碼 | `node --check holdkit.js samrefine.js samworker.js functions/index.js functions/handler.js functions/server.js functions/sam.js functions/decode.js`；`node -e "require('./holdkit.js')"` |
| 算法 | 在 spraywall 用實際的牆比較改前改後；規則調整用 holdlab 的評估腳本 |
| 雲端函式 | 部署後 `curl -s -o /dev/null -w '%{http_code}' -X POST https://asia-east1-firebase-climbio.cloudfunctions.net/retrace` 回 401，再從手機版 App 實際重描一次 |

## 部署（雲端函式）

使用者的電腦（`npx firebase-tools` 已登入）：

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions:holdkit
```

雲端工作階段（沒有 Firebase 憑證）：用 spraywall 的 GitHub Actions，從本 repo 的 `main` 取出部署（先推上 `main`），金鑰只留在 spraywall：
`gh workflow run firebase.yml --repo climb-io/spraywall --ref main -f only=functions:holdkit`，再 `gh run list --repo climb-io/spraywall --workflow firebase.yml` 看結果。

`retrace` 的規格：asia-east1，8 vCPU，最多 2 個執行個體、每個一次接一份。predeploy 把 `models/` 的兩個模型複製進 `functions/models/`；`functions/.npmrc` 關掉 GPU 版 onnxruntime 的下載。
