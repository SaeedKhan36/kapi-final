/** Actual role/tool code and Git, with deterministic model decisions and a local remote. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captainRole, buildRole, reviewRole } from "../apps/agent/src/roles.ts";
import { restoreWorkspace } from "@kapi/agent-core";
import { JobSpecSchema, type Checkpoint, type Job, type AgentChild } from "@kapi/protocol";
import type { PlaneClient } from "../apps/agent/src/client.ts";
import { test, assert, equal, report } from "./harness.ts";
const exec=promisify(execFile);
const root=await mkdtemp(join(tmpdir(),"kapi-lifecycle-"));const remote=join(root,"remote");
async function git(cwd:string,...args:string[]){return(await exec("git",args,{cwd})).stdout;}
const checkpoints=new Map<string,Checkpoint>();const children:AgentChild[]=[];
const decisions:Record<string,Array<[string,Record<string,unknown>]>>={
  captain:[
    ["spawn_agents",{agents:[{kind:"build",role:"backend",instruction:"Add a tested sum function"}]}],
    ["spawn_agents",{agents:[{kind:"review",role:"review",instruction:"Review sum",context:{branch:"kapi/job_build"}}]}],
    ["finish",{summary:"Build and independent review completed"}],
  ],
  build:[
    ["write_file",{path:"sum.mjs",content:"export const sum = (a, b) => a + b;\n"}],
    ["write_file",{path:"sum.test.mjs",content:"import {sum} from './sum.mjs'; if (sum(2, 3) !== 5) throw new Error('incorrect sum');\n"}],
    ["run_tests",{}], ["git_commit",{message:"Add tested sum function"}], ["finish",{summary:"Implemented sum and passed tests"}],
  ],
  review:[ ["inspect_diff",{}], ["run_tests",{}],
    ["submit_verdict",{decision:"approve",summary:"Sum implementation and tests verified",findings:[],acceptance_met:[true]}] ],
};
const observations:string[]=[];
function job(kind:"captain"|"build"|"review"):Job{
  const spec=JobSpecSchema.parse({runId:"run_fixture",kind,role:kind==="build"?"backend":kind,instruction:"Local lifecycle",
    context:{repoUrl:remote,baseBranch:"main",...(kind==="review"?{branch:"kapi/job_build"}:{})}});
  return {...spec,id:`job_${kind}`,parentJobId:kind==="captain"?null:"job_captain",status:"running",
    payload:{instruction:spec.instruction,acceptance:["sum(2,3) is 5"],touches:[],context:spec.context},result:null,
    vmId:`vm_${kind}`,leaseExpiresAt:new Date(Date.now()+60000),attempts:1,error:null,createdAt:new Date(),startedAt:new Date(),finishedAt:null};
}
function client(kind:"captain"|"build"|"review"):PlaneClient{
  let step=0;
  return {
    log:()=>{},emit:()=>{},flush:async()=>{},gitCredentials:async()=>{throw new Error("local fixture has no GitHub grant");},
    loadCheckpoint:async()=>checkpoints.get(kind)??null,
    saveCheckpoint:async(c:Checkpoint)=>{checkpoints.set(kind,structuredClone(c));},
    model:async(req:any)=>{
      for(const msg of req.messages)if(msg.role==="tool")for(const item of msg.content??[]) observations.push(JSON.stringify(item));
      const decision=decisions[kind]![step++];if(!decision)throw new Error("unexpected model call");
      return {text:"",toolCalls:[{toolCallId:`${kind}-${step}`,toolName:decision[0],input:decision[1]}],
        finishReason:"tool-calls",usage:{inputTokens:1,outputTokens:1,totalTokens:2},provider:"fixture",modelId:"fixture",budgetExhausted:false};
    },
    children:async()=>({children,pending:0}),inbox:async()=>({messages:[],cursor:0}),
    spawn:async(agents:any[])=>{
      const spawned=[];
      for(const request of agents){
        const kind=request.kind as "build"|"review";const j=job(kind);const workdir=join(root,kind);await mkdir(workdir,{recursive:true});
        const result=await(kind==="build"?buildRole:reviewRole)({job:j,client:client(kind),workdir,alive:()=>true});
        assert(result.ok,`${kind} succeeds: ${result.summary}`);
        children.push({jobId:j.id,kind,role:j.role,status:"succeeded",instruction:j.payload.instruction,attempts:1,...result});
        spawned.push({jobId:j.id,kind,role:j.role,instruction:j.payload.instruction});
        if(kind==="build"){
          const saved=checkpoints.get("build");assert(saved?.workspace,"Build saved durable output");
          await rm(workdir,{recursive:true,force:true}); // Simulate actual workspace destruction.
          const restored=join(root,"restored");await git(root,"clone",remote,restored);
          await restoreWorkspace(restored,saved.workspace,"kapi/job_build");
          equal(await readFile(join(restored,"sum.mjs"),"utf8"),"export const sum = (a, b) => a + b;\n");
          // Fixture publishes to a local Git remote; no GitHub API or PR is simulated as real evidence.
          await git(restored,"push","origin","kapi/job_build");
        }
      }
      return {spawned,refused:[],budget:{totalSpawns:children.length,maxTotalSpawns:10,depth:0,maxSpawnDepth:2}};
    },
  } as unknown as PlaneClient;
}
try{
  await mkdir(remote);await git(remote,"init","-b","main");await git(remote,"config","user.name","fixture");await git(remote,"config","user.email","fixture@test.local");
  await writeFile(join(remote,"package.json"),JSON.stringify({scripts:{test:"node sum.test.mjs"}}));
  await git(remote,"add",".");await git(remote,"commit","-m","Fixture base");
  await test("Captain delegates Build and Review; local output survives workspace destruction",async()=>{
    const workdir=join(root,"captain");await mkdir(workdir);
    const result=await captainRole({job:job("captain"),client:client("captain"),workdir,alive:()=>true});
    assert(result.ok,result.summary);equal(children.length,2);equal(children[1]?.review?.decision,"approve");
    assert(observations.some(x=>x.includes("exit code: 0")),"real project tests executed");
    assert(observations.some(x=>x.includes("sum.mjs")&&x.includes("DIFF")),"review saw actual candidate diff");
    assert(!observations.some(x=>x.includes('"value":"ERROR')), "tools returned no hidden errors");
  });
}finally{await rm(root,{recursive:true,force:true});}
report();
