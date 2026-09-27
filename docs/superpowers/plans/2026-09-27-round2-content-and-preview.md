# MarpPPT 第二輪內容與預覽品質修復計畫

> 日期：2026-09-27  
> 範圍：承接第一輪圖示排版修復，集中處理「內容不可直接使用、圖示語意流失、字型缺字被誤判成功」三個跨版本問題。

## 目標

第二輪完成後，從 Markdown 產生的可編輯 PPTX 應符合：

1. 公式不會以原始 `\\[`、`\\mathrm`、`\\frac` 等 LaTeX 控制字串出現在投影片；若無數學字型渲染管線，使用清楚的純文字降級表示。
2. 圖示節點與箭頭標籤都能追溯到來源內容；不產生 `...`、`…`、`TBD` 或「待補」等空白佔位符。
3. 預覽驗證除了確認指定字型被選取，也會檢查 PDF 文字層是否保留來源中的 CJK 字元；缺字或替代字元會使結果進入 draft 並提出可診斷錯誤。
4. 三份代表性教材（Attention、Container、LSTM）可完成產出、預覽與 PPTX 封裝驗證。

## 非目標

- 本輪不改變 MarpPPT 的整體模板與品牌視覺。
- 不引入需要網路服務或付費 API 的數學 OCR、圖片辨識或字型服務。
- 不把不可驗證的「圖示建議」硬轉成看似精確的研究結果；沒有來源數據時只建立明確標示為示意的關係。

## 實作任務

### 1. 公式安全文字化

**檔案**

- 新增 `src/content/math-text.ts`：辨識 `\\[...\\]`、`$$...$$`、`\\(...\\)`，將常見控制字串轉成可讀純文字（例如 `\\frac{a}{b}` → `a / b`、`\\sqrt{x}` → `√(x)`），移除未支援命令與原始分隔符。
- 修改 `src/layout/build-slide.ts` 與 `src/marp/serialize-marp.ts`：所有進入投影片文字物件或 Marp 文字區塊的內容先經過同一個 normalizer。

**驗收**

- 保留一般中英文、URL、程式碼與沒有公式的文字。
- 輸出不得含 `\\[`、`\\]`、`\\mathrm`、`\\frac` 等原始數學命令。
- 對 Attention 範例保留 `Attention(Q,K,V)`、`QKᵀ`、`√(dₖ)` 等可理解資訊。

### 2. 圖示語意與佔位符防呆

**檔案**

- 修改 `src/contracts/presentation-plan.ts`：拒絕只由 `...`、`…`、`TBD`、`TODO`、`待補`、`placeholder` 組成的節點或箭頭標籤，並回傳可操作錯誤訊息。
- 新增單元測試覆蓋節點、箭頭與正常短標籤（如 `Q`、`輸入`）。
- 更新 `skills/marp-ppt/SKILL.md`：要求把「圖示建議」轉成 2–5 個來源語意節點與關係；若只有抽象建議，改用標示「示意」的解釋區塊，不生成空白佔位節點。

**驗收**

- 任何 placeholder plan 在 schema 階段失敗，不會進到 PPTX。
- Attention、Container、LSTM 的節點至少保留來源中的關鍵詞，且示意關係有文字說明。

### 3. 預覽字型與缺字檢查

**檔案**

- 新增 `src/preview/font-check.ts`：從 `ppt/slides/slide*.xml` 收集來源 CJK 字元，解析 `pdftotext` 輸出並計算覆蓋率；同時辨識 U+FFFD 或明顯替代方框。
- 修改 `src/preview/render-preview.ts`：加入可注入的 `pdftotext` 指令、`pdftotext` stage 與 `FONT_GLYPH_MISSING` 錯誤；當來源含足量 CJK 字元而 PDF 文字層覆蓋率低於門檻時，結果不得為 ready。
- 修改 `src/quality/types.ts`、`src/quality/preflight.ts` 與相關整合測試：把 `pdftotext` 列入可診斷的本機工具，不改變既有 renderer timeout/abort 行為。

**驗收**

- 正常 Noto Sans CJK TC 測試得到 `font.selected` 且通過 glyph check。
- fake/缺字輸出得到明確的 `FONT_GLYPH_MISSING`，狀態為 draft，包含缺失比例與修復提示。
- 既有 preview、timeout、abort、page count 測試仍通過。

### 4. 代表性教材驗證

使用 `/Users/liujunyi/Downloads/06-attention-transformer-slides.md`、`02-container-docker-slides.md`、`07-lstm-memory-slides.md` 建立暫存產出（不提交測試產物），逐項確認：

1. Marp Markdown 公式與圖示文字沒有原始命令或 placeholder。
2. PPTX ZIP 的 `[Content_Types].xml` Override 與關係目標全部存在。
3. 預覽 contact sheet 頁數、字型與缺字檢查通過。
4. Microsoft PowerPoint 開啟、另存、關閉、重開不出現修復提示。

## 測試順序

```bash
npx vitest run tests/unit/math-text.test.ts tests/unit/presentation-plan.test.ts
npx vitest run tests/unit/layout.test.ts tests/unit/serialize-marp.test.ts
npx vitest run tests/integration/preview-render.test.ts tests/integration/production-preflight.test.ts
npm run build
npm test
```

若完整測試仍出現既有的環境時序失敗，需把失敗測試、錯誤階段與是否涉及本輪變更記錄在交付摘要，不得將其標示為全數通過。

## 交付物

- 本計畫文件與分階段 git commits。
- 三份代表性教材的驗證摘要與暫存 PPTX 路徑。
- 失敗時保留可重現的 issue code、stage、命令與修復建議。
