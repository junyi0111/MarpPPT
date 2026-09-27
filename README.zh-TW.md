# MarpPPT

<p align="center">
  <strong>從 Markdown 和圖片，快速製作可編輯的模板型 PowerPoint。</strong><br>
  提供 Codex Plugin、Skill 與本機 MCP 伺服器，產出的簡報可以繼續編輯。
</p>

<p align="center">
  <a href="https://github.com/junyi0111/MarpPPT/actions/workflows/build.yml"><img alt="建置與封裝驗證" src="https://github.com/junyi0111/MarpPPT/actions/workflows/build.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT 授權" src="https://img.shields.io/badge/license-MIT-2563EB.svg"></a>
  <img alt="Node.js 22 以上" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white">
  <img alt="套件版本 0.2.2" src="https://img.shields.io/badge/package-0.2.2-6D5EF7">
  <a href="https://github.com/junyi0111/MarpPPT/commits/main"><img alt="最近更新" src="https://img.shields.io/github/last-commit/junyi0111/MarpPPT?label=last%20update"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#在-codex-桌面版安裝與使用">快速開始</a> ·
  <a href="#支援矩陣">支援狀態</a> ·
  <a href="CONTRIBUTING.md">參與貢獻</a> ·
  <a href="SECURITY.md">安全政策</a>
</p>

![MarpPPT 流程圖：Markdown 與圖片附件經過簡報規劃、版面配置和檢查，產生可編輯 PowerPoint。](assets/readme/marpppt-workflow.svg)

MarpPPT 將 Markdown、對話需求和提供的圖片轉成 Marp 原始檔與**可編輯的 `.pptx`**。文字、圖形、表格、圖表和圖片會放入 PowerPoint 原生物件，方便後續修改。

## 適用情境與品質取向

MarpPPT 專注於**快速、成本可控的傳統模板型簡報**。它將現有內容整理成版面一致、可逐項編輯的 PowerPoint，適合例行報告、教材、研究摘要，以及需要反覆改稿的簡報。

它的品質目標是**資訊清晰、排版穩定、方便重複製作與後續編輯**。NotebookLM 類型的自動生成簡報，以及 Image2 類型的圖片生成簡報，著重不同的敘事或視覺效果；若你期待那類生成式畫面風格，MarpPPT 的模板式成品並非相同的設計取向。實際費用仍取決於所用 Agent、模型與 PowerPoint 等軟體。

## 專案提供什麼

- **整理內容脈絡：** 建立可追溯來源的簡報計畫，適度摘要，同時保留重要事實、數字、單位、名稱、術語與限定條件。
- **一致的版面：** 內建 Tech Editorial 設計、雙語字體、可編輯表格規範與間距設定。
- **可選字體主題：** 預設使用 Noto Sans TC，也提供 Noto Serif TC、Source Han Serif TC 與 IBM Plex Sans TC；本機 MCP 發現缺少字體時會從官方來源安裝到使用者字體目錄，再通過字型預檢，詳見 [字體主題說明](docs/operations/fonts.md)。
- **保護圖片比例：** 圖片等比例縮放並使用 `contain`；文字方塊垂直置中。
- **檢查簡報封裝：** 驗證 PPTX 中 `[Content_Types].xml` 的每筆 Override 和所有內部關係目標。
- **提供可編輯產物：** 輸出 `.pptx`、`.marp.md`；有圖片時另附圖片資源包。
- **核對來源：** 附帶本機 PDF 文字擷取工具，可選擇性核對來源和頁碼。

## 在 Codex 桌面版安裝與使用

以下安裝方式以 **macOS Codex 桌面版**為目標。只需已安裝並登入桌面 App、可連線到 GitHub 與 nodejs.org，以及可供安裝依賴的硬碟空間；**不必預先安裝 Git、Node.js、npm，或把 `codex` 加入終端機 PATH**。安裝程式會下載並驗證 Node.js、建置本機 Plugin，並使用桌面 App 內附的 Codex 執行檔安裝。可先檢視 [scripts/install-codex-macos.sh](scripts/install-codex-macos.sh) 與 [scripts/update-codex-macos.sh](scripts/update-codex-macos.sh)。

### 方式一：請 Codex Agent 安裝

在 Codex 桌面版開新對話，貼入：

```text
請在這台 macOS 電腦安裝 https://github.com/junyi0111/MarpPPT 的 MarpPPT Plugin。先檢視倉庫中的 scripts/install-codex-macos.sh，再在本機執行它；確認 marketplace 與 markdown-to-editable-pptx@marpppt 已安裝，且 MCP 使用的 Node.js 執行檔存在並能啟動。遇到權限或網路限制時請明確回報，完成前不要宣稱可用。最後提醒我完整關閉並重新開啟 Codex，開新對話使用 $marp-ppt。
```

### 方式二：在 macOS「終端機」貼入

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/junyi0111/MarpPPT/main/scripts/install-codex-macos.sh | /bin/bash
```

看到 `Installed.` 後，**完整結束並重新開啟 Codex**，再開新對話，附上 `.md` 與需要使用的圖片，輸入 `$marp-ppt` 和簡報需求。安裝後可在桌面 App 的 Plugins 中確認 **MarpPPT** 已啟用。MCP 產物預設儲存在 `~/.marpppt/artifacts/`；如需更改位置，可在啟動 Codex 前設定絕對路徑環境變數 `PPTX_OUTPUT_ROOT`。可在安裝前設定絕對路徑的 `MARPPPT_INSTALL_ROOT`，將依賴與 Plugin 來源放在外接硬碟；**使用時必須保持硬碟連接**。

### 更新已安裝的版本

在同一台 Mac 關閉正在使用 MarpPPT 的對話後，貼入：

```bash
set -o pipefail
curl -fsSL https://raw.githubusercontent.com/junyi0111/MarpPPT/main/scripts/update-codex-macos.sh | /bin/bash
```

更新程式會沿用既有 Node.js，下載新來源、執行 `npm ci`、建置與封裝驗證，更新本機 marketplace 與 Plugin cache，並確認兩個 MCP 工具都存在。若原本安裝在外接硬碟，執行前要設定相同的 `MARPPPT_INSTALL_ROOT`。看到 `Updated MarpPPT.` 後，完整結束並重新開啟 Codex，再開新對話。更新不會刪除 `~/.marpppt/artifacts/` 中已產生的簡報檔。

這個流程完成的是 **Plugin 與 MCP 安裝**；若要交付經 PowerPoint 重開驗證的正式簡報，仍需 Microsoft PowerPoint 與 Codex 的電腦操作能力。Windows 與 Linux 的桌面版一鍵安裝尚未驗證。

> **啟動方式：** Plugin 顯示名稱是 **MarpPPT**，但在 Codex 輸入 `@MarpPPT` 尚未驗證為可用的啟動方式。請使用 `$marp-ppt` 或直接描述需求。

Skill 使用套件內的 `render_presentation` MCP 工具產生簡報。交付流程也會要求 Codex 內建的 `unified-computer-use` 操作 Microsoft PowerPoint：開啟、另存新檔、關閉並重新開啟。這項能力由 Codex 宿主提供，並未包含在本專案中。若宿主無法完成此步驟，產物必須標示為未驗證草稿。

## 支援矩陣

MarpPPT 會在本機啟動 stdio MCP 伺服器，需要 Node.js 22 以上、可讀取暫存附件的本機權限，以及可寫入的輸出目錄；目前以桌上型或開發環境為目標。

| Agent | 部署方式 | 狀態 |
| --- | --- | --- |
| **Codex** | 依上方 macOS 桌面版步驟安裝，以 `$marp-ppt` 呼叫；參考 [OpenAI Plugin 封裝文件](https://developers.openai.com/plugins/build/plugins)。 | **主要目標。** 桌面版安裝程式涵蓋 Node.js 與內附 Codex 執行檔；對話附件交接與 Codex 產物開啟仍待宿主端驗證。 |
| **OpenCode** | 在 `opencode.json` 設定 MCP，並從 Agent Skills 目錄載入 Skill；參考 [MCP](https://opencode.ai/docs/en/mcp-servers/) 與 [Skills](https://opencode.ai/docs/skills) 文件。 | 需要 OpenCode 專用設定。目前 Skill 的附件及電腦操作步驟是 Codex 專用，完整流程尚不支援。 |
| **Claude Code** | 使用 Claude Code 自己的 Plugin、MCP 和 Skill 格式；參考 [Plugin](https://code.claude.com/docs/en/plugins)、[MCP](https://code.claude.com/docs/en/mcp) 和 [Skills](https://code.claude.com/docs/en/skills) 文件。 | 尚不能直接安裝；需要 Claude Code manifest 與宿主專用 Skill。 |

| 作業系統 | 狀態 |
| --- | --- |
| **macOS** | 已在開發環境驗證建置與 Plugin 封裝。 |
| **Linux** | 附有 Debian／Node.js 22 Docker 起始設定；容器建置及主機端完整流程尚未驗證。 |
| **Windows** | Node.js 22 可能可以啟動 MCP，但本套件尚未在 Windows 驗證。 |

請勿把 Codex 候選 ZIP 當成通用 Plugin 安裝至其他 Agent。OpenCode 和 Claude Code 需要各自的 MCP 設定與 Skill 轉接；純手機、瀏覽器或遠端 Agent 無法直接存取本機 stdio 伺服器。Hosted HTTP 附件傳輸尚未達正式環境標準。

## 建置本機 Plugin 封裝

### 必要環境

- Node.js 22 以上及 npm。
- 本機投影片預覽與 PDF 來源核對需要 LibreOffice Impress、Poppler 工具（`pdfinfo`、`pdftoppm`、`pdftotext`）、fontconfig 與 Noto CJK 字型。
- 完整交付驗收需要 Microsoft PowerPoint 與 Codex 電腦操作能力。

### 封裝

```bash
npm ci
npm run package:plugin -- --profile local
```

這會建置 TypeScript、套用維護中的簡報覆寫、驗證 Plugin 封裝，並產生 `runtime/marpppt-0.2.2-local-candidate.zip`。封裝不含 `node_modules`、測試、TypeScript 原始碼、本機執行資料或環境檔；解壓後需安裝依賴。

其他開發指令：

```bash
npm run build
npm run package:validate
npm test
npm run typecheck
```

產生的 `dist/` 與 `runtime/` 已加入 Git 忽略清單。Plugin ZIP 內含建置後執行檔、manifest、Skill 參考、主題、本機 PDF 工具與操作文件。

## 設計與交付檢查

- [版面契約](skills/marp-ppt/references/layout-contract.md)定義字體、圖片等比例、文字垂直置中、留白與可編輯表格規範。
- [製作品質與交付標準](skills/marp-ppt/references/production-quality.md)說明來源核對、圖片處理、ZIP 驗證和 PowerPoint 儲存／重開關卡。
- ZIP 合法或預覽成功，不等於 PowerPoint 相容。Skill 會分別回報封裝檢查、首次開啟修復狀態、PowerPoint 儲存重開結果及視覺檢查。

## 目前限制

- Codex 對話附件交接及從 Codex 介面開啟產物，仍依賴宿主檔案存取與交接；本機暫存成功不代表端到端已通過。
- 在 Skill 主機建立的暫存引用不會自動把附件傳到另一台 MCP 主機；Hosted HTTP 附件傳輸尚未達正式環境標準。
- 尚未提供 OpenCode 或 Claude Code 的部署轉接器與宿主專用 Skill。
- 每個版本候選都必須在目標宿主實際執行 PowerPoint 無修復提示的重開驗收。

詳見[驗收報告](docs/operations/acceptance-report.md)、[Hosted 部署說明](docs/operations/hosted-deployment.md)與[隱私及保留政策](docs/operations/privacy-and-retention.md)。

## 參與貢獻

歡迎回報問題、提出小範圍改進或協助製作其他 Agent 的部署轉接器。請先看[貢獻指南](CONTRIBUTING.md)與[社群行為守則](CODE_OF_CONDUCT.md)，並使用 Issue 範本；回報問題時請附上作業系統、Agent 宿主和重現步驟。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
