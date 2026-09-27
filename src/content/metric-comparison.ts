export type MetricDirection = "increase" | "decrease";

export interface MetricComparison {
  before: string;
  after: string;
  beforeValue: number;
  afterValue: number;
  context: string;
  direction: MetricDirection;
  scale: 1.5;
}

const NUMBER = String.raw`[-+]?\d[\d,]*(?:\.\d+)?`;
const UNIT = String.raw`(?:[%％]|分數?|秒|毫秒|分鐘?|小時|天|次|倍|人|件|元|[A-Za-z]+(?:\/[A-Za-z]+)?)`;
const METRIC_PATTERN = new RegExp(
  String.raw`^(?<lead>[\p{L}\p{N}_%％/（）()、，,：:；;\s]{0,32}?)(?:從|由)\s*(?<before>${NUMBER})\s*(?<beforeUnit>${UNIT})?\s*(?:(?<verb>提升|增加|上升|成長|改善|提高|降低|下降|減少)\s*(?:到|至|為)?|(?<direct>到|至|變為|成為))\s*(?<after>${NUMBER})\s*(?<afterUnit>${UNIT})?(?<tail>[。．.！!？?，,；;、\s]*)$`,
  "u",
);

const DECREASE_WORDS = new Set(["降低", "下降", "減少"]);

function numberValue(value: string): number {
  return Number(value.replace(/,/gu, ""));
}

function normalizeUnit(value: string | undefined): string {
  return (value ?? "").replace(/％/gu, "%").trim();
}

function cleanContext(value: string): string {
  return value
    .replace(/[\s　]+/gu, "")
    .replace(/^[，,、：:；;]+|[，,、：:；;]+$/gu, "");
}

export function parseMetricComparison(value: string): MetricComparison | undefined {
  const match = METRIC_PATTERN.exec(value.trim());
  if (!match?.groups) return undefined;

  const lead = cleanContext(match.groups.lead ?? "");
  // A year followed by「從…到…」is normally a date range, not a metric.
  if (/^\d{4}年$/u.test(lead)) return undefined;

  const beforeValue = numberValue(match.groups.before!);
  const afterValue = numberValue(match.groups.after!);
  if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue) || beforeValue === afterValue) return undefined;

  const beforeUnit = normalizeUnit(match.groups.beforeUnit);
  const afterUnit = normalizeUnit(match.groups.afterUnit);
  if (beforeUnit && afterUnit && beforeUnit !== afterUnit) return undefined;
  const unit = beforeUnit || afterUnit;
  const verb = match.groups.verb ?? match.groups.direct ?? "變化";
  const direction: MetricDirection = DECREASE_WORDS.has(verb) || afterValue < beforeValue ? "decrease" : "increase";

  return {
    before: `${match.groups.before}${unit}`,
    after: `${match.groups.after}${unit}`,
    beforeValue,
    afterValue,
    context: `${lead}${verb}`,
    direction,
    scale: 1.5,
  };
}
