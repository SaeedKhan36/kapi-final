import type { DbHandle } from "@kapi/db";
import { newId } from "@kapi/protocol";

export class ModelAdmissionError extends Error {
  constructor(message: string, readonly busy: boolean) { super(message); }
}
export function positiveLimit(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("capacity limits must be positive integers");
  return n;
}

/** Shared SQL admission works across API replicas; crashed calls keep their token reservation. */
export async function reserveModelCall(handle: DbHandle, runId: string, userId: string, tokens: number) {
  const runLimit = positiveLimit(process.env.KAPI_MODEL_CONCURRENCY_PER_RUN, 1);
  const userLimit = positiveLimit(process.env.KAPI_MODEL_CONCURRENCY_PER_USER, 2);
  const ttl = Math.max(positiveLimit(process.env.KAPI_MODEL_CALL_TIMEOUT_MS, 120_000) + 60_000, 180_000);
  return handle.transaction(async (tx) => {
    await tx(`SELECT id FROM admission_locks WHERE id='model' FOR UPDATE`);
    const runs = await tx<{ llm_tokens: number; max_tokens: number; llm_requests: number; max_llm_requests: number; status: string }>(
      `SELECT llm_tokens,max_tokens,llm_requests,max_llm_requests,status FROM runs WHERE id=$1 FOR UPDATE`, [runId]);
    const run = runs[0];
    if (!run || ["completed", "cancelled", "failed"].includes(run.status)) throw new ModelAdmissionError("run is no longer active", false);
    const counts = await tx<{ run_active: number; user_active: number; held: number }>(
      `SELECT count(*) FILTER(WHERE run_id=$1 AND expires_at>now())::int AS run_active,
       count(*) FILTER(WHERE user_id=$2 AND expires_at>now())::int AS user_active,
       COALESCE(sum(tokens) FILTER(WHERE run_id=$1),0)::int AS held FROM model_reservations`, [runId,userId]);
    const c = counts[0]!;
    if (Number(c.run_active) >= runLimit || Number(c.user_active) >= userLimit) throw new ModelAdmissionError("model capacity busy; retry shortly", true);
    if (Number(run.llm_requests) >= Number(run.max_llm_requests) || Number(run.llm_tokens) + Number(c.held) + tokens > Number(run.max_tokens)) {
      throw new ModelAdmissionError("insufficient unreserved model budget", false);
    }
    const id = newId("call");
    await tx(`INSERT INTO model_reservations(id,run_id,user_id,tokens,expires_at) VALUES($1,$2,$3,$4,$5)`,
      [id,runId,userId,tokens,new Date(Date.now()+ttl).toISOString()]);
    await tx(`UPDATE runs SET llm_requests=llm_requests+1 WHERE id=$1`, [runId]);
    return { id, tokens };
  });
}

/** Unknown provider usage is conservatively charged at the reserved amount. */
export async function settleModelCall(handle: DbHandle, id: string, actualTokens?: number) {
  await handle.transaction(async (tx) => {
    const rows = await tx<{run_id:string;tokens:number}>(`DELETE FROM model_reservations WHERE id=$1 RETURNING run_id,tokens`, [id]);
    if (!rows[0]) return;
    await tx(`UPDATE runs SET llm_tokens=llm_tokens+$2 WHERE id=$1`,
      [rows[0].run_id,actualTokens ?? Number(rows[0].tokens)]);
  });
}
