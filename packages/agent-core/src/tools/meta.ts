import type { AgentTool } from "../types.ts";

export const finishTool: AgentTool = {
  name: "finish",
  description:
    "End the task. Call this as soon as the acceptance criteria are met - do not keep " +
    "polishing. If you could not finish, call it anyway and say plainly what remains.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "What you changed and why, in a few sentences. This is what a reviewer reads.",
      },
    },
    required: ["summary"],
  },
  terminal: true,
  async run(input) {
    return { output: "finished", meta: { summary: String(input.summary ?? "") } };
  },
};

/**
 * Asks the captain a question and waits for a bounded time.
 *
 * Bounded on purpose. A worker that waits indefinitely on a captain that is
 * busy, finished, or dead is a deadlocked run, so a timeout returns a clear
 * instruction to proceed on the agent's own judgement instead.
 */
export const askCaptainTool: AgentTool = {
  name: "ask_captain",
  description:
    "Ask the captain a question when the task is genuinely ambiguous. Prefer making a " +
    "reasonable decision and noting it in your summary - waiting costs time.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  async run(input, ctx) {
    const question = String(input.question ?? "");
    const answer = await ctx.askCaptain(question);
    if (answer === null) {
      return {
        output:
          "No answer arrived in time. Proceed on your best judgement and record the " +
          "assumption you made in your finish summary.",
      };
    }
    return { output: `Captain: ${answer}` };
  },
};
