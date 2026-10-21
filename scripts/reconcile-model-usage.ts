import { loadEnv } from "@kapi/env";
import { createDb } from "@kapi/db";
import { reconcileModelUsage } from "../apps/control-plane/src/model-admission.ts";
const [callId,rawTokens,evidence]=process.argv.slice(2);const tokens=Number(rawTokens);
if(!callId||!Number.isSafeInteger(tokens)||tokens<0||!evidence)throw new Error("Usage: pnpm reconcile:model <call-id> <actual-tokens> <provider-evidence-reference>");
loadEnv();
const handle=await createDb(undefined,{bootstrap:false});
try{await reconcileModelUsage(handle,callId,tokens,evidence);console.log("usage reconciled");}finally{await handle.close();}
