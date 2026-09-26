# MarpPPT

[English](README.md)

MarpPPT 是開源 Codex Plugin，可將 Markdown 與對話附件圖片製作成 Marp Markdown 和可編輯 PowerPoint。套件包含 Codex Skill 與本機 MCP 伺服器；投影片文字、圖形、表格、圖表與圖片以 PowerPoint 原生物件呈現。

## 功能

- 從 Markdown、使用者需求和圖片附件建立有來源位置的簡報計畫。
- 未指定摘要程度時適度摘要；保留關鍵事實、數字、單位、名稱、術語與限定條件。
- 圖片等比例縮放並使用 `contain`，文字方塊垂直置中。
- 內建 Tech Editorial 設計、雙語字體、圖形內距與表格排版規範。
- 檢查 PPTX ZIP 封裝，包括 `[Content_Types].xml` 每筆 Override 和所有內部關係目標。
- 附帶本機 PDF 文字擷取工具，可選擇性核對來源和頁碼。
- 輸出可編輯 `.pptx`、`.marp.md`，有圖片時另附圖片資源包。

## 在 Codex 使用

透過 Codex 的本機 Plugin 管理功能安裝後，以 `$marp-ppt` 呼叫 Skill，或直接請 Codex 依 Markdown 和附件製作簡報。Plugin 顯示名稱是 **MarpPPT**；在 Codex 輸入 `@MarpPPT` 尚未驗證為可用的啟動方式。

Skill 使用本套件的 `render_presentation` MCP 工具產生簡報。完整交付流程也要求 Codex 內建的 `unified-computer-use` 操作 Microsoft PowerPoint：開啟、另存新檔、關閉並重新開啟。這項操作能力由 Codex 執行環境提供，未包含在本 GitHub 專案中。若宿主無法執行，必須將簡報標示為未驗證草稿。

## 建置與封裝

### 必要環境

- Node.js 22 以上及 npm。
- 本機預覽需要 LibreOffice Impress、Poppler 工具（`pdfinfo`、`pdftoppm`、`pdftotext`）、fontconfig 與 Noto CJK 字型。
- 完整交付驗收需要目標環境中的 Microsoft PowerPoint 與 Codex 電腦操作能力。

### 建立本機 Plugin 封裝

```bash
npm ci
npm run package:plugin -- --profile local
```

這會建置 TypeScript、套用維護中的簡報設計覆寫、驗證 Plugin 封裝，並產生 `runtime/marpppt-0.1.0-local-candidate.zip`。封裝不含 `node_modules`、測試、TypeScript 原始碼、本機執行資料或環境檔；解壓後需安裝依賴。

其他開發指令：

```bash
npm run build
npm run package:validate
npm test
npm run typecheck
```

產生的 `dist/` 與 `runtime/` 已加入 Git 忽略清單。Plugin ZIP 內含建置後執行檔、manifest、Skill 參考文件、主題、本機 PDF 工具與操作文件。

## 設計與交付規範

[版面契約](skills/marp-ppt/references/layout-contract.md)定義字體、圖片等比例、文字垂直置中、留白及可編輯表格；[製作品質與交付標準](skills/marp-ppt/references/production-quality.md)涵蓋來源核對、圖片處理、ZIP 驗證和 PowerPoint 儲存／重開關卡。

合法 ZIP 或成功預覽不代表 PowerPoint 相容。Skill 會分別回報 ZIP 檢查、首次開啟修復狀態、PowerPoint 儲存重開結果與視覺檢查結果。

## 目前限制

- Codex 對話附件交接及從 Codex 介面開啟產物，仍依賴宿主檔案存取與交接；本機 staging 通過不代表端到端已通過。
- Hosted HTTP 的附件傳輸尚未達正式環境標準。在 Skill 主機建立的 staging 引用不會自動把檔案傳到另一台 MCP 主機。
- 每個版本候選都必須在目標環境實際執行 PowerPoint 無修復提示的重開驗收。

詳見[驗收報告](docs/operations/acceptance-report.md)、[Hosted 部署說明](docs/operations/hosted-deployment.md)與[隱私及保留政策](docs/operations/privacy-and-retention.md)。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
