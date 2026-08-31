import type { DbHandle, SqlRunner } from "@kapi/db";
import { newId } from "@kapi/protocol";

export type AccountingResult = { agents: number; vmSeconds: number; usdMicros: number };

/** Idempotently advances each agent's metering cursor and the run aggregates. */
export class UsageAccounting {
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(
    private handle: DbHandle,
    private intervalMs = Number(process.env.KAPI_ACCOUNTING_INTERVAL_MS ?? 10_000),
  ) {}

  start(): () => void {
    this.#timer = setInterval(() => void this.settle().catch((err) => {
      console.error("[accounting] settlement failed", err);
    }), this.intervalMs);
    this.#timer.unref?.();
    return () => this.stop();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  async settle(now = new Date(), limit = 200): Promise<AccountingResult> {
    if (this.#busy) return { agents: 0, vmSeconds: 0, usdMicros: 0 };
    this.#busy = true;
    const total = { agents: 0, vmSeconds: 0, usdMicros: 0 };
    try {
      for (let i = 0; i < limit; i++) {
        const one = await this.handle.transaction((tx) => this.#settleOne(tx, now));
        if (!one) break;
        total.agents++; total.vmSeconds += one.seconds; total.usdMicros += one.usdMicros;
      }
      return total;
    } finally { this.#busy = false; }
  }

  async #settleOne(tx: SqlRunner, now: Date): Promise<{ seconds: number; usdMicros: number } | null> {
    const rows = await tx<{
      job_id: string; run_id: string; provider: string; accounted_through: Date;
      stopped_at: Date | null;
    }>(
      `SELECT job_id, run_id, provider, accounted_through, stopped_at FROM agents
       WHERE provider IS NOT NULL AND accounted_through IS NOT NULL
         AND accounted_through + interval '1 second' <= LEAST(COALESCE(stopped_at, $1), $1)
       ORDER BY accounted_through ASC FOR UPDATE SKIP LOCKED LIMIT 1`, [now.toISOString()],
    );
    const row = rows[0];
    if (!row) return null;
    const start = new Date(row.accounted_through);
    const cap = row.stopped_at ? new Date(Math.min(+new Date(row.stopped_at), +now)) : now;
    const seconds = Math.floor((+cap - +start) / 1000);
    if (seconds <= 0) return null;
    const end = new Date(+start + seconds * 1000);
    const rate = providerRate(row.provider);
    const known = rate !== null;
    const usdMicros = known ? Math.round(rate * 10_000 * seconds / 3_600) : 0;

    await tx(
      `INSERT INTO usage_ledger
        (id,run_id,job_id,provider,kind,quantity,usd_micros,cost_status,period_start,period_end)
       VALUES ($1,$2,$3,$4,'vm_seconds',$5,$6,$7,$8,$9)
       ON CONFLICT (job_id,kind,period_end) DO NOTHING`,
      [newId("use"), row.run_id, row.job_id, row.provider, seconds, usdMicros,
        known ? "known" : "unavailable", start.toISOString(), end.toISOString()],
    );
    await tx(`UPDATE agents SET accounted_through=$2 WHERE job_id=$1`, [row.job_id, end.toISOString()]);
    await tx(
      `UPDATE runs SET vm_seconds=vm_seconds+$2, usd_micros=usd_micros+$3,
        usd_cents=((usd_micros+$3)/10000)::int,
        cost_status=CASE
          WHEN $4::boolean AND cost_status='unavailable' AND vm_seconds=0 THEN 'known'
          WHEN $4::boolean AND cost_status='known' THEN 'known'
          WHEN NOT $4::boolean AND cost_status='unavailable' THEN 'unavailable'
          ELSE 'partial' END
       WHERE id=$1`, [row.run_id, seconds, usdMicros, known],
    );
    return { seconds, usdMicros };
  }
}

/** Explicit operator rates are authoritative; absent rates never become fake dollars. */
export function providerRate(provider: string): number | null {
  const key = `KAPI_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CENTS_PER_HOUR`;
  const raw = process.env[key];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
