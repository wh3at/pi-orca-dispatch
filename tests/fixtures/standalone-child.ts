import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { currentPiCommand } from "../../src/launch-plan.ts";
import { dispatchTask } from "../../src/dispatch.ts";

export default function child(pi: any): void {
  if (!process.env.PI_ORCA_DISPATCH_JOB) return;
  process.env.ANTHROPIC_API_KEY = "pi-dispatch-offline-test";
  const output = process.env.PI_DISPATCH_CHILD_OUTPUT ?? join(dirname(process.env.PI_ORCA_DISPATCH_JOB), "test-observation.jsonl");
  let inputs = 0;
  pi.on("input", () => { inputs++; });
  pi.on("before_provider_request", () => process.exit(99));
  pi.on("session_start", () => {
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const job = JSON.parse(readFileSync(process.env.PI_ORCA_DISPATCH_JOB!, "utf8"));
        const plan = currentPiCommand();
        const nested = await dispatchTask("nested instruction", {
          manager: ctx.sessionManager,
          sessionDir: dirname(job.sessionFile),
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: pi.getThinkingLevel(),
          activeTools: pi.getActiveTools(),
          packageDir: resolve(import.meta.dirname, "../.."),
          sourceTerminalHandle: "test-pane",
        }, {
          preflight: async () => ({ worktreeId: "test-worktree", worktreePath: ctx.cwd }),
          launchTerminal: async () => ({ handle: "nested-test-pane" }),
        });
        appendFileSync(output, JSON.stringify({
          text: event.prompt,
          inputs,
          sessionFile: ctx.sessionManager.getSessionFile(),
          branch: ctx.sessionManager.getBranch(),
          cwd: ctx.cwd,
          model: { provider: ctx.model.provider, id: ctx.model.id },
          thinking: pi.getThinkingLevel(),
          tools: pi.getActiveTools(),
          plan,
          nested,
        }) + "\n");
        process.exit(0);
      } catch (error) {
        writeFileSync(output, String(error) + "\n" + String((error as Error).cause));
        process.exit(98);
      }
    });
  });
}
