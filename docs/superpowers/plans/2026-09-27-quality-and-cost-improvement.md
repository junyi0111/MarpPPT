# MarpPPT Quality and Cost Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文件是待評審計畫；不代表已實作。實作時遵循當次使用者指定的方法。

**Goal:** 提高模板簡報的內容層次、可讀性和可編輯性，以減少重做降低每份合格成品的模型用量。

**Architecture:** 保留 Agent 規劃、MCP 確定性渲染的分工，新增精簡編輯提要及分項品質報告。將建置後覆寫整合至 TypeScript 單一來源，發布套件與測試使用同一套邏輯。以本機規則、一次整體視覺審閱、最多兩輪局部修訂及最終 PowerPoint 驗收組成流程。

**Tech Stack:** 現有 Node.js、TypeScript、Zod、PptxGenJS、Sharp、Vitest、LibreOffice／Poppler、MCP；宿主提供模型與 CUA。未規劃新增付費模型服務。

**Spec:** [品質與成本規格](../specs/2026-09-27-quality-and-cost-design.md)。

## Global Constraints

- 原圖使用 `contain`，只能等比例縮放；預設保留完整圖片，禁止拉伸及自動裁切。
- 每個文字方塊維持垂直置中、上下內距相等；文字群組可依閱讀順序由上往下排列。
- 中英文統一使用 `Noto Sans CJK TC`；預檢確認實際字型解析。
- 普通內距每側 0.4–0.6 cm，緊湊每側 0.2–0.3 cm，寬鬆每側至少 0.8 cm。
- 主文、圖軸、圖例與必要註解不得小於 18 pt；主文預設 22 pt。來源索引 12 pt 不視為投影可讀保證。
- 頁數包含封面、收尾及附圖；不遺失必留事實或指定圖片。
- 正式交付需通過最終檔案 ZIP 檢查及 PowerPoint 開啟、另存、關閉、重開。
- `PresentationPlan.version: 1` 保持相容，新增可選 `editorialBrief`；舊客戶端品質狀態明確標示未審閱。
- 模型修訂以整份工作計算，最多兩輪針對性修訂；改需求另計且留下紀錄。

## Review Focus

- 指定 10 頁、指定圖片全部保留：不能產生第 11 頁或遺失附件；Task 3 覆蓋。
- 中文、英文長術語及表格數字在同頁：預估行高不能被當成真實無溢出證據；Task 4、5 覆蓋。
- 套件渲染與來源測試產物不同：測試必須使用發布 ZIP 裡的入口；Task 1 覆蓋。
- 沒有 PowerPoint／CUA 或實際字型：安裝成功不能宣稱正式交付可用；Task 2、5 覆蓋。
- PowerPoint 另存或後續修改已驗證檔案：報告必須綁定最新檔案雜湊；Task 5、6 覆蓋。

## 共同資料介面

下列型別名稱固定，內容依現有 Zod 模式實作；不必新增資料庫。

`src/quality/types.ts`：

```ts
type CheckStatus = "passed" | "failed" | "not_run" | "partial";
type QualityIssue = {
  code: string;
  severity: "error" | "warning";
  slideId?: string;
  objectId?: string;
  message: string;
  suggestedAction: string;
};
type QualityCheck = {
  status: CheckStatus;
  method: "rules" | "render" | "agent_review" | "powerpoint_ui" | "human";
  artifactDigest?: string;
  reviewedSlideIds: string[];
  checkedAt: string;
  issues: QualityIssue[];
};
type QualityReport = {
  version: 1;
  jobId: string;
  sourceDigest: string;
  finalArtifactDigest: string | null;
  deliveryState: "draft" | "verified";
  checks: Record<"package" | "layout" | "preview" | "editorial" |
    "accessibility" | "powerpoint", QualityCheck>;
};
```

`src/contracts/editorial-brief.ts`：

- `EditorialBrief`：`version: 1`、`sourceDigest`、`audience`、`purpose`、`useCase: "presenting" | "reading"`、可選 `requestedSlideCount`、`mustKeepFacts`、`assets`、`slides`。
- `SourceSpan`：`startLine`／`endLine`（1 起算、含首尾）；只指本次 Markdown。外部 PDF 查核由宿主另存驗證紀錄，不能用不透明路徑突破既有附件介面。
- `MustKeepFact`：`id`、`sourceSpan`、`verbatim`、`placement: "slide" | "notes"`；未指定放置時採 slide。
- `EditorialSlide`：`slideId`、`purpose`、`evidence: SourceSpan[]`、`factIds`、`form`、`variant`、`focus`、`limitations: string[]`、`speakerNotes: string[]`。
- `form`：`metric | comparison | sequence | architecture | trend | definition | image-evidence | table | summary`；是語意提示，仍使用現有 11 種 layout。
- `variant`：`default | compact | metric | text-left | text-right | image-above | flow-horizontal | flow-branch`；只允許對應版型的變體。compact 不降低字級下限。
- `focus`：`{ kind: "block" | "image" | "chart" | "table" | "diagram", id?: string }`；只指既有內容，不收任意座標。
- `chartContext`：圖表頁使用的 `{ xLabel: string; yLabel: string; unit: string; referencePeriod?: string }`；無單位資料明填 `unit: "none"`，來源沒有的單位不可猜測。
- `assets`：每個 `assetId` 的 `role: "brand" | "evidence" | "illustration"` 和 `altText`；品牌可使用封面預定槽位，圖片仍保留原比例。
- 目的欄上限 120 字，來源位置保存範圍而非全文；所有 ID 必須可解析。notes 不得取代使用者指定必須出現在畫面上的資訊。

## Task 0：保存基準與評分錨點（P0）

**Files:** Create `tests/fixtures/quality/manifest.json`、該目錄的八組固定 MD／plan／合法素材；Create `docs/operations/quality-baseline.md`。

**Interfaces:** 使用目前發布套件；產出固定案例 ID、來源／設定摘要、版本與成品位置、評分項目、預期頁數及必留事實清單。私人案例保存在本機未追蹤工作檔，公開紀錄只用匿名案例 ID。

- [ ] 為規格的八組正向情境製作可公開資料；每組明確列出預期頁數、圖片與必留事實。
- [ ] 用尚未修改的 `3ae3597` 套件保存 PPTX、Marp、縮圖及驗證結果；保留失敗，不能先人工美化。
- [ ] 為五個評分維度各寫 1／3／5 分的可觀察描述，標註至少一頁正反例。
- [ ] 記錄模型與宿主設定、修訂輪數、用量可用性、耗時、人工修改頁數；使用同一組模型設定建立比較基線。
- [ ] 完成基準表，缺資料明列未知；提交可公開的固定輸入、評分規則與紀錄。

**Exit:** PM 能指出「哪一頁為什麼不好」；基準檔可重產、沒有虛構用量數字。

## Task 1：統一渲染來源及測試發布套件（P0）

**Files:** Modify `src/layout/build-slide.ts`、`src/layout/geometry.ts`、`src/layout/overflow.ts`、`src/pptx/add-layout-object.ts`、`src/pptx/render-pptx.ts`、`package.json`、`assets/themes/default.json`、`scripts/apply-presentation-preferences.mjs`；Remove 完成遷移後的 `scripts/presentation-overrides/`；Create `tests/integration/built-renderer-quality.test.ts`；Modify `tests/e2e/package-plugin.e2e.test.ts`。

**Interfaces:** 保留現有 `buildSlideLayout`、`renderPptx` 對外介面。補齊 Theme 的 spacing、深色與圖表色彩型別；`dist` 完全由 `src` 編譯，建置不改寫受版本控制的 theme。

- [x] 加入實際匯出檔的檢查：11 種版型、等比例圖片、文字 `anchor=ctr`、每側內距、表格對齊及無非法封裝引用；先記錄現在 source／dist 的差異。
- [x] 以正式 override 行為為基準遷回 TypeScript；不得因移除覆寫而退回舊版表格或頂端對齊。
- [x] 把主題設定保存於資產來源，取消 build 時複製程式及以字串替換對齊值；只在沒有其他用途後移除舊腳本。
- [x] 執行 `npm run build` 及 `npx vitest run tests/unit/layout.test.ts tests/unit/add-layout-object.test.ts tests/integration/built-renderer-quality.test.ts tests/integration/pptx-roundtrip.test.ts tests/e2e/package-plugin.e2e.test.ts`，預期全部通過。
- [x] 解開候選 ZIP，從包內啟動 MCP 並渲染混合版型簡報；檢查產物與基準規則相符，提交此獨立修改。

**Exit:** 測試、Plugin 安裝及重新打包使用同一渲染邏輯；使用者偏好不因重新建置而消失。

## Task 2：製作前檢查與交付狀態（P0）

**Files:** Create `src/quality/types.ts`、`src/quality/preflight.ts`、`scripts/preflight.mjs`、`tests/integration/production-preflight.test.ts`；Modify `skills/marp-ppt/SKILL.md`、`scripts/install-codex-macos.sh`、`scripts/package-plugin.ts`、`docs/operations/local-install.md`、`docs/operations/acceptance-report.md`。

**Interfaces:** `runLocalPreflight(options: { outputRoot: string }): Promise<LocalPreflightReport>`。`LocalPreflightReport` 含 Node／MCP、可寫輸出、soffice／Poppler、字型實際匹配與問題；PowerPoint／CUA 狀態由宿主探查另記，未知不能當成可用。

- [x] 加入缺字型、缺預覽器、輸出不可寫與外接磁碟不可用案例；預期報告具體缺項，不開始完整製作。
- [x] 以現有 `renderer-readiness` 的有界程序檢查為基礎完成 preflight；字型比對實際 family，不能只因 `fc-match` exit 0 就認定成功。
- [x] 安裝後區分「MCP 已啟動」與「正式製作條件已具備」；預設不在安裝腳本裡偷偷安裝 Microsoft PowerPoint。
- [x] 修改 Skill：先檢查必要能力；若正式交付受阻，指出原因。生成草稿須符合使用者指定的交付範圍。
- [x] 執行 `npm run build`、`npx vitest run tests/integration/production-preflight.test.ts tests/e2e/package-plugin.e2e.test.ts`；預期正向／負向狀態一致。更新驗收證據而非推測，提交。

**Exit:** 使用者不再先消耗整份製作額度，最後才發現沒有字型或無法執行正式驗收。

## Task 3：編輯提要、頁數容量與來源保護（P1）

**Files:** Create `src/contracts/editorial-brief.ts`、`src/quality/check-editorial.ts`、`skills/marp-ppt/references/editorial-workflow.md`、`tests/unit/editorial-brief.test.ts`；Modify `src/mcp/tools/render-presentation.ts`、`src/contracts/presentation-plan.ts`、`skills/marp-ppt/SKILL.md`、`tests/integration/render-presentation-tool.test.ts`。

**Interfaces:** 新增可選 `RenderPresentationInput.editorialBrief: EditorialBrief`。`checkEditorial(brief: EditorialBrief, plan: PresentationPlan, markdown: string): QualityIssue[]` 檢查映射與容量；不能自稱完成主張真偽判定。既有無 brief 請求仍匯出，editorial 為 not_run。

- [x] 加入來源行範圍越界、sourceDigest 不符、未知 slideId／factId／圖片、必留正文被移到備註等案例，預期明確 error。
- [x] 加入指定 10 頁且圖片未分配案例：不能自動變成 11 頁；預期有包含頁數限制與待放圖片的可處理錯誤。
- [x] 實作 schema 與檢查。保留來源中文字、數字、單位和限定條件；verbatim 比對只驗來源摘錄正確，另由語意審閱核對輸出是否保留事實。除非使用者要求逐字，不以整句相同作為摘要合格條件。
- [x] 讓 append logic 知道明確頁數限制；未指定頁數時可依原有規則加附圖。此階段先使用既有圖片版型，封面品牌槽位由 Task 4 一併修改 schema 和 renderer。
- [x] Skill 將目的、標題、證據、形式與細節容器放進同一次全稿規劃；只載入用得到的細節指引。資訊衝突一次提出具體選項。
- [x] 執行 `npm run build`、`npx vitest run tests/unit/editorial-brief.test.ts tests/unit/presentation-plan.test.ts tests/integration/render-presentation-tool.test.ts`，預期全部通過；提交。

**Exit:** 給出 10 頁需求時，系統知道每一頁為何存在、證據在哪裡，以及所有附件如何占用這 10 頁。

## Task 4：內容適配的核心版型（P1）

**Files:** Create `src/layout/choose-variant.ts`、`src/layout/text-flow.ts`、`src/layout/diagram-flow.ts`、`tests/unit/layout-variants.test.ts`；Modify `src/contracts/presentation-plan.ts`、`src/layout/build-slide.ts`、`src/layout/geometry.ts`、`src/layout/overflow.ts`、`src/pptx/add-layout-object.ts`、`src/pptx/render-pptx.ts`、`assets/themes/default.json`、`skills/marp-ppt/references/layout-contract.md`。

**Interfaces:**

- `LayoutContext` 含可選 `editorialSlide: EditorialSlide`、`assets: ReadonlyMap<string, { width: number; height: number; altText: string; role: string }>`。
- `buildSlideLayout(slide, theme, context?: LayoutContext): LayoutObject[]` 保留舊呼叫；`chooseVariant(slide, context): EditorialSlide["variant"]` 只回傳相容變體。
- `RenderPptxOptions` 含可選 `editorialBrief`；`renderPptx(plan, assets, theme, options?: RenderPptxOptions)` 保留原三參數呼叫。
- 文字量測只作預估，保留 CJK 權重並增加長英文詞、混排、換行與字型環境的測試；實際渲染問題由 Task 5 處理。

- [ ] 用 4:1 與 1:4 圖片驗證原比例、完整可見且不同變體給予合理面積；兩句正文不再平均分散至整個內容區。
- [ ] 為中文長標題、混合英文術語、5×5 長表格、過多流程節點加入案例；預期超容量時回報修訂要求，不能縮字或截掉內容。
- [ ] 實作三種圖文變體、主指標變體、線性與分支流程；箭頭沿關係方向排列，避免穿越節點。未支持的複雜圖維持明確容量限制。
- [ ] 封面增加預定品牌圖片槽位，同步放寬 plan 的 cover 圖片限制並驗證圖片未遺失、未拉伸；不開放任意圖片座標。
- [ ] 將內文預設改成 22 pt，軸標／圖例／必要註解至少 18 pt；表格採規格的每側內距、首欄優先及 1.2 行高。新增必要限制說明區時要預先扣除主證據區高度。
- [ ] 渲染八組基準，輸出縮圖與單頁預覽；執行 `npm run build`、`npx vitest run tests/unit/layout-variants.test.ts tests/unit/layout.test.ts tests/integration/built-renderer-quality.test.ts`。
- [ ] 按評分錨點看實際成品，完成可讀性與內容核對，提交。不能只因 bounds 通過就結束。

**Exit:** 品質先在一套主題、有限變體上改善；不靠額外圖片生成或增加許多相似模板。

## Task 5：規則、視覺審閱及驗證報告（P2）

**Files:** Create `src/quality/check-layout.ts`、`src/quality/delivery-report.ts`、`scripts/record-quality-review.mjs`、`tests/unit/delivery-report.test.ts`、`tests/integration/quality-gates.test.ts`；Modify `src/mcp/tools/render-presentation.ts`、`src/preview/contact-sheet.ts`、`skills/marp-ppt/SKILL.md`、`skills/marp-ppt/references/production-quality.md`、`scripts/package-plugin.ts`。

**Interfaces:** `checkLayoutQuality(objects: LayoutObject[], theme: Theme): QualityIssue[]`；`evaluateDelivery(report: QualityReport, actualDigest: string): "draft" | "verified"`，六項均 passed 且 finalArtifactDigest 等於 actualDigest 才 verified。MCP 增加 quality report 引用；主機審閱紀錄由受控本機 CLI 寫入，和 MCP 已檢查事項分別保存。

- [ ] 加入低對比、軸標過小、文字真實溢出標記、未知 PowerPoint 狀態及 final digest 不符案例；預期 deliveryState=draft。
- [ ] 幾何檢查區分背景包含文字等合法重疊與前景遮蔽；用角色及關聯物件判定，不把所有相交矩形判成錯誤。
- [ ] 輸出帶頁碼的整份縮圖；列出表格／圖表、低解析、密集文字與規則警告等需放大審閱頁面。審閱紀錄含方法、頁面、問題與證據。
- [ ] Skill 執行一次整體視覺審閱，最多兩輪修訂；每輪只改被點名的頁面並重查必留事實。不宣稱只重繪單頁，本機可完整重建 ZIP／PDF。
- [ ] 以同一 job 的 revisionCount 計算內容／視覺修訂；加入錯誤類型交替仍最多兩輪的案例。同輸入重試的 attemptCount 最多為 2，工具及 Agent 不得各自倍增。
- [ ] 最終 PowerPoint 另存檔再次檢查 ZIP，計算 digest；若檔案再改動，報告回到待驗證。沒有 CUA 時不能手動填 passed 代替實際觀察。
- [ ] 執行 `npm run build`、`npx vitest run tests/unit/delivery-report.test.ts tests/integration/quality-gates.test.ts`，預期不完整關卡無法獲得 verified；提交。

**Exit:** 有圖像預覽不再等同視覺檢查完成，成功欄位清楚對應到真正檢查的範圍。

## Task 6：備註、可及性與真實編輯驗收（P2）

**Files:** Create `src/pptx/add-accessible-content.ts`、`tests/integration/accessibility-structure.test.ts`；Modify `src/pptx/render-pptx.ts`、`src/pptx/add-layout-object.ts`、`src/marp/serialize-marp.ts`、`skills/marp-ppt/references/production-quality.md`、`tests/integration/pptx-roundtrip.test.ts`。

**Interfaces:** `addAccessibleContent(slideApi, editorialSlide, layoutObjects): void` 寫入標題語意、講者備註及支持的可及性資訊。新增的 PptxSlideApi 能力必須與實際 PptxGenJS API 或小範圍 OOXML adapter 對應。Marp 備註使用 serializer 產生的安全格式，所有輸入仍視為文字。

- [ ] 先用一頁證明 PowerPoint 能識別標題佔位區、有意義的 alt text、裝飾狀態與閱讀順序；做不到的能力明列 partial，不能用物件名稱充當語意。
- [ ] 加入標題、圖片替代文字、備註、裝飾元素不干擾閱讀及惡意備註字串的輸出驗證；防止備註引入原生指令或破壞 Marp 結構。
- [ ] 為每個圖文物件寫入相應資訊，選定可行的標題／閱讀順序實作；保留獨立可編輯物件與穩定 ID。
- [ ] 執行 `npm run build`、`npx vitest run tests/integration/accessibility-structure.test.ts tests/integration/pptx-roundtrip.test.ts`。
- [ ] 在 PowerPoint 執行 Accessibility Checker，人工核對閱讀順序；實際改中文、標題、表格、圖表數值及圖片大小，另存、關閉、重開並更新最終報告；提交。

**Exit:** 可編輯性與可及性都有實際軟體行為的證據；場地後排檢查仍由真實投影驗收。

## Task 7：用量紀錄、品質比較及發布（P3）

**Files:** Create `src/quality/work-metrics.ts`、`tests/unit/work-metrics.test.ts`、`scripts/evaluate-quality.mjs`、`docs/operations/quality-release-checklist.md`、`examples/quality/`；Modify `.github/workflows/build.yml`、`docs/operations/quality-baseline.md`、`docs/operations/acceptance-report.md`、`README.md`、`README.zh-TW.md`、`CHANGELOG.md`；視確認後的版本號同步所有 manifest／lockfile。

**Interfaces:** `WorkMetrics` 記錄 jobId、各階段 elapsedMs、修訂原因／輪次、host 提供的 token 或 null、視覺輸入數與人工修改頁數。既有不可觀測的模型費用不得由本機猜測。

- `WorkEvent` 含 eventId、stage、attemptId、elapsedMs、inputTokens／outputTokens（number 或 null）；`recordWorkEvent(metrics: WorkMetrics, event: WorkEvent): WorkMetrics` 按 eventId 去重，保留原始事件與未知用量。

- [ ] 加入「用量缺失保留 null、失敗重試計入總成本、同次事件不重複計數」案例，先確認測試失敗。
- [ ] 實作事件彙整並接入已有的工作階段，執行 `npx vitest run tests/unit/work-metrics.test.ts`，預期全部通過。
- [ ] 用與 Task 0 相同的輸入／模型設定做比較，保存首次候選及最終候選；所有失敗重試均列入成本。
- [ ] 執行完整測試、typecheck、package validation、production audit；由 Actions 驗證 Linux。針對既有 macOS 程序／逾時問題重現根因，使用明確 readiness 訊號修復競態，避免只隨意拉大等待時間。
- [ ] 在可登入的 Codex 新對話實測啟動、MD／圖片交接、產物開啟及 PowerPoint 編輯重開。缺項保持未通過；不以 CLI 列出工具代替對話驗收。
- [ ] 以八件實際結果計算品質分數、首次成功數、人工修改頁數、用量中位數及時間分位數；未達標項目列入下一輪研發，不能隱藏失敗樣本。
- [ ] README 提供由候選套件實際生成的 3–4 種代表案例與限制；每張預覽可對應下載的 PPTX、來源和版本。
- [ ] 滿足正式發布門檻後才更新版本及封裝；公開版的支援矩陣及驗收時間同步更新。模型評估只在里程碑／發布候選執行，日常 CI 使用固定計畫以控制額度。

**Exit:** 使用者能看見可重現的品質承諾與真實範例，研發也能知道用量花在哪裡。未量測前不宣稱省下 30%。

## 依賴與完成定義

Task 0 → Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。
每項以小型提交交付，但只有最後發布門檻通過才能宣稱整體改善已完成。

本計畫未執行任何新測試、未產生新簡報、未修改 Plugin 功能或對外發布。下一個工程動作是建立 Task 0 的基準及 Task 1 的發布套件一致性驗證。
