import type { DbHandle, SqlRunner } from "@kapi/db";
import type { Job } from "@kapi/protocol";
import { enqueueIn } from "@kapi/queue";
import type { EventHub } from "./events.ts";
import { Store, type Message, type Project, type Run, type Thread } from "./store.ts";

export type StartRunInput = {
  thread: Thread;
  project: Project;
  goal: string;
  budgets?: Record<string, number>;
  messageRole?: "user" | "system";
  scheduleId?: string | null;
  scheduledFor?: Date | null;
};

export type StartedRun = { message: Message; run: Run; job: Job };

/** The only path that opens a run: all durable initial state commits together. */
export class RunService {
  constructor(
    private handle: DbHandle,
    private store: Store,
    private hub?: EventHub,
  ) {}

  async start(input: StartRunInput): Promise<StartedRun> {
    const result = await this.handle.transaction((tx) => this.startIn(tx, input));
    await this.publish(result.run.id);
    return { ...result, run: (await this.store.getRun(result.run.id)) ?? result.run };
  }

  async startIn(tx: SqlRunner, input: StartRunInput): Promise<StartedRun> {
      const run = await this.store.createRunIn(tx, {
        threadId: input.thread.id,
        projectId: input.project.id,
        goal: input.goal,
        budgets: { ...input.project.budgets, ...input.budgets },
        scheduleId: input.scheduleId,
        scheduledFor: input.scheduledFor,
      });
      const message = await this.store.createMessageIn(tx, {
        threadId: input.thread.id,
        role: input.messageRole ?? "user",
        content: input.goal,
        runId: run.id,
      });
      const job = await enqueueIn(tx, {
        runId: run.id,
        parentJobId: null,
        kind: "captain",
        role: "captain",
        instruction: input.goal,
        acceptance: [],
        touches: [],
        dependsOn: [],
        priority: 10,
        maxAttempts: 3,
        context: {
          repoUrl: input.project.repoUrl,
          baseBranch: input.project.defaultBranch,
          threadId: input.thread.id,
          projectId: input.project.id,
          ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
        },
      });
      return { message, run, job };
  }

  async publish(runId: string): Promise<void> {
    if (this.hub) {
      for (const event of await this.store.listEvents(runId, 0)) this.hub.publish(event);
    }
  }
}
