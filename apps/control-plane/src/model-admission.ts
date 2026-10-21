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

type UsageReceipt={runId:string;tokens:number;status:"estimated"|"actual";evidence?:string};

/** Settlement is idempotent; a late measured response can replace a conservative estimate. */
export async function settleModelCall(handle: DbHandle, id: string, actualTokens?: number, evidence?: string) {
  if(actualTokens!==undefined&&(!Number.isSafeInteger(actualTokens)||actualTokens<0))throw new Error("invalid token usage");
  await handle.transaction(async (tx) => {
    await tx(`SELECT id FROM admission_locks WHERE id='model' FOR UPDATE`);
    const reservations=await tx<{run_id:string;tokens:number}>(`SELECT run_id,tokens FROM model_reservations WHERE id=$1 FOR UPDATE`,[id]);
    const saved=await tx<{body:UsageReceipt}>(`SELECT body FROM artifacts WHERE id=$1 FOR UPDATE`,[`model_usage_${id}`]);
    const old=saved[0]?.body;const reservation=reservations[0];
    if(old?.status==="actual"||(!old&&!reservation))return;
    const runId=old?.runId??reservation!.run_id;
    const tokens=actualTokens??old?.tokens??Number(reservation!.tokens);
    const receipt:UsageReceipt={runId,tokens,status:actualTokens===undefined?"estimated":"actual",...(evidence?{evidence}:{})};
    await tx(`UPDATE runs SET llm_tokens=llm_tokens+$2 WHERE id=$1`,[runId,tokens-(old?.tokens??0)]);
    await tx(`INSERT INTO artifacts(id,run_id,kind,body) VALUES($1,$2,'model.usage',$3)
      ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body,created_at=now()`,[`model_usage_${id}`,runId,JSON.stringify(receipt)]);
    await tx(`DELETE FROM model_reservations WHERE id=$1`,[id]);
  });
}

/** Expiry frees no budget: move unknown spend into an auditable conservative charge. */
export async function settleExpiredModelCalls(handle:DbHandle):Promise<number>{
  const rows=await handle.raw<{id:string}>(`SELECT id FROM model_reservations WHERE expires_at<now() LIMIT 100`);
  for(const row of rows)await settleModelCall(handle,row.id);
  return rows.length;
}

/** Operator-only reconciliation requires externally obtained usage evidence. */
export async function reconcileModelUsage(handle:DbHandle,id:string,tokens:number,evidence:string){
  if(!evidence.trim())throw new Error("provider usage evidence is required");
  const rows=await handle.raw(`SELECT id FROM artifacts WHERE id=$1 AND kind='model.usage'`,[`model_usage_${id}`]);
  if(!rows.length)throw new Error("settled usage receipt not found");
  await settleModelCall(handle,id,tokens,evidence);
}
