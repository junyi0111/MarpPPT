# MarpPPT 整合製作品質與交付標準

本標準與 `marp-ppt` Skill、`render_presentation` MCP、套件內附件暫存與 PPTX 封裝檢查一起交付。先前參考的簡報設計與 finalization 檢查原則已整理到本文件及 `layout-contract.md`；使用者不需要另外安裝或啟用 Presentations 或 PDF Plugin。

## 設計與內容

- 預設使用 MarpPPT 隨附的 Tech Editorial 設計系統及 [layout-contract.md](layout-contract.md)：清晰主訊息、穩定字級階層、留白、足夠對比、依內容變換版型、原生可編輯文字與圖表。遵守文字字體、等比例圖片、垂直置中、卡片內距、表格欄位與溢出規範。
- 摘要程度依使用者指示與內容量決定；未指定時適度摘要。保留所有關鍵數字、單位、日期、名稱、術語、定義與限定條件；不能把推論寫成來源事實。內容超出畫面時，拆頁或摘要，不以縮小字體塞滿。
- 交付前檢查每頁是否只有一個主訊息、版型是否配合內容、字體與色彩是否一致、文字是否易讀、表格及圖表數值是否可比較，以及是否有裁切、重疊或過度擁擠。

## 原始檔與圖片附件

- 使用套件內的 `stage:attachments` 把宿主實際提供的 Markdown 與 PNG/JPEG 複製到私密、限時工作目錄。以 staging manifest 的檔名、MIME、位元組數與 SHA-256 建立來源映射；不可覆寫原檔，也不可猜路徑或讀取未授權路徑。
- 使用套件內的 Sharp 檢查圖片格式與可解碼性。逐張確認對話附件與來源 Markdown 圖片引用都有對應投影片；無合適位置時放在附圖頁。任何縮放或轉換都維持原長寬比例，禁止拉伸、失真或裁掉原圖內容。
- 若附件沒有宿主可讀路徑，或 staging 無法驗證來源，停止依賴該附件的製作並明確指出交接問題。

## 學術 PDF 條件式核對

- 只有在使用者提供 PDF 或要求核對論文時執行。使用套件內 `scripts/extract-pdf-reference.mjs` 呼叫 Poppler `pdftotext -layout`，從 PDF 擷取文字並保留頁面分隔；可指定頁碼或頁碼範圍。呼叫時以程序參數陣列傳遞檔案路徑，不拼接 shell 字串。該工具只輸出擷取文字，不修改或覆寫 PDF。
- 對簡報中的公式、指標定義、比較條件、表格數字及頁碼逐項回查原 PDF。遇到文字層缺失、欄位錯位或公式不明時，使用套件所依賴的 Poppler `pdftoppm` 渲染相關頁面並目視核對；無法核對時標出未驗證項目，不猜答案。
- Poppler 是 MarpPPT 本機預覽流程所需的系統工具之一。若 `pdftotext` 不可用，清楚說明需要安裝／啟用 Poppler，不能悄悄略過 PDF 驗證。PDF 不會送進 `render_presentation` MCP；MCP 僅接收規格允許的 staging 引用。

## MarpPPT 產生與 ZIP 封裝關卡

1. 只用 MarpPPT 的 `render_presentation` 產生 `.marp.md` 與可編輯 `.pptx`。Presentations 的設計內容已整理在本套件文件內；其他簡報工具不得替代本工具建立或編輯此 PPTX。
2. 檢查 `validation.pptx.contentTypeOverridesValid`、`validation.pptx.relationshipsValid`、`validation.pptx.slideBoundsValid` 均為 `true`。套件 validator 必須確認 `[Content_Types].xml` 每個 `<Override>` 的 `PartName` 都映射到 ZIP 內實際存在的 part，且所有套件內 `.rels` 關係目標都存在。外部 URL 關係不屬於 ZIP 內部 part。
3. 檢查標準 XML 語法與合法字元、表格 `anchor`／`horzOverflow` 的合法列舉、頁內繪圖 ID 唯一性與連線目標、內嵌 XLSX 的 A1 範圍及內部關係。ZIP 解壓上限為 256 MiB／4096 項；单一 XLSX 32 MiB，最多 60 本、合計 64 MiB。超限或格式錯誤皆阻擋輸出，不刪資料求通過。此為已知錯誤及封裝檢查，不代表完整 Office XML 結構描述驗證。
4. `PPTX_INVALID` 是確定性的結構錯誤，帶有部件資訊且不自動重試相同輸入。需修正內容或渲染器後再產生。
5. ZIP 驗證或版面結構檢查任一失敗，修正來源計畫後重產；不可把失敗檔標為完成。

## PowerPoint CUA 儲存與重開關卡

此關卡每份簡報都要執行，不能用 ZIP 檢查或 LibreOffice 預覽代替。使用 Codex 執行環境的 `unified-computer-use` 實際控制 Microsoft PowerPoint：

1. 透過宿主支援的檔案交接方式，在 PowerPoint 開啟 MarpPPT 產出的 PPTX。確認開啟時是否有修復提示。
2. 首次開啟若有修復提示，該次匯出失敗；保留原檔與診斷並修正渲染器後重產，不能把修復後另存視為正常匯出通過。首次開啟沒有提示時，另存成新的 `*-PowerPoint-verified.pptx`。不要覆寫 MarpPPT 原始匯出檔。
3. 關閉該檔，再由 PowerPoint 重新開啟剛儲存的驗證檔。確認沒有修復提示、頁數與預期一致，並抽查文字、圖形、圖片、裁切和重疊。
4. 比較另存前後頁數、文字、圖片與原生表格／圖表是否保留，記錄原始及驗證檔 SHA-256、驗證檔路徑及 PowerPoint 版本。只將這份重新開啟成功的 PowerPoint 儲存版標示為通過並交付。
5. 若 CUA、Microsoft PowerPoint 或檔案交接不可用，回報「PowerPoint 重開驗證：未通過／未執行」與具體阻礙。原始 MarpPPT PPTX 可作為「未驗證草稿」提供，但不能稱為已通過或已修復。

若另存視窗無法使用，可先建立不覆寫原檔的新副本，再用 PowerPoint 開啟該副本並原生儲存。必須確認檔案確實經 PowerPoint 寫入（檔案指紋改變），再執行關閉、重開及內容保留檢查；單純複製檔案不算原生存檔驗證。交付紀錄應寫明實際採用的方法與另存視窗的阻礙。

CUA 是 Codex 執行環境內的操作能力，不是 MarpPPT MCP 內部的修復器，也不要求使用者安裝另一個簡報 Plugin；本 Skill 必須主動呼叫它完成上述步驟。MCP 總是回傳 `draft`／`unverified`，`validation.powerPoint.status` 固定 `not_run`；此欄不可由模型憑預覽修改成通過。實際宿主驗證結果與交付檔指紋另行記錄。`validation.visualQaPassed` 是 MarpPPT 預覽欄位，不代表 PowerPoint 已重開驗證。

## 最終交付紀錄

簡要回報：

- ZIP Override 檢查：通過／失敗；關係目標檢查：通過／失敗。
- PowerPoint 首次開啟：無修復提示／已修復／未執行。
- PowerPoint 另存與關閉重開：通過／未通過／未執行。
- 視覺抽查：通過／有列明的問題／未執行。
- 交付檔案：使用 PowerPoint 儲存並重開驗證的版本；若未通過，只能標為草稿。
