import { hostname } from "node:os";
import { AGENT_ENV } from "@kapi/protocol";
import { PlaneClient } from "./client.ts";
import { handlerFor } from "./roles.ts";

/**
 * The agent. One process, one job, one VM.
 *
 * It is deliberately small: claim, heartbeat, do the work, report, exit. All of
 * the intelligence lands in the role handlers, and all of the durability lives
 * in the queue on the other end of the wire - if this process dies, the lease
 * expires and the job goes back to be picked up by someone else.
 */

const env = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const say = (line: string) => console.log(`[agent] ${line}`);

const baseUrl = env(AGENT_ENV.url);
const token = env(AGENT_ENV.token);
const jobId = env(AGENT_ENV.jobId);
const workdir = env(AGENT_ENV.workdir) ?? process.cwd();

if (!baseUrl || !token || !jobId) {
  console.error(
    `[agent] missing bootstrap environment.\n` +
    `  need ${AGENT_ENV.url}, ${AGENT_ENV.token}, ${AGENT_ENV.jobId}`,
  );
  process.exit(2);
}

const client = new PlaneClient(baseUrl, token, { onLog: say });

/** Heartbeat well inside the lease so ordinary latency is not read as death. */
const HEARTBEAT_MS = Number(env("KAPI_HEARTBEAT_MS") ?? 15_000);

let leaseLost = false;
let cancelled = false;
const alive = () => !leaseLost && !cancelled;

async function main() {
  say(`claiming ${jobId} at ${baseUrl}`);
  const { job, reason } = await client.claim(hostname());

  if (!job) {
    // Someone else has it, or it was cancelled. Exiting quietly is correct:
    // retrying would be a hot loop against a job that is not ours.
    say(`nothing to do (${reason ?? "job unavailable"})`);
    return 0;
  }

  say(`claimed ${job.kind}/${job.role} - ${job.payload.instruction.slice(0, 80)}`);
  await client.start();

  const beat = setInterval(async () => {
    try {
      const { ok, cancelled: isCancelled } = await client.heartbeat();
      if (!ok) {
        // The reaper handed this job to another VM. Two agents doing the same
        // work would push the same branch twice, so this one stops.
        leaseLost = true;
        say("lease lost - another VM owns this job now, stopping");
      }
      if (isCancelled) {
        cancelled = true;
        say("job was cancelled, stopping");
      }
    } catch (err) {
      say(`heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
    }
    void client.flush();
  }, HEARTBEAT_MS);
  beat.unref?.();

  try {
    const result = await handlerFor(job.kind)({ job, client, workdir, alive });
    await client.flush();

    if (!alive()) {
      // Reporting a result we no longer hold the lease for would either be
      // rejected or, worse, overwrite the replacement's work.
      say("finished but no longer the lease holder - discarding the result");
      return 1;
    }

    // `result.ok` is the agent's own verdict, and it has to route to a
    // different queue call: `complete()` always marks the job succeeded, with
    // no retry, while `fail()` requeues up to the job's attempt budget before
    // dead-lettering. A build agent cut off mid-loop, or a captain whose
    // model call failed before it could delegate anything, is a FAILURE - and
    // reporting it through `complete()` would both discard the retry the job
    // is entitled to AND let a `dependsOn` gate release a downstream job
    // against work that never actually finished.
    if (result.ok) {
      await client.complete(result);
      say(`completed: ${result.summary.slice(0, 120)}`);
    } else {
      await client.failJob(result.summary.slice(0, 4000) || "the agent did not report success");
      say(`did not finish: ${result.summary.slice(0, 120)}`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    say(`failed: ${message}`);
    client.log(`agent failed: ${message}`);
    await client.flush();
    if (alive()) await client.failJob(message.slice(0, 4000)).catch(() => {});
    return 1;
  } finally {
    clearInterval(beat);
    await client.flush();
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(`[agent] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    // No exit(0) here: a non-zero exit plus an expired lease is how the plane
    // learns this VM is not coming back.
    process.exit(1);
  });
