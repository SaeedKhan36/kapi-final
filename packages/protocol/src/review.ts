import { z } from "zod";

/**
 * Only blockers and majors stop a merge. Minors and nits are recorded on the
 * pull request for a human to weigh, because a reviewer that blocks on style
 * turns into a loop the worker cannot satisfy.
 */
export const ReviewSeveritySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = ["blocker", "major"];

export const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string().optional(),
  /** What is wrong, stated as a defect rather than a preference. */
  issue: z.string().min(3),
  /** How to fix it. Required for anything blocking, so the worker can act. */
  suggestion: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewVerdictSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().min(3),
  findings: z.array(ReviewFindingSchema).default([]),
  /** Whether the diff satisfies each acceptance criterion, in order. */
  acceptanceMet: z.array(z.boolean()).default([]),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const blockingFindings = (v: ReviewVerdict): ReviewFinding[] =>
  v.findings.filter((f) => BLOCKING_SEVERITIES.includes(f.severity));

/**
 * Reconciles the stated decision with the findings.
 *
 * Models routinely say "approve" while listing a blocker, or "request_changes"
 * with nothing but nits. The findings are the evidence, so they win.
 */
export function normaliseVerdict(verdict: ReviewVerdict): ReviewVerdict {
  const blocking = blockingFindings(verdict);
  if (blocking.length > 0 && verdict.decision === "approve") {
    return { ...verdict, decision: "request_changes" };
  }
  if (blocking.length === 0 && verdict.decision === "request_changes") {
    return { ...verdict, decision: "approve" };
  }
  return verdict;
}

/** Renders blocking findings as instructions a worker can act on directly. */
export function renderChangeRequest(verdict: ReviewVerdict): string {
  const blocking = blockingFindings(verdict);
  return [
    "A reviewer examined your branch and asked for changes.",
    "",
    `Reviewer summary: ${verdict.summary}`,
    "",
    "Fix each of these, then finish:",
    ...blocking.map((f, i) => {
      const where = f.file ? ` (${f.file})` : "";
      const how = f.suggestion ? `\n   Suggested fix: ${f.suggestion}` : "";
      return `${i + 1}. [${f.severity}]${where} ${f.issue}${how}`;
    }),
    "",
    "Change only what is needed to resolve these points. Do not start new work.",
  ].join("\n");
}
