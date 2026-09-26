import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type {
  AssetManifestEntry,
  PresentationPlan,
  SlidePlan,
} from "../../src/contracts/presentation-plan.js";
import type { Theme } from "../../src/layout/geometry.js";

export function loadDefaultTheme(): Theme {
  return JSON.parse(readFileSync(resolve(process.cwd(), "assets/themes/default.json"), "utf8")) as Theme;
}

export function makeResolvedImageFixture(assetId: string, fileName: string): AssetManifestEntry {
  const mimeType = fileName.toLowerCase().endsWith(".jpg") || fileName.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";
  return {
    assetId,
    fileName,
    mimeType,
    byteLength: 128,
    sha256: "b".repeat(64),
  };
}

export async function makeResolvedImagePathFixture(
  assetId: string,
  fileName: string,
  directory: string,
): Promise<AssetManifestEntry & { path: string }> {
  const path = join(directory, fileName);
  const imageBytes = await sharp({
    create: { width: 10, height: 8, channels: 4, background: "#33aaff" },
  }).png().toBuffer();
  await writeFile(path, imageBytes, { flag: "wx", mode: 0o600 });
  return {
    ...makeResolvedImageFixture(assetId, fileName),
    mimeType: "image/png",
    byteLength: imageBytes.byteLength,
    sha256: createHash("sha256").update(imageBytes).digest("hex"),
    path,
  };
}

export function fixturesForAllLayouts(): SlidePlan[] {
  return [
    { id: "cover", title: "KV Cache 壓縮", subtitle: "一頁看懂 890 B/token", layout: "cover", imageIds: [], sourceRefs: ["## 摘要"] },
    { id: "section", title: "壓縮方法", layout: "section", blocks: [{ id: "section-intro", text: "從表示方式與量化方法著手" }], imageIds: [], sourceRefs: ["## 方法"] },
    { id: "takeaway", title: "重點結論", layout: "takeaway", blocks: [{ id: "conclusion", text: "以低位元快取降低記憶體需求" }], imageIds: [], sourceRefs: ["## 摘要"] },
    { id: "bullets", title: "設計重點", layout: "bullets", blocks: [
      { id: "b1", text: "保留高影響特徵" },
      { id: "b2", text: "量化低敏感資料" },
      { id: "b3", text: "依序驗證推論品質" },
    ], imageIds: [], sourceRefs: ["## 設計"] },
    { id: "image-text", title: "圖文配置", layout: "image-text", blocks: [{ id: "image-note", text: "圖片與來源敘述分開呈現" }], imageIds: ["image-1"], sourceRefs: ["## 圖片"] },
    { id: "comparison", title: "方案比較", layout: "comparison", columns: [
      { id: "left", title: "基準方法", blocks: [{ id: "left-point", text: "保留完整精度" }] },
      { id: "right", title: "壓縮方法", blocks: [{ id: "right-point", text: "減少快取佔用" }] },
    ], imageIds: [], sourceRefs: ["## 比較"] },
    { id: "image", title: "參考圖", layout: "image", imageIds: ["image-1"], sourceRefs: ["## 圖片"] },
    { id: "chart", title: "指標變化", layout: "chart", chart: {
      kind: "bar", labels: ["A", "B"], series: [{ name: "記憶體", values: [12, 5] }],
    }, imageIds: [], sourceRefs: ["## 結果"] },
    { id: "table", title: "指標表格", layout: "table", table: {
      columns: ["模式", "用量"], rows: [["基準", "12"], ["壓縮", "5"]],
    }, imageIds: [], sourceRefs: ["## 表格"] },
    { id: "diagram", title: "推論流程", layout: "diagram", diagram: {
      nodes: [{ id: "input", label: "輸入" }, { id: "encode", label: "壓縮" }, { id: "output", label: "推論" }],
      edges: [{ from: "input", to: "encode" }, { from: "encode", to: "output" }],
    }, imageIds: [], sourceRefs: ["## 流程"] },
    { id: "closing", title: "總結", layout: "closing", blocks: [{ id: "next-step", text: "以實測確認速度與品質" }], imageIds: [], sourceRefs: ["## 總結"] },
  ];
}

export function makePresentationPlanFixture(): PresentationPlan {
  const slides = fixturesForAllLayouts();
  const image = makeResolvedImageFixture("image-1", "kv-cache.png");
  return {
    version: 1,
    title: "KV Cache 壓縮",
    language: "zh-TW",
    themeId: "default",
    sourceDigest: "a".repeat(64),
    slides,
    imageAssetIds: [image.assetId],
    assetManifest: [image],
  };
}

export function makeMixedDeckFixture(): PresentationPlan {
  return makePresentationPlanFixture();
}
