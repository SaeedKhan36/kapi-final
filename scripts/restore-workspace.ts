import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkspaceSnapshotSchema } from "@kapi/protocol";
import { restoreWorkspace } from "@kapi/agent-core";
const [input, checkout] = process.argv.slice(2);
if (!input || !checkout) throw new Error("Usage: pnpm restore:workspace <workspace.json> <fresh-checkout-directory>");
const snapshot = WorkspaceSnapshotSchema.parse(JSON.parse(await readFile(resolve(input), "utf8")));
await restoreWorkspace(resolve(checkout), snapshot, "kapi/restored-output");
console.log("Restored commits, staged changes, edits and untracked files on kapi/restored-output");
