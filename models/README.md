# 模型（ONNX）

這裡只放 MobileSAM（重描岩點外框）。岩點偵測模型在 climb-io/holdscan。

## MobileSAM（重描外框，見 `samrefine.js`、`functions/`）

| 檔案 | 內容 |
|---|---|
| `mobilesam-encoder.onnx` | 影像 encoder（輸入 H×W×3、0–255，長邊 1024；正規化和補邊在模型裡），輸出 [1, 256, 64, 64] |
| `mobilesam-decoder.onnx` | SAM mask decoder（單一遮罩）；提示用外框（label 2、3） |

- 權重：[MobileSAM](https://github.com/ChaoningZhang/MobileSAM)（Chaoning Zhang 等），Apache-2.0，授權全文見 `LICENSE-MobileSAM`。
- ONNX：取自 [Acly/MobileSAM](https://huggingface.co/Acly/MobileSAM)（MIT），encoder 用該 repo 的 `export_image_encoder.py`、decoder 用 MobileSAM 的 `export_models.py` 匯出；本專案未修改模型，只改了檔名（`mobile_sam_image_encoder.onnx`、`sam_mask_decoder_single.onnx`）。
- 電腦版在瀏覽器裡跑（第一次重描時下載約 45 MB）；手機改送雲端函式（`functions/`）算，雲端失敗才在手機的 Worker 裡用 CPU 算（手機 GPU 實測會算錯）。
