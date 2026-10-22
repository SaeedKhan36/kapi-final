import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceSnapshotSchema } from "@kapi/protocol";
import type {
  AgentChildrenResponse, AgentEventInput, AgentInboxMessage, AgentSpawnResponse,
  Checkpoint, EventKind, Job, JobResult, ModelRequest, ModelResponse, SpawnRequest,
} from "@kapi/protocol";

/**
 * The agent's only link to the outside world.
 *
 * Every call dials out. A VM is not addressable inbound, so there is no server
 * here and nothing to expose - which also means the agent needs no open ports
 * and no inbound firewall story at all.
 */
export class PlaneClient {
  #queue: AgentEventInput[] = [];
  #flushing: Promise<void> | null = null;
  #revision=0;
  #uploadedDigest:string|undefined;

  constructor(
    private baseUrl: string,
    private token: string,
    private opts: { retries?: number; onLog?: (line: string) => void; signal?: AbortSignal } = {},
  ) {}

  #log(line: string) { this.opts.onLog?.(line); }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  /**
   * Retries with backoff. The plane may restart, or the network may blink,
   * while a job runs for minutes - giving up on the first failure would throw
   * away work that is otherwise fine.
   */
  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const signal = ["/agent/claim","/agent/start","/agent/heartbeat","/agent/events","/agent/complete"].includes(path) ? undefined : this.opts.signal;
    const retries = this.opts.retries ?? 4;
    let lastError = "";
    const capacityDeadline = Date.now() + 180_000;

    for (let attempt = 0; attempt <= retries; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) await delay(Math.min(8000,400*2**(attempt-1)),undefined,{signal});
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          signal: signal?AbortSignal.any([signal,AbortSignal.timeout(path==="/agent/model"?180_000:30_000)]):AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(method==="GET"&&path==="/agent/checkpoint"?{"x-kapi-chunked-workspace":"1"}:{}),
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();

        if (res.status === 429 && path === "/agent/model") {
          const detail = JSON.parse(text) as { retryable?: boolean };
          if (detail.retryable && Date.now() < capacityDeadline) {
            // Capacity contention is not a transport failure and must not burn the network retry budget.
            // Heartbeats continue while this timer waits; cancellation is checked on the next request.
            lastError = "model capacity busy";
            await delay(2000,undefined,{signal});
            attempt--;
            continue;
          }
        }
        // 4xx is our mistake or an expired token; retrying cannot fix it.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
        }
        if (!res.ok) {
          lastError = `${res.status} ${path}: ${text.slice(0, 200)}`;
          continue;
        }
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (/^4\d\d /.test(message)) throw err;
        lastError = message;
        this.#log(`request failed (attempt ${attempt + 1}/${retries + 1}): ${message}`);
      }
    }
    throw new Error(`gave up on ${path}: ${lastError}`);
  }

  claim(hostname?: string) {
    return this.#post<{ job: Job | null; reason?: string }>("/agent/claim", { hostname });
  }

  start() { return this.#post<{ ok: boolean }>("/agent/start", {}); }

  heartbeat() {
    return this.#post<{ ok: boolean; cancelled: boolean; leaseExpiresAt?: string }>("/agent/heartbeat", {});
  }

  inbox(after: number) {
    return this.#request<{ messages: AgentInboxMessage[]; cursor: number }>(
      "GET", `/agent/inbox?after=${after}`,
    );
  }

  /**
   * One model call, proxied through the plane.
   *
   * The plane holds the keys and enforces the run's budget, so the VM never
   * sees a provider credential and twenty agents cannot each spend a full
   * run's allowance. Only the raw request crosses; the loop and every tool run
   * here.
   */
  async model(req: ModelRequest): Promise<ModelResponse> {
    return this.#post<ModelResponse>("/agent/model", req);
  }

  async loadCheckpoint(): Promise<Checkpoint | null> {
    const res = await this.#request<{ checkpoint: Checkpoint | null; checkpointVersion?:number }>("GET", "/agent/checkpoint");
    if(res.checkpointVersion!==2)throw Error("control plane upgrade required for durable tool checkpoints");
    const checkpoint=res.checkpoint;
    this.#revision=Math.max(this.#revision,checkpoint?.revision??0);
    if(checkpoint?.workspaceRef&&!checkpoint.workspace){
      const ref=checkpoint.workspaceRef;const chunks:string[]=[];
      for(let part=0;part<ref.parts;part++){
        const chunk=await this.#request<{data:string}>("GET",`/agent/workspace-chunks/${ref.digest}/${part}`);
        chunks.push(chunk.data);
      }
      const bytes=Buffer.from(chunks.join(""),"base64");
      if(bytes.length!==ref.size||createHash("sha256").update(bytes).digest("hex")!==ref.digest)throw Error("workspace download checksum mismatch");
      checkpoint.workspace=WorkspaceSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
      this.#uploadedDigest=ref.digest;
    }
    return checkpoint;
  }

  async #persistCheckpoint(checkpoint:unknown){
    const ack=await this.#request<{checkpointVersion?:number}>("PUT","/agent/checkpoint",checkpoint);
    if(ack.checkpointVersion!==2)throw Error("control plane did not acknowledge durable checkpoint protocol");
    return ack;
  }

  async saveCheckpoint(checkpoint: Checkpoint) {
    checkpoint={...checkpoint,revision:++this.#revision};
    if (!checkpoint.workspace) return this.#persistCheckpoint(checkpoint);
    const bytes = Buffer.from(JSON.stringify(checkpoint.workspace));
    if (bytes.length > 64*1024*1024) throw new Error("workspace exceeds 64 MiB storage limit");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const data = bytes.toString("base64");
    const chunkSize = 512*1024;
    const parts = Math.ceil(data.length/chunkSize);
    for (let part=0;this.#uploadedDigest!==digest&&part<parts;part++) await this.#request("PUT", `/agent/workspace-chunks/${digest}/${part}`,
      { data: data.slice(part*chunkSize,(part+1)*chunkSize) });
    this.#uploadedDigest=digest;
    const { workspace: _large, ...small } = checkpoint;
    return this.#persistCheckpoint({ ...small, workspaceRef: { digest,size:bytes.length,parts } });
  }

  gitCredentials() {
    return this.#request<{
      token: string; repoUrl: string | null; baseBranch: string;
      identity: { name: string; email: string };
    }>("GET", "/agent/git-token");
  }

  /**
   * Create agents. The plane decides how many actually happen.
   *
   * A refusal comes back in `refused` rather than as a thrown error, because
   * the caller is a reasoning loop: "you may have two of the six you asked for"
   * is something it can act on, and an exception is not.
   */
  spawn(agents: SpawnRequest[], requestId: string = randomUUID()) {
    return this.#post<AgentSpawnResponse>("/agent/spawn", { agents, requestId });
  }

  children() {
    return this.#request<AgentChildrenResponse>("GET", "/agent/children");
  }

  cancelChild(jobId: string, reason?: string) {
    return this.#post<{ cancelled: string[] }>("/agent/cancel-child", { jobId, reason });
  }

  complete(result: JobResult) { return this.#post("/agent/complete", { result }); }
  failJob(error: string) { return this.#post("/agent/complete", { error }); }

  /** Buffers an event. Batched, so a chatty agent is not a chatty network. */
  emit(kind: EventKind, payload: Record<string, unknown> = {}, to?: string) {
    this.#queue.push({ kind, payload, to: to ?? null });
    if (this.#queue.length >= 25) void this.flush();
  }

  log(message: string, extra: Record<string, unknown> = {}) {
    this.emit("log", { message, ...extra });
  }

  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    if (this.#queue.length === 0) return;

    const batch = this.#queue.splice(0, 200);
    this.#flushing = (async () => {
      try {
        await this.#post("/agent/events", { events: batch });
      } catch (err) {
        // Events are telemetry. Losing a batch must never fail the job, but the
        // agent's own stderr should still show that it happened.
        this.#log(`dropped ${batch.length} event(s): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#flushing = null;
      }
    })();
    return this.#flushing;
  }
}
