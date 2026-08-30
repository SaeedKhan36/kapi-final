import { Hono } from "hono";
import { jsonSchema, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import type { DbHandle } from "@kapi/db";
import {
  GitHubApp, GitHubAppError, parseRepoUrl, readAppConfig,
  type JobTokenClaims,
} from "@kapi/identity";
import {
  CheckpointSchema, ModelRequestSchema, newId,
  type Checkpoint, type ModelResponse,
} from "@kapi/protocol";
import { getJob } from "@kapi/queue";
import { BudgetExceededError, credentialFor, ModelRouter } from "@kapi/llm";

type Env = { Variables: { claims: JobTokenClaims } };

type RunContext = {
  runId: string; projectId: string; userId: string;
  llmRequests: number; llmTokens: number;
  maxRequests: number; maxTokens: number;
};

/**
 * Serves model calls to agents, and stores their loop state.
 *
 * Mounted under `/agent/*`, so the job-token middleware in agent-api.ts has
 * already run and `claims` is trustworthy.
 */
export function createModelProxy(deps: { handle: DbHandle }) {
  const { handle } = deps;
  const app = new Hono<Env>();
  const githubConfig = readAppConfig();
  // One client per plane process so hour-long installation tokens are reused
  // until their refresh window rather than minted for every git operation.
  const githubApp = githubConfig ? new GitHubApp(githubConfig) : null;

  /** The run, its owner, and what it has spent so far. */
  async function context(runId: string): Promise<RunContext | null> {
    const rows = await handle.raw<{
      run_id: string; project_id: string; owner_id: string;
      llm_requests: number; llm_tokens: number; max_tokens: number; status: string;
    }>(
      `SELECT r.id AS run_id, r.project_id, p.owner_id,
              r.llm_requests, r.llm_tokens, r.max_tokens, r.status
       FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [runId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      runId: row.run_id,
      projectId: row.project_id,
      userId: row.owner_id,
      llmRequests: Number(row.llm_requests),
      llmTokens: Number(row.llm_tokens),
      maxRequests: Number(process.env.KAPI_MAX_LLM_REQUESTS ?? 2000),
      maxTokens: Number(row.max_tokens),
    };
  }

  /**
   * One model call.
   *
   * Tools arrive as JSON Schema and are registered WITHOUT an execute
   * function, so the SDK returns the tool calls instead of trying to run them.
   * Running them is the VM's job - it has the filesystem, the repo, and the
   * shell; the plane has neither and should never pretend to.
   */
  app.post("/agent/model", async (c) => {
    const { runId, jobId } = c.get("claims");
    const parsed = ModelRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid model request", issues: parsed.error.issues }, 400);
    }

    const ctx = await context(runId);
    if (!ctx) return c.json({ error: "run not found" }, 404);

    const job = await getJob(handle, jobId);
    if (!job || job.status === "cancelled") {
      return c.json({ error: "job is no longer running" }, 409);
    }

    // Checked here, before the call, because the point of a budget is to not
    // make the request that crosses the line.
    if (ctx.llmRequests >= ctx.maxRequests || ctx.llmTokens >= ctx.maxTokens) {
      return c.json(
        {
          error: `run budget exhausted (${ctx.llmRequests}/${ctx.maxRequests} requests, ` +
                 `${ctx.llmTokens}/${ctx.maxTokens} tokens)`,
          budgetExhausted: true,
        },
        429,
      );
    }

    const tools: ToolSet = {};
    for (const t of parsed.data.tools) {
      tools[t.name] = tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      });
    }

    const codex = await credentialFor(handle, ctx.userId).catch(() => null);
    const router = new ModelRouter({
      budget: {
        maxRequests: Math.max(1, ctx.maxRequests - ctx.llmRequests),
        maxTokens: Math.max(1, ctx.maxTokens - ctx.llmTokens),
      },
      codexToken: codex?.accessToken,
      codexAccountId: codex?.accountId,
    });

    try {
      const result = await router.generate({
        tier: parsed.data.tier,
        system: parsed.data.system,
        messages: parsed.data.messages as ModelMessage[],
        ...(Object.keys(tools).length > 0
          ? { tools, toolChoice: parsed.data.toolChoice }
          : {}),
        temperature: parsed.data.temperature,
        maxOutputTokens: parsed.data.maxOutputTokens,
        // One step. The agent owns its loop; the plane must not silently run
        // several rounds on its behalf and bill the run for them.
        stopWhen: stepCountIs(1),
      });

      const usage = {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
      };
      await handle.raw(
        `UPDATE runs SET llm_requests = llm_requests + 1, llm_tokens = llm_tokens + $2
         WHERE id = $1`,
        [runId, usage.totalTokens],
      );

      const response: ModelResponse = {
        text: result.text ?? "",
        toolCalls: (result.toolCalls ?? []).map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        // The ai-level FinishReason is a plain string union; only the
        // provider-level LanguageModelV4FinishReason is an object.
        finishReason: String(result.finishReason ?? "unknown"),
        usage,
        provider: result.provider,
        modelId: result.modelId,
        budgetExhausted: ctx.llmRequests + 1 >= ctx.maxRequests,
      };
      return c.json(response);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return c.json({ error: err.message, budgetExhausted: true }, 429);
      }
      // Every provider failed. The agent should land on what it has rather
      // than spin, so this is a plain error it can read and act on.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /* ----------------------------------------------------------------- */
  /* Checkpoints                                                        */
  /* ----------------------------------------------------------------- */

  /**
   * Loop state lives on the plane, not the VM.
   *
   * A requeued job is picked up by a DIFFERENT VM, so anything kept on the old
   * one is gone. Storing the transcript here is what lets a resumed job
   * continue rather than start the work over and pay for it twice.
   */
  app.put("/agent/checkpoint", async (c) => {
    const { runId, jobId } = c.get("claims");
    const parsed = CheckpointSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid checkpoint", issues: parsed.error.issues }, 400);
    }
    await handle.raw(
      `INSERT INTO artifacts (id, run_id, job_id, kind, body)
       VALUES ($1, $2, $3, 'checkpoint', $4)
       ON CONFLICT (id) DO NOTHING`,
      [`ckpt_${jobId}`, runId, jobId, JSON.stringify(parsed.data)],
    );
    await handle.raw(
      `UPDATE artifacts SET body = $2, created_at = now() WHERE id = $1`,
      [`ckpt_${jobId}`, JSON.stringify(parsed.data)],
    );
    return c.json({ ok: true, step: parsed.data.step });
  });

  app.get("/agent/checkpoint", async (c) => {
    const { jobId } = c.get("claims");
    const rows = await handle.raw<{ body: Checkpoint }>(
      `SELECT body FROM artifacts WHERE id = $1`, [`ckpt_${jobId}`],
    );
    return c.json({ checkpoint: rows[0]?.body ?? null });
  });

  /* ----------------------------------------------------------------- */
  /* Git credentials                                                    */
  /* ----------------------------------------------------------------- */

  /**
   * A push credential, handed over only when the agent is about to push.
   *
   * Not injected at provision time: a token in the VM's environment from the
   * first second is a token in every `env` dump and every crash log for the
   * whole life of the job.
   */
  app.get("/agent/git-token", async (c) => {
    const { runId } = c.get("claims");
    const ctx = await context(runId);
    if (!ctx) return c.json({ error: "run not found" }, 404);

    const rows = await handle.raw<{ repo_url: string; default_branch: string }>(
      `SELECT repo_url, default_branch FROM projects WHERE id = $1`, [ctx.projectId],
    );
    const project = rows[0];
    if (!project) return c.json({ error: "project not found" }, 404);

    const ref = parseRepoUrl(project.repo_url);
    if (!ref) {
      return c.json(
        { error: "the project repository is not hosted on GitHub, so no GitHub App token can be issued" },
        400,
      );
    }

    if (!githubApp) {
      return c.json(
        { error: "the GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)" },
        404,
      );
    }

    let token: string;
    try {
      token = await githubApp.tokenFor(ref);
    } catch (err) {
      if (err instanceof GitHubAppError) {
        return c.json(
          { error: err.message, ...(err.installUrl ? { installUrl: err.installUrl } : {}) },
          err.installUrl ? 409 : 502,
        );
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    return c.json({
      token,
      repoUrl: project.repo_url,
      baseBranch: project.default_branch ?? "main",
      identity: {
        name: process.env.GIT_AUTHOR_NAME ?? "kapi-agent",
        email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
      },
    });
  });

  return app;
}

export const checkpointId = (jobId: string) => `ckpt_${jobId}`;
export const newArtifactId = () => newId("art");
