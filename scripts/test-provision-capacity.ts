import { Provisioner } from "../apps/control-plane/src/provisioner.ts";
import { createTestDb } from "./test-db.ts";
import { seedRun, seedSiblingRun } from "./seed.ts";
import { enqueue } from "@kapi/queue";
import { newId } from "@kapi/protocol";
import type { VmProvider } from "@kapi/vm";
import { test, assert, equal, sleep, report } from "./harness.ts";
process.env.KAPI_SECRET_KEY=Buffer.alloc(32,7).toString("base64");
process.env.KAPI_MAX_ACTIVE_VMS="3";
process.env.KAPI_MAX_ACTIVE_VMS_PER_USER="2";
process.env.KAPI_PROVISION_CONCURRENCY="2";
const db=await createTestDb("provision_capacity"); const h=db.handle;
let active=0, peak=0; const order:string[]=[];
const provider = { name:"fake", create:async (spec:any)=>{
  active++;peak=Math.max(peak,active);order.push(spec.metadata.runId);await sleep(15);active--;
  return {id:newId("resource"),workdir:"/workspace",provider:"fake",createdAt:Date.now()};
},writeFile:async()=>{},spawnDetached:async()=>{},destroy:async()=>{},destroyOrphan:async()=>false } as unknown as VmProvider;
const make=(runId:string)=>enqueue(h,{runId,kind:"build",role:"backend",instruction:"capacity test",acceptance:[],touches:[],context:{},dependsOn:[],priority:0,maxAttempts:3});
try {
  await test("fair selection and bounded parallel provisioning respect global and owner capacity",async()=>{
    const a=await seedRun(h);const b=await seedRun(h);
    for(let i=0;i<6;i++)await make(a.runId);
    for(let i=0;i<6;i++)await make(b.runId);
    const p=new Provisioner(h,{provider,publicUrl:"http://localhost:8787",onLog:()=>{}});
    await p.tick();
    equal(order.length,3,"global resource cap");
    assert(order[0]!==order[1],"first round serves different users");
    assert(peak<=2 && peak>1,"provisioning has bounded parallelism");
    for(const run of [a.runId,b.runId])assert(order.filter(x=>x===run).length<=2,"owner cap");
    // Retained failed-cleanup resources still occupy deployment capacity.
    await h.raw(`UPDATE agents SET stopped_at=now(),cleanup_error='test failure'`);
    const extra=await make(await seedSiblingRun(h,a));
    let refused=false;try{await p.provision(extra);}catch{refused=true;}assert(refused,"cleanup failure cannot free physical capacity");
    await h.raw(`DELETE FROM agents`);await h.raw(`DELETE FROM jobs`);
  });
  await test("two workers cannot jointly exceed shared deployment or user caps",async()=>{
    const a=await seedRun(h);const b=await seedRun(h);const jobs=[];
    for(let i=0;i<10;i++)jobs.push(await make(i%2?a.runId:b.runId));
    const p=new Provisioner(h,{provider,publicUrl:"http://localhost:8787",onLog:()=>{}});
    const q=new Provisioner(h,{provider,publicUrl:"http://localhost:8787",onLog:()=>{}});
    const results=await Promise.allSettled(jobs.map((job,i)=>(i%2?p:q).provision(job)));
    equal(results.filter(x=>x.status==="fulfilled").length,3);
    const counts=await h.raw<{n:number}>(`SELECT count(*)::int AS n FROM agents GROUP BY run_id`);
    assert(counts.every(x=>Number(x.n)<=2),"owner cap survives worker overlap");
  });
}finally{await db.close();}
report();
