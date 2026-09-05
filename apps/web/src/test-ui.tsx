import { renderToStaticMarkup } from "react-dom/server";
import { AgentTree } from "./components/AgentTree.tsx";
import { BudgetMeter } from "./components/RunPanel.tsx";
import { Badge, RoleChip } from "./components/ui.tsx";
import { Readiness } from "./pages/Setup.tsx";
import { Landing } from "./pages/Landing.tsx";
import { match } from "./router.tsx";
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

await test("the landing page describes the adaptive captain rather than a frozen planner", () => {
  const html = renderToStaticMarkup(<Landing />);
  assert(html.includes("live captain"), "the adaptive orchestrator is named");
  assert(html.includes("There is no frozen task graph"), "the implementation model is accurate");
  assert(!html.includes("Gemini") && !html.includes("Infinite parallel"), "retired product claims are gone");
  assert(html.includes('href="/app"'), "the primary call to action reaches the dashboard");
});

await test("setup readiness remains understandable without color", () => {
  const html = renderToStaticMarkup(
    <Readiness label="Vault" value="not configured" detail="Set the encryption key." ok={false} />,
  );
  assert(html.includes("needs attention"), "the warning has an accessible label");
  assert(html.includes("Set the encryption key"), "the corrective detail is visible");
});

await test("route matching decodes ids and rejects malformed escapes", () => {
  assert(match("/projects/a%20b", "/projects/:id")?.id === "a b", "encoded ids decode");
  assert(match("/projects/%ZZ", "/projects/:id") === null, "bad URL encoding cannot crash the app");
});

report();
