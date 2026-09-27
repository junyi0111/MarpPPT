# MarpPPT 字體主題

MarpPPT 預設使用 `Noto Sans CJK TC`。它適合教材、技術摘要、表格與一般雙語簡報。字體主題只改變字型 family，不改變頁面尺寸、內距、文字下限或圖片比例。

## 可用主題

| `themeId` | 字體 family | 適合內容 | 授權 |
| --- | --- | --- | --- |
| `default` | `Noto Sans CJK TC` | 通用預設、教材、資料型簡報 | SIL OFL 1.1 |
| `default-serif` | `Noto Serif CJK TC` | 研究摘要、文章式敘事、正式封面 | SIL OFL 1.1 |
| `default-source-serif` | `Source Han Serif TC` | 編輯感、人文內容、長文摘錄 | SIL OFL 1.1 |
| `default-plex` | `IBM Plex Sans TC` | 技術報告、產品指標、工程資料 | SIL OFL 1.1 |

字體專案與授權來源：

- [Noto Sans TC — Google Fonts](https://fonts.google.com/specimen/Noto+Sans+TC)
- [Noto Serif TC — Google Fonts](https://fonts.google.com/specimen/Noto+Serif+TC)
- [Source Han Serif — Adobe Fonts GitHub](https://github.com/adobe-fonts/source-han-serif)
- [IBM Plex Sans TC — IBM Plex GitHub](https://github.com/IBM/plex/tree/master/packages/plex-sans-tc)

## 安裝與驗證

MarpPPT 不把大型字體二進位檔放進每份簡報；PowerPoint 與 LibreOffice 必須在執行主機上找到所選 family。

使用本機 stdio MCP 時，Skill 會先執行 preflight。若只缺少字體，會呼叫 `ensure_font`，從上表的官方來源下載並寫入目前使用者的字體目錄，再重新驗證 family。這個流程：

- 不使用 `sudo`，不覆寫系統字體；macOS 寫入 `~/Library/Fonts`，Linux 寫入 `$XDG_DATA_HOME/fonts/marpppt` 或 `~/.local/share/fonts/marpppt`。
- 只有 `installIfMissing: true` 才會下載；來源網址固定為官方 GitHub／Google Fonts 網域，下載後會檢查字體檔格式與實際 family。
- 安裝完成且 `verified: true` 後才會開始渲染；若無法確認，必須重啟 Codex／PowerPoint 後重新預檢。
- 遠端 HTTP MCP 不提供檔案安裝工具；遠端環境請由管理者預裝字體或手動從官方來源安裝。

若要手動安裝，請從上述官方來源下載對應字體，完成後重新啟動 PowerPoint、LibreOffice 與 Codex。

在輸出目錄執行預檢：

```bash
npm run build
node scripts/preflight.mjs /absolute/path/to/marpppt-output "Noto Serif CJK TC"
```

`FONT_NOT_MATCHED` 代表主機未確認到指定 family。會先嘗試呼叫本機 `ensure_font`；若 MCP 不提供該工具、平台不支援或驗證失敗，不要交付宣稱已驗證的預覽，請依 `userAction` 手動安裝或改回 `default`。

## 使用規則

- 未指定風格時使用 `themeId: "default"`。
- 研究摘要或正式文章式內容可使用 `themeId: "default-serif"`。
- 人文與編輯感內容可使用 `themeId: "default-source-serif"`。
- 技術與工程內容可使用 `themeId: "default-plex"`。
- 一份簡報只使用一個字體主題；不要在同一份簡報混用不同 CJK family。
- 字體主題不會取代 PowerPoint 的另存、關閉、重開與修復提示檢查。
