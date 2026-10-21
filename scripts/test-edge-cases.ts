import { openPullRequest } from "@kapi/agent-core";
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
report();
