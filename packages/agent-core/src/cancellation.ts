import { AsyncLocalStorage } from "node:async_hooks";
const signals=new AsyncLocalStorage<AbortSignal>();
export const currentToolSignal=()=>signals.getStore();
export function withToolSignal<T>(signal:AbortSignal|undefined,fn:()=>T):T {
  return signal?signals.run(signal,fn):fn();
}
