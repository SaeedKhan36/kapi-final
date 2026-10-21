/** Live model + GitHub smoke check using local agents. Creates a documentation PR; never merges it. */
import { writeFile } from "node:fs/promises";
import { evaluateLifecycle, type LifecycleEvidence, type LifecycleThread } from "./staging-evidence.ts";
const base=(process.env.KAPI_LOCAL_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/$/,"");
if(!["localhost","127.0.0.1","[::1]"].includes(new URL(base).hostname))throw new Error("local smoke URL must be loopback; use release:staging for production");
const projectId=process.env.KAPI_LOCAL_PROJECT_ID;
if(!projectId)throw new Error("set KAPI_LOCAL_PROJECT_ID to the explicitly authorized repository's project");
async function request<T>(method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(base+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return await response.json() as T;
}
let runId:string|null=null;let terminal=false;
try{
  const setup=await request<{codex:{connected:boolean};vault:{configured:boolean};vm:{provider:string}}>("GET","/api/setup");
  if(!setup.codex.connected)throw new Error("connect the local Kapi user to Codex in Setup first");
  if(!setup.vault.configured||setup.vm.provider!=="local")throw new Error("start the local API with operations enabled and vault configured");
  const integration=await request<{github:{installed:boolean}}>("GET",`/api/projects/${encodeURIComponent(projectId)}/integrations`);
  if(!integration.github.installed)throw new Error("install the GitHub App on the authorized repository first");
  const thread=await request<{id:string}>("POST",`/api/projects/${encodeURIComponent(projectId)}/threads`,{title:"Live reliability verification"});
  const goal=process.env.KAPI_LOCAL_SMOKE_GOAL ??
    "Run a small live engineering-fleet smoke test. Delegate to a Build agent: add docs/kapi-live-smoke.md describing that Captain delegates implementation and independent review, agents communicate through the control plane, and PR merging is human-controlled. Run git diff --check, commit, push and open a pull request. Then delegate an independent Review agent against that exact Build branch, inspect the diff and return a structured verdict. Wait for the Review result before finishing. Report the PR URL and verdict. Do not merge, change application code, or spawn more than one Build and one Review unless a blocker requires a fix.";
  const started=await request<{run:{id:string}}>("POST",`/api/threads/${thread.id}/messages`,{content:goal,
    budgets:{maxConcurrentVms:3,maxTotalSpawns:5,maxSpawnDepth:2,maxLlmRequests:60,maxTokens:2_000_000,maxVmSeconds:3600}});
  runId=started.run.id;console.log(`Live run: ${runId}`);
  const deadline=Date.now()+20*60_000;let detail:LifecycleEvidence;
  for(;;){
    detail=await request<LifecycleEvidence>("GET",`/api/runs/${runId}`);
    console.log(`${detail.run.status}: ${detail.jobs.length} jobs`);
    if(["completed","failed","cancelled"].includes(detail.run.status)){terminal=true;break;}
    if(Date.now()>deadline)throw new Error("live local lifecycle timed out");
    await new Promise(resolve=>setTimeout(resolve,10_000));
  }
  // Read every event page, rather than treating the first 1,000 events as the complete record.
  const events:LifecycleEvidence["events"]=[];let after=0;
  for(;;){const page=await request<Array<{kind:string;seq:number}>>("GET",`/api/runs/${runId}/events?after=${after}`);
    events.push(...page);if(page.length<1000)break;after=page.at(-1)!.seq;}
  detail.events=events;
  const threadDetail=await request<LifecycleThread>("GET",`/api/threads/${thread.id}`);
  const evidence=evaluateLifecycle(detail,threadDetail);
  const requireCi=process.env.KAPI_LOCAL_REQUIRE_CI==="true";
  const checks=evidence.checks.filter(c=>requireCi||c.name!=="GitHub CI returned through the webhook");
  const result={timestamp:new Date().toISOString(),runId,liveModel:true,localProvider:true,requireCi,checks,
    ciWebhookObserved:events.some(e=>e.kind==="ci.completed"),pullRequests:detail.jobs.flatMap(j=>j.result?.prUrl?[j.result.prUrl]:[])};
  console.log(JSON.stringify(result,null,2));
  if(process.env.KAPI_LOCAL_SMOKE_OUTPUT)await writeFile(process.env.KAPI_LOCAL_SMOKE_OUTPUT,JSON.stringify(result,null,2)+"\n");
  if(!checks.every(c=>c.ok))throw new Error("live local lifecycle did not meet its evidence gates");
}finally{if(runId&&!terminal)await request("POST",`/api/runs/${runId}/cancel`).catch(()=>{});}
