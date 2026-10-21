/** Synthetic orchestration load: real API, SQL queue and local agent processes; no model or GitHub calls. */
import { once } from "node:events";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { Authenticator } from "@kapi/identity";
import { enqueue } from "@kapi/queue";
import { LocalProvider } from "@kapi/vm";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { Provisioner } from "../apps/control-plane/src/provisioner.ts";
import { RequestTracker } from "../apps/control-plane/src/request-tracker.ts";
import { seedRun, seedSiblingRun } from "./seed.ts";
import { createTestDb, useHermeticTestConfig } from "./test-db.ts";

useHermeticTestConfig();
const users=Number(process.env.KAPI_LOAD_USERS ?? 10);
const runsPerUser=Number(process.env.KAPI_LOAD_RUNS_PER_USER ?? 3);
if (![users,runsPerUser].every(n=>Number.isInteger(n)&&n>0&&n<=100)) throw new Error("load dimensions must be 1..100");
process.env.KAPI_SECRET_KEY=Buffer.alloc(32,7).toString("base64");
process.env.KAPI_TEST_ECHO_ROLE="true";
process.env.KAPI_MAX_ACTIVE_VMS ??= "8";
process.env.KAPI_MAX_ACTIVE_VMS_PER_USER ??= "2";
const state=await mkdtemp(join(tmpdir(),"kapi-load-state-"));
process.env.KAPI_LOCAL_STATE_DIR=state;
const db=await createTestDb("fleet_load");const h=db.handle;const store=new Store(h);
const hub=new EventHub(store,h);const requests=new RequestTracker();
const app=createApp({handle:h,store,hub,auth:new Authenticator(h),requests,vmProvider:"local"});
const server=serve({fetch:app.fetch,port:0,hostname:"127.0.0.1"});
if (!server.listening) await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const provider=new LocalProvider();const provisioner=new Provisioner(h,{provider,publicUrl:base,onLog:()=>{}});
const runIds:string[]=[];const latencies:number[]=[];let peak=0;
try{
  for(let i=0;i<users;i++){
    const s=await seedRun(h);
    for(let j=0;j<runsPerUser;j++){
      const runId=j===0?s.runId:await seedSiblingRun(h,s);runIds.push(runId);
      await enqueue(h,{runId,kind:"captain",role:"captain",instruction:"synthetic lifecycle load",
        acceptance:[],touches:[],context:{},dependsOn:[],priority:0,maxAttempts:1});
    }
  }
  const started=performance.now();const deadline=Date.now()+120_000;
  let done=0;
  while(done<runIds.length){
    if(Date.now()>deadline)throw new Error(`load timed out: ${done}/${runIds.length} jobs`);
    await provisioner.tick();
    const sample=await h.raw<{done:number;failed:number;physical:number}>(`SELECT
      (SELECT count(*)::int FROM jobs WHERE run_id=ANY($1) AND status='succeeded') done,
      (SELECT count(*)::int FROM jobs WHERE run_id=ANY($1) AND status IN ('failed','cancelled')) failed,
      (SELECT count(*)::int FROM agents WHERE vm_id IS NOT NULL AND provider='local') physical`,[runIds]);
    done=Number(sample[0]!.done);peak=Math.max(peak,Number(sample[0]!.physical));
    if(Number(sample[0]!.failed))throw new Error("synthetic jobs failed");
    const before=performance.now();const health=await fetch(`${base}/api/health`);
    if(!health.ok)throw new Error(`health returned ${health.status}`);await health.arrayBuffer();latencies.push(performance.now()-before);
    await new Promise(r=>setTimeout(r,50));
  }
  const elapsed=(performance.now()-started)/1000;
  await provisioner.reclaim();
  const managed=await provider.listManaged();if(managed.length)throw new Error(`${managed.length} resources leaked`);
  const delays=await h.raw<{ms:number}>(`SELECT EXTRACT(EPOCH FROM (started_at-created_at))*1000 AS ms FROM jobs WHERE run_id=ANY($1)`,[runIds]);
  const percentile=(values:number[],p:number)=>values.sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??0;
  const evidence={timestamp:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch,logicalCpus:cpus().length,memoryGiB:totalmem()/1024**3},workload:"synthetic echo agents; no AI, GitHub, or Daytona",database:h.embedded?"PGlite":"PostgreSQL",
    users,runsPerUser,completed:done,elapsedSeconds:elapsed,jobsPerSecond:done/elapsed,peakAllocatedResources:peak,
    limits:{global:Number(process.env.KAPI_MAX_ACTIVE_VMS),perUser:Number(process.env.KAPI_MAX_ACTIVE_VMS_PER_USER)},
    queueDelayP95Ms:percentile(delays.map(x=>Number(x.ms)),.95),healthLatencyP95Ms:percentile(latencies,.95),resourcesRemaining:managed.length};
  if(peak>evidence.limits.global)throw new Error("global capacity exceeded");
  console.log(JSON.stringify(evidence,null,2));
  if(process.env.KAPI_LOAD_OUTPUT)await writeFile(process.env.KAPI_LOAD_OUTPUT,JSON.stringify(evidence,null,2)+"\n");
}finally{
  await provisioner.destroyAll();await hub.close();await requests.drain();
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await db.close();await rm(state,{recursive:true,force:true});
}
