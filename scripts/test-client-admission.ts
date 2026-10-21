import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PlaneClient } from "../apps/agent/src/client.ts";
import { test, equal, assert, report } from "./harness.ts";
let calls=0;let terminal=false;
const server=createServer((_req,res)=>{
  calls++;res.setHeader("content-type","application/json");
  if(terminal||calls===1){res.statusCode=429;res.end(JSON.stringify({error:"capacity",retryable:!terminal}));}
  else res.end(JSON.stringify({text:"ok",toolCalls:[],finishReason:"stop",usage:{inputTokens:1,outputTokens:1,totalTokens:2},provider:"fixture",modelId:"fixture"}));
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const client=new PlaneClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,"fixture",{retries:0});
const request={tier:"coding" as const,messages:[{role:"user" as const,content:"test"}],tools:[],toolChoice:"auto" as const};
try{
  await test("model capacity waits independently of the transport retry budget",async()=>{
    equal((await client.model(request)).text,"ok");equal(calls,2);
  });
  await test("exhausted model budget is not retried",async()=>{
    terminal=true;const before=calls;let denied=false;try{await client.model(request);}catch{denied=true;}
    assert(denied,"terminal budget rejected");equal(calls,before+1);
  });
  await test("cancellation interrupts a queued model retry",async()=>{
    terminal=false;calls=0;const abort=new AbortController();
    const cancelled=new PlaneClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,"fixture",{signal:abort.signal});
    const before=Date.now();setTimeout(()=>abort.abort(),100);
    let denied=false;try{await cancelled.model(request);}catch{denied=true;}
    assert(denied,"model wait aborted");assert(Date.now()-before<1000,"does not wait for retry timer");equal(calls,1);
  });
}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
report();
