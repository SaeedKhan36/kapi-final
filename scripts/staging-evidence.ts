export type LifecycleJob = {
  id: string;
  parentJobId: string | null;
  kind: string;
  status: string;
  result?: {
    commits?: string[];
    prUrl?: string;
    review?: { decision?: string };
  } | null;
};

export type LifecycleEvidence = {
  run: { id: string; status: string; finishedAt?: string | null };
  jobs: LifecycleJob[];
  events: Array<{ kind: string }>;
  agents: Array<{ stopped_at?: string | null; stoppedAt?: string | null }>;
};

export type LifecycleThread = {
  messages: Array<{ role: string; runId?: string | null; content?: string }>;
};

export type EvidenceCheck = { name: string; ok: boolean; detail: string };

/** Converts a completed staging run into explicit release evidence. */
export function evaluateLifecycle(
  detail: LifecycleEvidence, thread: LifecycleThread,
): { ok: boolean; checks: EvidenceCheck[] } {
  const root = detail.jobs.find((job) => job.parentJobId === null && job.kind === "captain");
  const builds = detail.jobs.filter((job) => job.kind === "build");
  const reviews = detail.jobs.filter((job) => job.kind === "review");
  const buildWithPr = builds.find((job) =>
    job.status === "succeeded" && Boolean(job.result?.prUrl) && (job.result?.commits?.length ?? 0) > 0);
  const reviewWithVerdict = reviews.find((job) =>
    job.status === "succeeded" && Boolean(job.result?.review?.decision));
  const captainReply = thread.messages.find((message) =>
    message.role === "captain" && message.runId === detail.run.id && Boolean(message.content?.trim()));
  const activeAgents = detail.agents.filter((agent) => !(agent.stopped_at ?? agent.stoppedAt));
  const unfinishedJobs = detail.jobs.filter((job) =>
    !["succeeded", "failed", "cancelled"].includes(job.status));

  const checks: EvidenceCheck[] = [
    { name: "run completed", ok: detail.run.status === "completed" && Boolean(detail.run.finishedAt),
      detail: `status=${detail.run.status}` },
    { name: "root Captain succeeded", ok: root?.status === "succeeded",
      detail: root ? `${root.id} status=${root.status}` : "missing root Captain" },
    { name: "Build produced a commit and pull request", ok: Boolean(buildWithPr),
      detail: buildWithPr ? `${buildWithPr.id} ${buildWithPr.result?.prUrl}` : `${builds.length} Build job(s)` },
    { name: "Review produced a structured verdict", ok: Boolean(reviewWithVerdict),
      detail: reviewWithVerdict
        ? `${reviewWithVerdict.id} decision=${reviewWithVerdict.result?.review?.decision}`
        : `${reviews.length} Review job(s)` },
    { name: "GitHub CI returned through the webhook", ok: detail.events.some((event) => event.kind === "ci.completed"),
      detail: `${detail.events.filter((event) => event.kind === "ci.completed").length} CI event(s)` },
    { name: "Captain replied in the thread", ok: Boolean(captainReply),
      detail: captainReply ? "captain message recorded" : "captain message missing" },
    { name: "all jobs are terminal", ok: unfinishedJobs.length === 0,
      detail: unfinishedJobs.length ? `${unfinishedJobs.length} unfinished job(s)` : `${detail.jobs.length} terminal job(s)` },
    { name: "all agent rows are stopped", ok: activeAgents.length === 0,
      detail: activeAgents.length ? `${activeAgents.length} active agent(s)` : "no active agents" },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}
