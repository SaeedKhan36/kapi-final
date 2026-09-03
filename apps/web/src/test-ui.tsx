import { renderToStaticMarkup } from "react-dom/server";
import { AgentTree } from "./components/AgentTree.tsx";
import { BudgetMeter } from "./components/RunPanel.tsx";
import { Badge, RoleChip } from "./components/ui.tsx";
import type { AgentNode, TreeNode } from "./lib/agents.ts";
import { assert, group, report, test } from "../../../scripts/harness.ts";

const node = (over: Partial<AgentNode>): AgentNode => ({
  jobId: "job_root", parentJobId: null, kind: "captain", role: "captain",
  status: "running", instruction: "lead the change", attempts: 1, vmId: "vm-1",
  summary: null, branch: null, prUrl: null, error: null, verdict: null, ci: null,
  activity: [], ...over,
});

group("web UI states");

await test("status and role chips use human-readable labels", () => {
  const html = renderToStaticMarkup(<><Badge status="request_changes" /><RoleChip role="captain" /></>);
  assert(html.includes("request changes"), "underscored status is readable");
  assert(html.includes("captain"), "role remains visible without relying on color");
});

await test("budget meters clamp usage and expose exact values", () => {
  const html = renderToStaticMarkup(<BudgetMeter label="Tokens" used={120} max={100} />);
  assert(html.includes("120/100"), "exact budget numbers are present");
  assert(html.includes("width:100%"), "over-budget usage cannot overflow its track");
});

await test("the fleet remains a nested spawn tree and surfaces delivery state", () => {
  const tree: TreeNode[] = [{
    node: node({}),
    children: [{
      node: node({
        jobId: "job_build", parentJobId: "job_root", kind: "build", role: "backend",
        status: "succeeded", instruction: "implement the endpoint", prUrl: "https://github.com/kapi/test/pull/1",
        ci: { name: "tests", conclusion: "success", branch: "kapi/job_build", url: null },
      }),
      children: [],
    }],
  }];
  const html = renderToStaticMarkup(<AgentTree roots={tree} selected="job_root" onSelect={() => {}} />);
  assert(html.includes("implement the endpoint"), "child instruction is rendered");
  assert(html.includes("PR ready"), "pull request state is rendered");
  assert(html.includes("ci: success"), "CI state is rendered");
});

report();
