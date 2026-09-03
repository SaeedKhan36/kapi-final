import { renderToStaticMarkup } from "react-dom/server";
import { Badge, RoleChip } from "./components/ui.tsx";
import { TaskGraphView } from "./components/TaskGraphView.tsx";
import { MessageFeed } from "./components/MessageFeed.tsx";
import type { Message, Task } from "./lib/types.ts";
import { assert, group, report, test } from "../../../scripts/harness.ts";

group("web UI states");

await test("status and role chips use human-readable labels", () => {
  const html = renderToStaticMarkup(<><Badge status="completed_with_failures" /><RoleChip role="frontend" /></>);
  assert(html.includes("completed with failures"), "underscored status is readable");
  assert(html.includes("frontend"), "role remains visible without relying on color");
});

await test("task graph renders dependency waves", () => {
  const tasks: Task[] = [
    {
      runId: "r1", taskId: "t1", title: "Add health endpoint", instruction: "implement",
      role: "backend", status: "running", dependsOn: [], touches: [], acceptance: [],
      assignedTo: null, branch: "kapi/t1", error: null, startedAt: null, finishedAt: null,
    },
    {
      runId: "r1", taskId: "t2", title: "Cover with tests", instruction: "test",
      role: "testing", status: "pending", dependsOn: ["t1"], touches: [], acceptance: [],
      assignedTo: null, branch: null, error: null, startedAt: null, finishedAt: null,
    },
  ];
  const html = renderToStaticMarkup(<TaskGraphView tasks={tasks} />);
  assert(html.includes("wave 1"), "first dependency wave is labeled");
  assert(html.includes("Add health endpoint"), "task title is rendered");
  assert(html.includes("← t1"), "dependency chip is rendered");
});

await test("message feed surfaces agent traffic", () => {
  const messages: Message[] = [{
    id: "m1", runId: "r1", taskId: "t1", from: "worker:backend", to: "master",
    type: "TASK_COMPLETED", content: "done", files: [{ path: "src/health.ts", action: "add" }],
    replyTo: null, ts: new Date().toISOString(),
  }];
  const html = renderToStaticMarkup(<MessageFeed messages={messages} />);
  assert(html.includes("TASK_COMPLETED"), "message type is rendered");
  assert(html.includes("src/health.ts"), "touched files are rendered");
});

report();
