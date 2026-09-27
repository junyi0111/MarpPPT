# 編輯提要工作流

在呼叫 `render_presentation` 前，先用同一份 Markdown 建立 `editorialBrief`。它是內容規劃與來源追溯介面，不是任意座標或另一套版型系統。

## 必填內容

- `sourceDigest` 必須是本次 Markdown 原始位元組的 SHA-256，且與 `plan.sourceDigest` 相同。
- `audience`、`purpose` 和 `useCase` 說明這份簡報要讓誰在什麼情境下做什麼判斷。
- 每頁寫一句 `purpose`，再列出 `evidence`、`factIds`、`form`、`variant`、`focus` 與限制。先決定觀眾看完要懂什麼，再選證據與形式。
- 使用者指定必留的數字、單位、日期、名稱與限定條件放入 `mustKeepFacts`。`placement: "slide"` 的事實一定要映射到頁面上的 `factIds`；講者備註不能取代畫面資訊。
- `SourceSpan` 使用 1 起算、含首尾的 Markdown 行號。外部 PDF 頁碼仍需由宿主另存查核紀錄，不能用路徑字串取代附件介面。

## 頁數與附件

`requestedSlideCount` 是硬限制。若指定 10 頁，封面、收尾與附件圖片都必須在同一個 10 頁計畫內；不可先輸出 10 頁再偷偷追加第 11 頁。每張指定圖片都要有安全 `assetId`、`altText`、角色與頁面映射，沒有合適位置時先回報容量衝突。

`form` 是內容語意提示（例如 `sequence`、`comparison`、`table`），`variant` 只可使用受控值。`focus` 只能指現有文字區塊、圖片、圖表、表格或流程圖，不得塞入任意 x/y 座標。

## 交付前檢查

1. 執行本機 preflight，確認 Node、MCP 入口、LibreOffice／Poppler、輸出目錄及所選字體主題的實際 family；未指定時使用 `Noto Sans CJK TC`。
2. 先做來源／頁數／圖片映射檢查，再渲染；任何編輯提要錯誤先修正，不消耗完整渲染重試。
3. 產出後仍需完成 PPTX ZIP 關係檢查、預覽檢查與 PowerPoint 開啟／另存／關閉／重開驗收。編輯提要通過不等於視覺或 PowerPoint 驗收通過。
