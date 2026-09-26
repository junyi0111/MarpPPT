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

## Agent 與作業系統支援

MarpPPT 會在本機啟動 stdio MCP 伺服器，需要 Node.js 22 以上、可讀取附件的本機檔案權限，以及可寫入的輸出目錄。它面向桌上型或開發用電腦；純手機或純瀏覽器 Agent 工作階段目前無法直接使用。

| Agent | 必須採用的部署方式 | 目前狀態 |
| --- | --- | --- |
| **Codex** | 依 Codex Plugin 方式安裝，使用 `$marp-ppt` 呼叫；遵循 [OpenAI Plugin 封裝與 Marketplace 文件](https://developers.openai.com/plugins/build/plugins)。 | 主要目標。本套件含 Codex manifest；新宿主的附件交接與完整 PowerPoint 驗證仍待確認。 |
| **OpenCode** | 在 `opencode.json` 設定本機 MCP，並依 OpenCode 的 Agent Skills 目錄載入 Skill；遵循 [MCP 文件](https://opencode.ai/docs/en/mcp-servers/)與 [Skills 文件](https://opencode.ai/docs/skills)。 | 需要 OpenCode 專用設定。目前 Skill 含 Codex 專用附件與電腦操作步驟，不能原樣視為完整支援。 |
| **Claude Code** | 採用 Claude Code 自己的 Plugin、MCP、Skill 格式；遵循 [Plugin 文件](https://code.claude.com/docs/en/plugins)、[MCP 文件](https://code.claude.com/docs/en/mcp)與 [Skills 文件](https://code.claude.com/docs/en/skills)。 | 目前套件不能直接當 Claude Code Plugin 安裝；需要 Claude Code manifest／設定及宿主專用 Skill。 |

請勿把 Codex 候選 ZIP 當成通用 Plugin 安裝到其他 Agent。要使用 OpenCode 或 Claude Code，必須依該 Agent 的部署格式設定 MCP 程序並提供相應 Skill；目前版本尚未附上這些轉接設定。純遠端／瀏覽器 Agent 也無法連到本機 stdio 伺服器；Hosted HTTP 附件傳輸尚未達正式環境標準。

| 作業系統 | 目前狀態 |
| --- | --- |
| **macOS** | 目前已在此環境驗證建置與 Plugin 封裝。 |
| **Linux** | 附有以 Debian／Node.js 22 為目標的 Docker 起始設定；尚未驗證容器建置及主機端完整流程。 |
| **Windows** | Node.js 22 理論上可啟動 MCP，但本套件尚未在 Windows 驗證。OpenCode 官方建議 Windows 使用者採 WSL。 |

本機投影片預覽及 PDF 來源核對另外需要 LibreOffice、Poppler 工具、fontconfig 與 Noto CJK 字型。PowerPoint 存檔／重開關卡需要 Microsoft PowerPoint，以及 Agent 宿主可用的電腦操作能力；目前 Skill 明確使用 Codex 內建能力。

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
- 尚未提供 OpenCode 或 Claude Code 的部署轉接設定與宿主專用 Skill。
- 每個版本候選都必須在目標環境實際執行 PowerPoint 無修復提示的重開驗收。

詳見[驗收報告](docs/operations/acceptance-report.md)、[Hosted 部署說明](docs/operations/hosted-deployment.md)與[隱私及保留政策](docs/operations/privacy-and-retention.md)。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
