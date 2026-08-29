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

  constructor(
    private baseUrl: string,
    private token: string,
    private opts: { retries?: number; onLog?: (line: string) => void } = {},
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
    const retries = this.opts.retries ?? 4;
    let lastError = "";

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** (attempt - 1))));
      }
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();

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
    return this.#post<{ ok: boolean; cancelled: boolean }>("/agent/heartbeat", {});
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
    const res = await this.#request<{ checkpoint: Checkpoint | null }>("GET", "/agent/checkpoint");
    return res.checkpoint;
  }

  saveCheckpoint(checkpoint: Checkpoint) {
    return this.#request("PUT", "/agent/checkpoint", checkpoint);
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
  spawn(agents: SpawnRequest[]) {
    return this.#post<AgentSpawnResponse>("/agent/spawn", { agents });
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
