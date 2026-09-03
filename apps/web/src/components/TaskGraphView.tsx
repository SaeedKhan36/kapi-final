import type { Task } from "~/lib/types.ts";
import { Badge, Card, RoleChip } from "./ui.tsx";
import { cn } from "~/lib/cn.ts";

/**
 * Renders the DAG as dependency levels rather than a free-form node graph:
 * "what can run in parallel right now" is the question this view exists to
 * answer, and levels show it directly.
 */
function toLevels(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const depth = new Map<string, number>();

  const resolve = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;              // defensive: cycles are rejected upstream
    seen.add(id);
    const task = byId.get(id);
    const d = !task || task.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...task.dependsOn.map((p) => resolve(p, seen)));
    depth.set(id, d);
    return d;
  };

  for (const t of tasks) resolve(t.taskId);

  const levels: Task[][] = [];
  for (const t of tasks) {
    const d = depth.get(t.taskId) ?? 0;
    (levels[d] ??= []).push(t);
  }
  return levels.filter(Boolean);
}

export function TaskGraphView({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return <Card className="p-6 text-center text-sm text-muted">Waiting for the master to plan…</Card>;
  }

  const levels = toLevels(tasks);

  return (
    <div className="space-y-3">
      {levels.map((level, i) => (
        <div key={i}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              wave {i + 1}
            </span>
            {level.length > 1 && (
              <span className="text-[10px] text-muted">· {level.length} in parallel</span>
            )}
            <div className="h-px flex-1 bg-line/40" />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {level.map((task) => (
              <Card
                key={task.taskId}
                className={cn(
                  "p-3 transition-colors",
                  task.status === "running" && "border-accent/50",
                  task.status === "failed" && "border-bad/50",
                  task.status === "blocked" && "border-warn/50",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{task.title}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{task.taskId}</p>
                  </div>
                  <Badge status={task.status} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <RoleChip role={task.role} />
                  {task.dependsOn.map((d) => (
                    <span key={d} className="rounded border border-line/60 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      ← {d}
                    </span>
                  ))}
                </div>

                {task.branch && (
                  <p className="mt-2 truncate font-mono text-[10px] text-muted">{task.branch}</p>
                )}
                {task.error && (
                  <p className="mt-2 line-clamp-2 text-[11px] text-bad">{task.error}</p>
                )}
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
