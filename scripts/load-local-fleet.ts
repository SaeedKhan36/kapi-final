/** Synthetic orchestration load: real API, SQL queue and local agent processes; no model or GitHub calls. */
import { once } from "node:events";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { Authenticator } from "@kapi/identity";
import { enqueue } from "@kapi/queue";
import { LocalProvider, type VmSpec, type Vm } from "@kapi/vm";
import { attachWebSocket } from "../apps/control-plane/src/ws.ts";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { VmReconciler } from "../apps/control-plane/src/reconciler.ts";
import { Provisioner } from "../apps/control-plane/src/provisioner.ts";
import { RequestTracker } from "../apps/control-plane/src/request-tracker.ts";
import { seedRun, seedSiblingRun } from "./seed.ts";
import { createTestDb, useHermeticTestConfig } from "./test-db.ts";

useHermeticTestConfig();
const users=Number(process.env.KAPI_LOAD_USERS ?? 10);
const rounds=Number(process.env.KAPI_LOAD_ROUNDS??1);
const runsPerUser=Number(process.env.KAPI_LOAD_RUNS_PER_USER ?? 3)*rounds;
const delayMs=Number(process.env.KAPI_LOAD_DELAY_MS??0);
const chaos=process.env.KAPI_LOAD_CHAOS==="true";
const timeoutSeconds=Number(process.env.KAPI_LOAD_TIMEOUT_SECONDS??180);
if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>86400)throw Error("invalid load timeout");
if(!Number.isInteger(rounds)||rounds<1||!Number.isFinite(delayMs)||delayMs<0||delayMs>5000)throw Error("invalid soak profile");
process.env.KAPI_RATE_LIMIT_PER_MINUTE="10000";
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
let loadStarted=0;let injectedApiFailures=0;
const server=serve({fetch:request=>{
  const elapsed=performance.now()-loadStarted;
  if(chaos&&loadStarted&&elapsed>=400&&elapsed<=1200){injectedApiFailures++;return new Response("injected replica outage",{status:503});}
  return app.fetch(request);
},port:0,hostname:"127.0.0.1"});
if (!server.listening) await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const owners=new Set<string>();const sockets:WebSocket[]=[];const streamLatencies:number[]=[];
const wss=attachWebSocket(server,hub,{store,auth:{mode:"dev",authenticate:async()=>{
  const userId=owners.values().next().value!;if(!userId)throw Error("unknown fixture user");return{userId,workosId:userId};
}} as unknown as Authenticator});
let peakHeap=0;let peakCachedRuns=0;
let creations=0;let ambiguousCreations=0;
class FaultProvider extends LocalProvider { override async create(spec:VmSpec):Promise<Vm>{
  const resource=await super.create(spec);
  if(chaos&&++creations%19===0){ambiguousCreations++;throw Error("injected lost creation response");}
  return resource;
}}
const provider=new FaultProvider();const reconciler=new VmReconciler(h,provider);
const provisioner=new Provisioner(h,{provider,publicUrl:base,onLog:()=>{}});
const runIds:string[]=[];const latencies:number[]=[];let peak=0;
try{
  for(let i=0;i<users;i++){
    const s=await seedRun(h);owners.add(s.userId);
    for(let j=0;j<runsPerUser;j++){
      const runId=j===0?s.runId:await seedSiblingRun(h,s);runIds.push(runId);
      await enqueue(h,{runId,kind:"captain",role:"captain",instruction:"synthetic lifecycle load",
        acceptance:[],touches:[],context:{testDelayMs:delayMs*(1+j%3),testFailFirst:chaos&&j%4===0},dependsOn:[],priority:0,maxAttempts:chaos?3:1});
      if(i===0){
        const socket=new WebSocket(`${base.replace("http","ws")}/ws?runId=${runId}`);
        sockets.push(socket);let replayed=false;
        socket.addEventListener("message",event=>{const frame=JSON.parse(String(event.data));if(frame.kind==="replayed")replayed=true;
          if(replayed&&frame.kind==="event")streamLatencies.push(Math.max(0,Date.now()-new Date(frame.event.ts).getTime()));});
        await new Promise<void>((resolve,reject)=>{socket.addEventListener("open",()=>resolve(),{once:true});socket.addEventListener("error",()=>reject(new Error("fixture websocket failed")),{once:true});});
      }
    }
  }
  const started=performance.now();loadStarted=started;const deadline=Date.now()+timeoutSeconds*1000;
  let done=0;
  while(done<runIds.length){
    if(Date.now()>deadline)throw new Error(`load timed out: ${done}/${runIds.length} jobs`);
    if(chaos)await reconciler.reconcile();
    await provisioner.tick();
    const sample=await h.raw<{done:number;failed:number;physical:number}>(`SELECT
      (SELECT count(*)::int FROM jobs WHERE run_id=ANY($1) AND status='succeeded') done,
      (SELECT count(*)::int FROM jobs WHERE run_id=ANY($1) AND status IN ('failed','cancelled')) failed,
      (SELECT count(*)::int FROM agents WHERE vm_id IS NOT NULL AND provider='local') physical`,[runIds]);
    done=Number(sample[0]!.done);peak=Math.max(peak,Number(sample[0]!.physical));
    peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);peakCachedRuns=Math.max(peakCachedRuns,hub.cachedRunCount);
    if(Number(sample[0]!.failed))throw new Error("synthetic jobs failed");
    const before=performance.now();const health=await fetch(`${base}/api/health`);
    if(!health.ok&&!(chaos&&health.status===503))throw new Error(`health returned ${health.status}`);
    await health.arrayBuffer();if(health.ok)latencies.push(performance.now()-before);
    const ownership=await h.raw<{n:number}>(`SELECT count(*)::int AS n FROM agents a JOIN runs r ON r.id=a.run_id JOIN projects p ON p.id=r.project_id WHERE a.vm_id IS NOT NULL GROUP BY p.owner_id`);
    if(ownership.some(row=>Number(row.n)>Number(process.env.KAPI_MAX_ACTIVE_VMS_PER_USER)))throw Error("user capacity exceeded");
    await new Promise(r=>setTimeout(r,50));
  }
  const elapsed=(performance.now()-started)/1000;
  await provisioner.reclaim();
  const managed=await provider.listManaged();if(managed.length)throw new Error(`${managed.length} resources leaked`);
  const attempts=await h.raw<{retries:number}>(`SELECT COALESCE(sum(attempts-1),0)::int AS retries FROM jobs WHERE run_id=ANY($1)`,[runIds]);
  const delays=await h.raw<{ms:number}>(`SELECT EXTRACT(EPOCH FROM (started_at-created_at))*1000 AS ms FROM jobs WHERE run_id=ANY($1)`,[runIds]);
  const percentile=(values:number[],p:number)=>values.sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??0;
  const evidence={timestamp:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch,logicalCpus:cpus().length,memoryGiB:totalmem()/1024**3},workload:"synthetic echo agents; no AI, GitHub, or Daytona",database:h.embedded?"PGlite":"PostgreSQL",
    users,runsPerUser,rounds,delayMs,chaos,injectedApiFailures,ambiguousCreations,workerRetries:Number(attempts[0]?.retries??0),completed:done,elapsedSeconds:elapsed,jobsPerSecond:done/elapsed,peakAllocatedResources:peak,
    limits:{global:Number(process.env.KAPI_MAX_ACTIVE_VMS),perUser:Number(process.env.KAPI_MAX_ACTIVE_VMS_PER_USER)},
    peakControlPlaneHeapMiB:peakHeap/1024**2,peakCachedRuns,websocketSamples:streamLatencies.length,eventToSocketP95Ms:percentile(streamLatencies,.95),
    queueDelayP95Ms:percentile(delays.map(x=>Number(x.ms)),.95),healthLatencyP95Ms:percentile(latencies,.95),resourcesRemaining:managed.length};
  if(!streamLatencies.length)throw new Error("no live websocket evidence");
  if(peak>evidence.limits.global)throw new Error("global capacity exceeded");
  console.log(JSON.stringify(evidence,null,2));
  if(process.env.KAPI_LOAD_OUTPUT)await writeFile(process.env.KAPI_LOAD_OUTPUT,JSON.stringify(evidence,null,2)+"\n");
}finally{
  for(const socket of sockets)socket.close();for(const socket of wss.clients)socket.terminate();wss.close();
  await provisioner.destroyAll();await hub.close();await requests.drain();
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await db.close();await rm(state,{recursive:true,force:true});
}
