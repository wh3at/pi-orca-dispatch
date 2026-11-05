import { writeFileSync } from "node:fs";
import { currentPiCommand } from "../../src/launch-plan.ts";

export default function probe(pi: { on(event: string, handler: () => void): void }): void {
  if (process.env.PI_ORCA_DISPATCH_JOB) return;
  pi.on("session_start", () => {
    try {
      writeFileSync(process.env.PI_DISPATCH_PLAN_OUTPUT!, JSON.stringify({
        plan: currentPiCommand(),
        executable: process.execPath,
        argv: process.argv,
        versions: process.versions,
      }));
      process.exit(0);
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      process.exit(1);
    }
  });
}
