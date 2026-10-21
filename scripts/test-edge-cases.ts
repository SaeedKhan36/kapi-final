import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, ModelResponse } from "@kapi/protocol";
import { openPullRequest, runLoop, shell, withToolSignal, type ToolContext } from "@kapi/agent-core";
import { test, equal, report } from "./harness.ts";
await test("PR replay reconciles a lost create response by branch and base", async () => {
  const original=globalThis.fetch;let created=false;let posts=0;
  globalThis.fetch=(async (_url,init)=>{
    if(init?.method==="POST") {posts++;created=true;throw new Error("response lost after GitHub commit");}
    return new Response(JSON.stringify(created?[{html_url:"https://github.com/test/repo/pull/1",number:1}]:[]),{status:200});
  }) as typeof fetch;
  const args={head:"kapi/job",base:"main",title:"test",body:"test"};
  try{
    try{await openPullRequest("fixture",{owner:"test",repo:"repo"},args);}catch{}
    equal((await openPullRequest("fixture",{owner:"test",repo:"repo"},args)).number,1);
    equal(posts,1,"no second PR creation request");
  }finally{globalThis.fetch=original;}
});
const ctx:ToolContext={cwd:"/tmp",jobId:"journal-job",runId:"journal-run",log:()=>{},gitCredentials:async()=>{throw Error("unused");},askCaptain:async()=>null};
const response:ModelResponse={text:"",toolCalls:[{toolCallId:"one",toolName:"run_command",input:{}},{toolCallId:"done",toolName:"finish",input:{summary:"done"}}],finishReason:"tool-calls",usage:{inputTokens:1,outputTokens:1,totalTokens:2},provider:"fixture",modelId:"fixture",budgetExhausted:false};
await test("restart resumes persisted tool decisions and never blindly repeats an interrupted command",async()=>{
  let saved:Checkpoint|undefined;let executions=0;
  const tools=[{name:"run_command",description:"",inputSchema:{},run:async()=>{executions++;return{output:"external action"};}},
    {name:"finish",description:"",inputSchema:{},terminal:true,run:async()=>({output:"done"})}];
  try {await runLoop({system:"",brief:"",ctx,tools,callModel:async()=>response,
    onCheckpoint:async c=>{if(c.pending?.next===1)throw Error("VM lost before result acknowledgement");saved=structuredClone(c);}});}catch{}
  equal(executions,1);
  const result=await runLoop({system:"",brief:"",ctx,tools,resumeFrom:saved,callModel:async()=>{throw Error("must resume saved decision");}});
  equal(result.ok,true);equal(executions,1,"uncertain external command was not replayed");
});
await test("completed terminal checkpoint reports success without another model call",async()=>{
  const result=await runLoop({system:"",brief:"",ctx,tools:[],resumeFrom:{step:2,messages:[],summary:"",commits:[],filesTouched:[],finished:true,resultSummary:"already done"},callModel:async()=>{throw Error("no new model call");}});
  equal(result.ok,true);equal(result.summary,"already done");
});
await test("cancellation kills a command and its background descendants",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"kapi-cancel-"));const abort=new AbortController();
  try{
    const result=withToolSignal(abort.signal,()=>shell(dir,`node -e 'setTimeout(()=>require("fs").writeFileSync("late","bad"),700)' & wait`,5000));
    setTimeout(()=>abort.abort(),100);equal((await result).exitCode,130);
    await new Promise(r=>setTimeout(r,900));
    let exists=false;try{await access(join(dir,"late"));exists=true;}catch{}
    equal(exists,false,"descendant never writes after cancellation");
  }finally{await rm(dir,{recursive:true,force:true});}
});
report();
