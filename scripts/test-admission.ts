import { reserveModelCall, settleModelCall, ModelAdmissionError } from "../apps/control-plane/src/model-admission.ts";
import { createTestDb } from "./test-db.ts";
import { seedRun, seedSiblingRun } from "./seed.ts";
import { assert, equal, test, report } from "./harness.ts";
const db = await createTestDb("admission");
const h = db.handle;
try {
  await test("concurrent model admission cannot spend the same final token reservation", async () => {
    const s = await seedRun(h);
    await h.raw(`UPDATE runs SET max_tokens=100 WHERE id=$1`, [s.runId]);
    const outcomes = await Promise.allSettled(Array.from({length:10}, () => reserveModelCall(h,s.runId,s.userId,60)));
    equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const accepted = outcomes.find(x=>x.status==='fulfilled');
    assert(accepted?.status==='fulfilled', "one admitted");
    await settleModelCall(h, accepted.value.id, 60);
    let denied=false; try { await reserveModelCall(h,s.runId,s.userId,60); } catch(e) { denied=e instanceof ModelAdmissionError && !e.busy; }
    assert(denied,"remaining tokens cannot cover another call");
  });
  await test("user model concurrency spans runs and unknown usage remains charged", async () => {
    const s=await seedRun(h); const sibling=await seedSiblingRun(h,s); const third=await seedSiblingRun(h,s);
    const a=await reserveModelCall(h,s.runId,s.userId,50); const b=await reserveModelCall(h,sibling,s.userId,50);
    let busy=false; try { await reserveModelCall(h,third,s.userId,50); } catch(e) { busy=e instanceof ModelAdmissionError && e.busy; }
    assert(busy,"same user shares a concurrency limit");
    await settleModelCall(h,a.id); await settleModelCall(h,b.id,10);
    const rows=await h.raw<{llm_tokens:number}>(`SELECT llm_tokens FROM runs WHERE id=$1`,[s.runId]);
    equal(Number(rows[0]?.llm_tokens),50);
    const c=await reserveModelCall(h,third,s.userId,50); await settleModelCall(h,c.id,1);
  });
  await test("expired calls release concurrency but retain unaccounted budget", async () => {
    const s=await seedRun(h); await h.raw(`UPDATE runs SET max_tokens=100 WHERE id=$1`,[s.runId]);
    const a=await reserveModelCall(h,s.runId,s.userId,90);
    await h.raw(`UPDATE model_reservations SET expires_at=now()-interval '1 second' WHERE id=$1`,[a.id]);
    let denied=false;try{await reserveModelCall(h,s.runId,s.userId,20);}catch(e){denied=e instanceof ModelAdmissionError&&!e.busy;}
    assert(denied,"crash does not refund unknown provider usage");
  });
} finally { await db.close(); }
report();
