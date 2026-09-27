export type CheckStatus = "passed" | "failed" | "not_run" | "partial";

export interface QualityIssue {
  code: string;
  severity: "error" | "warning";
  slideId?: string;
  objectId?: string;
  message: string;
  suggestedAction: string;
}

export interface QualityCheck {
  status: CheckStatus;
  method: "rules" | "render" | "agent_review" | "powerpoint_ui" | "human";
  artifactDigest?: string;
  reviewedSlideIds: string[];
  checkedAt: string;
  issues: QualityIssue[];
}

export interface QualityReport {
  version: 1;
  jobId: string;
  sourceDigest: string;
  finalArtifactDigest: string | null;
  deliveryState: "draft" | "verified";
  checks: Record<"package" | "layout" | "preview" | "editorial" | "accessibility" | "powerpoint", QualityCheck>;
}

export type PreflightCommandName = "soffice" | "pdfinfo" | "pdftoppm" | "pdftotext" | "fc-match";

export interface LocalPreflightReport {
  status: Extract<CheckStatus, "passed" | "failed" | "partial">;
  checkedAt: string;
  outputRoot: string;
  node: {
    version: string;
    supported: boolean;
  };
  mcp: {
    entrypoint: string;
    available: boolean;
  };
  output: {
    absolute: boolean;
    directory: boolean;
    writable: boolean;
  };
  renderers: Record<"soffice" | "pdfinfo" | "pdftoppm" | "pdftotext", { available: boolean }>;
  font: {
    requested: string;
    matched: string | null;
    available: boolean;
  };
  issues: QualityIssue[];
}
