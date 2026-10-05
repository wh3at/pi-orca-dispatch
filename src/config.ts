import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Placement = "split" | "tab";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "orca-dispatch.json");
}

export function readPlacement(path: string = configPath()): Placement {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "split";
    throw new Error(`設定ファイルを読み取れません: ${path}`, { cause: error });
  }
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch (error) {
    throw new Error(`設定ファイルの JSON が不正です: ${path}`, { cause: error });
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`設定ファイルにはオブジェクトを指定してください: ${path}`);
  }
  const placement = (settings as { placement?: unknown }).placement;
  if (placement === undefined) return "split";
  if (placement === "split" || placement === "tab") return placement;
  throw new Error(`placement は "split" または "tab" を指定してください: ${path}`);
}
