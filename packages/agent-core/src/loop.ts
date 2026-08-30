import type { Checkpoint, WireMessage } from "@kapi/protocol";
import type { AgentTool, LoopOutcome, ModelCaller, ToolContext } from "./types.ts";

export type LoopOptions = {
  system: string;
  /** The task brief. Ignored when resuming - the checkpoint carries its own. */
  brief: string;
  tools: AgentTool[];
  ctx: ToolContext;
  callModel: ModelCaller;
  tier?: "reasoning" | "coding" | "cheap";
  /** Hard cap on model calls for this job. */
  maxSteps?: number;
  /** How many recent steps keep their full tool output. */
  keepFullSteps?: number;
  onCheckpoint?: (checkpoint: Checkpoint) => Promise<void>;
  resumeFrom?: Checkpoint | null;
  /** Checked between steps. False stops the loop cleanly. */
  alive?: () => boolean;
};

/**
 * Compacts the transcript to a brief plus a sliding window of recent steps.
 *
 * Appending every observation forever is what makes a long agent loop
 * expensive: cost grows quadratically with steps, because each call re-sends
 * everything before it. The old build measured 833k tokens burned in a single
 * run before this existed. Older steps keep the ACTION - so the agent still
 * knows what it already tried - and drop the payload.
 */
export function compact(
  messages: WireMessage[], keepFull: number,
): { messages: WireMessage[]; summary: string } {
  // The first message is the task brief and is never dropped.
  const [brief, ...rest] = messages;
  if (!brief) return { messages, summary: "" };

  // A step is an assistant turn plus its tool results, so windowing has to
  // count assistant turns rather than raw messages or it splits a pair.
  const assistantIndexes = rest
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);

  if (assistantIndexes.length <= keepFull) return { messages, summary: "" };

  const cut = assistantIndexes[assistantIndexes.length - keepFull]!;
  const dropped = rest.slice(0, cut);
  const kept = rest.slice(cut);

  const actions: string[] = [];
  for (const m of dropped) {
    if (m.role !== "assistant") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const part of parts as Array<{ type?: string; toolName?: string; input?: unknown }>) {
      if (part.type === "tool-call") {
        const target = (part.input as { path?: string; command?: string } | undefined);
        const detail = target?.path ?? target?.command ?? "";
        actions.push(`${part.toolName}${detail ? `: ${String(detail).slice(0, 80)}` : ""}`);
      }
    }
  }

  // Naming the actions is not enough on its own: an agent that can no longer
  // see a file it read will simply read it again, which pushes more out of the
  // window and turns exploration into a loop. Say plainly that repeating them
  // is wasted, so the agent works from what it already concluded.
  const summary = actions.length
    ? `Steps you have ALREADY completed (their output is omitted to save context):\n` +
      actions.map((a, i) => `${i + 1}. ${a}`).join("\n") +
      `\n\nDo not repeat these. Re-running one returns the same result and wastes a step. ` +
      `Act on what you learned from them.`
    : "";

  return {
    messages: [
      brief,
      ...(summary ? [{ role: "user" as const, content: summary }] : []),
      ...kept,
    ],
    summary,
  };
}

/**
 * The agent turn loop.
 *
 * Model calls go over the wire to the control plane; tools run right here, on
 * the VM, against the real filesystem. The model returns structured tool calls
 * rather than prose to be parsed, which removes the whole class of parsing
 * failures the old build's JSON-batching workaround existed to manage.
 */
export async function runLoop(opts: LoopOptions): Promise<LoopOutcome> {
  const {
    system, brief, tools, ctx, callModel,
    tier = "coding",
    maxSteps = Number(process.env.KAPI_MAX_STEPS ?? 40),
    keepFullSteps = Number(process.env.KAPI_KEEP_FULL_STEPS ?? 6),
    onCheckpoint, resumeFrom, alive = () => true,
  } = opts;

  const byName = new Map(tools.map((t) => [t.name, t]));
  const wireTools = tools.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema,
  }));

  let messages: WireMessage[] = resumeFrom?.messages?.length
    ? resumeFrom.messages
    : [{ role: "user", content: brief }];
  let step = resumeFrom?.step ?? 0;
  const filesTouched = new Set(resumeFrom?.filesTouched ?? []);
  const commits = [...(resumeFrom?.commits ?? [])];
  let branch = resumeFrom?.branch;
  let prUrl: string | undefined;
  let terminalMeta: Record<string, unknown> | undefined;

  if (resumeFrom?.messages?.length) {
    ctx.log(`resuming from step ${step} with ${messages.length} message(s)`, { resumed: true });
  }

  let summary = "";
  let finished = false;
  let stopped: string | null = null;

  while (step < maxSteps && !finished) {
    if (!alive()) { stopped = "lease lost or job cancelled"; break; }
    step++;

    const compacted = compact(messages, keepFullSteps);
    messages = compacted.messages;

    // Near the cap, ask for a landing rather than more work. An agent cut off
    // mid-thought leaves a branch nobody can interpret.
    const remaining = maxSteps - step;
    const prompt: WireMessage[] = remaining <= 1
      ? [...messages, {
          role: "user",
          content:
            `You have ${remaining + 1} step(s) left. Do not start anything new. ` +
            `If the work is done, call finish. If it is not, commit what you have and ` +
            `call finish stating plainly what remains.`,
        }]
      : messages;

    let response;
    try {
      response = await callModel({ tier, system, messages: prompt, tools: wireTools });
    } catch (err) {
      stopped = err instanceof Error ? err.message : String(err);
      ctx.log(`model call failed at step ${step}: ${stopped}`);
      break;
    }

    if (response.text) ctx.log(response.text.slice(0, 500), { step, kind: "thought" });

    if (response.toolCalls.length === 0) {
      // No tool call and no finish: nudge once rather than looping on prose.
      messages.push({ role: "assistant", content: response.text || "(no output)" });
      messages.push({
        role: "user",
        content: "Call a tool to make progress, or call finish if the task is complete.",
      });
      if (response.budgetExhausted) { stopped = "run budget exhausted"; break; }
      continue;
    }

    messages.push({
      role: "assistant",
      content: [
        ...(response.text ? [{ type: "text", text: response.text }] : []),
        ...response.toolCalls.map((tc) => ({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
      ],
    });

    const results: unknown[] = [];
    for (const call of response.toolCalls) {
      const tool = byName.get(call.toolName);
      if (!tool) {
        results.push(toolResult(call.toolCallId, call.toolName,
          `ERROR: no such tool "${call.toolName}".`));
        continue;
      }

      const input = (call.input ?? {}) as Record<string, unknown>;
      ctx.log(`${call.toolName}`, { step, tool: call.toolName, input: preview(input) });

      let outcome;
      try {
        outcome = await tool.run(input, ctx);
      } catch (err) {
        // A throwing tool must not kill the job. The agent is told and can
        // route around it, which is what a human engineer would do.
        outcome = { ok: false, output: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (outcome.meta?.path) filesTouched.add(String(outcome.meta.path));
      for (const f of (outcome.meta?.files as string[] | undefined) ?? []) filesTouched.add(f);
      if (outcome.meta?.sha) commits.push(String(outcome.meta.sha));
      if (outcome.meta?.branch) branch = String(outcome.meta.branch);
      if (outcome.meta?.prUrl) prUrl = String(outcome.meta.prUrl);

      results.push(toolResult(call.toolCallId, call.toolName, outcome.output));

      if (tool.terminal && outcome.ok !== false) {
        finished = true;
        summary = String(input.summary ?? outcome.output);
        terminalMeta = outcome.meta;
      }
    }

    messages.push({ role: "tool", content: results });
    await onCheckpoint?.({
      step, messages, summary: compacted.summary,
      branch, commits, filesTouched: [...filesTouched],
    });

    if (response.budgetExhausted && !finished) {
      stopped = "run budget exhausted";
      break;
    }
  }

  if (!finished) {
    summary ||= stopped
      ? `Stopped after ${step} step(s): ${stopped}`
      : `Reached the ${maxSteps}-step limit before finishing.`;
  }

  return {
    ok: finished,
    incomplete: !finished,
    summary,
    steps: step,
    filesTouched: [...filesTouched],
    commits,
    branch,
    ...(prUrl ? { prUrl } : {}),
    ...(terminalMeta ? { terminalMeta } : {}),
  };
}

const toolResult = (toolCallId: string, toolName: string, output: string) => ({
  type: "tool-result",
  toolCallId,
  toolName,
  output: { type: "text", value: output },
});

/** A short, loggable version of tool input. Never the whole file being written. */
function preview(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return out;
}
