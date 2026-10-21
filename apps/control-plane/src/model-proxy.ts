import { createHash } from "node:crypto";
import { reserveModelCall, settleModelCall, ModelAdmissionError, positiveLimit } from "./model-admission.ts";
import { Hono } from "hono";
import { jsonSchema, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import type { DbHandle } from "@kapi/db";
import {
  GitHubApp, GitHubAppError, parseRepoUrl, readAppConfig, requireRepositoryAccess,
  type JobTokenClaims,
} from "@kapi/identity";
import {
  CheckpointSchema, ModelRequestSchema, WorkspaceSnapshotSchema, newId,
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
      llm_requests: number; llm_tokens: number; max_llm_requests: number;
      max_tokens: number; status: string;
    }>(
      `SELECT r.id AS run_id, r.project_id, p.owner_id,
              r.llm_requests, r.llm_tokens, r.max_llm_requests, r.max_tokens, r.status
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
      maxRequests: Number(row.max_llm_requests),
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

    // Reserve a conservative input-byte bound plus output allowance before dispatch.
    // The Codex backend does not accept an output cap: a single response may still exceed this allowance.
    const tokenAllowance = Buffer.byteLength(JSON.stringify(parsed.data)) +
      positiveLimit(process.env.KAPI_MODEL_OUTPUT_RESERVATION_TOKENS, 64_000);
    let reservation;
    try { reservation = await reserveModelCall(handle, runId, ctx.userId, tokenAllowance); }
    catch (err) {
      if (!(err instanceof ModelAdmissionError)) throw err;
      if (err.busy) c.header("Retry-After", "2");
      return c.json({ error: err.message, retryable: err.busy, budgetExhausted: !err.busy }, 429);
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
      await settleModelCall(handle, reservation.id, usage.totalTokens);

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
      await settleModelCall(handle, reservation.id);
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
  app.put("/agent/workspace-chunks/:digest/:part", async (c) => {
    const {runId,jobId}=c.get("claims");
    const digest=c.req.param("digest"); const part=Number(c.req.param("part"));
    const body=await c.req.json().catch(()=>null) as {data?:unknown}|null;
    if(!/^[a-f0-9]{64}$/.test(digest)||!Number.isInteger(part)||part<0||part>=256||
      typeof body?.data!=="string"||body.data.length>512*1024||!body.data.length||
      Buffer.from(body.data,"base64").toString("base64")!==body.data) return c.json({error:"invalid workspace chunk"},400);
    const rows=await handle.raw(`INSERT INTO artifacts(id,run_id,job_id,kind,body) VALUES($1,$2,$3,'workspace.chunk',$4)
      ON CONFLICT(id) DO UPDATE SET body=artifacts.body WHERE artifacts.body=EXCLUDED.body RETURNING id`,
      [`chunk_${jobId}_${digest}_${part}`,runId,jobId,JSON.stringify({data:body.data})]);
    return rows.length?c.json({ok:true}):c.json({error:"chunk conflict"},409);
  });

  app.put("/agent/checkpoint", async (c) => {
    const { runId, jobId } = c.get("claims");
    const parsed = CheckpointSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid checkpoint", issues: parsed.error.issues }, 400);
    }
    if (parsed.data.workspaceRef) {
      if (parsed.data.workspace) return c.json({error:"supply workspace or reference, not both"},400);
      const ref=parsed.data.workspaceRef;
      const ids=Array.from({length:ref.parts},(_,i)=>`chunk_${jobId}_${ref.digest}_${i}`);
      const chunks=await handle.raw<{id:string;body:{data:string}}>(`SELECT id,body FROM artifacts WHERE id=ANY($1) AND job_id=$2`,[ids,jobId]);
      const byId=new Map(chunks.map(row=>[row.id,row.body.data]));
      if(chunks.length!==ids.length) return c.json({error:"workspace upload incomplete"},409);
      const bytes=Buffer.from(ids.map(id=>byId.get(id)!).join(""),"base64");
      if(bytes.length!==ref.size||createHash("sha256").update(bytes).digest("hex")!==ref.digest) return c.json({error:"workspace checksum mismatch"},400);
      const workspace=WorkspaceSnapshotSchema.safeParse(await Promise.resolve().then(()=>JSON.parse(bytes.toString("utf8"))).catch(()=>null));
      if(!workspace.success) return c.json({error:"invalid workspace snapshot"},400);
      parsed.data.workspace=workspace.data;
    }
    await handle.transaction(async (tx) => {
      await tx(
        `INSERT INTO artifacts (id, run_id, job_id, kind, body)
         VALUES ($1, $2, $3, 'checkpoint', $4)
         ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, created_at=now()`,
        [`ckpt_${jobId}`, runId, jobId, JSON.stringify(parsed.data)],
      );
      if (parsed.data.workspace) await tx(
        `INSERT INTO artifacts (id,run_id,job_id,kind,body) VALUES ($1,$2,$3,'workspace.export',$4)
         ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body,created_at=now()`,
        [`workspace_${jobId}`, runId, jobId, JSON.stringify(parsed.data.workspace)],
      );
    });
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

    // Revalidate the human's current access before using the shared App identity.
    const owners = await handle.raw<{ workos_id: string }>(
      `SELECT workos_id FROM users WHERE id=$1`, [ctx.userId],
    );
    try {
      if (!owners[0]) throw new Error("owner missing");
      await requireRepositoryAccess(owners[0].workos_id, ref);
    } catch {
      return c.json({ error: "connect GitHub with write access to this repository" }, 403);
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
