import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchTask, DispatchError } from "./src/dispatch.ts";
import type { DispatchInput } from "./src/dispatch.ts";
import { listJobs, listOrphanJobs, isFinished, removeJob, snapshotUnused, statusOf, resolveSessionDir } from "./src/jobs.ts";
import type { StoredJob } from "./src/jobs.ts";
import { closeTerminal, OrcaError, resolveOrcaCommand, switchTerminal } from "./src/orca.ts";

// Structural types keep this extension usable with both official package scopes.
// Runtime integration uses only the documented extension API.
interface Context {
  cwd: string;
  hasUI: boolean;
  mode?: string;
  model?: { provider: string; id: string };
  sessionManager: DispatchInput["manager"] & {
    getSessionDir(): string;
    getSessionId(): string;
  };
  isIdle(): boolean;
  waitForIdle?(): Promise<void>;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
    getEditorText(): string;
    setEditorText(value: string): void;
    editor(title: string, initialText?: string): Promise<string | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
  };
}
interface PiAPI {
  registerCommand(name: string, options: {
    description: string;
    handler(args: string, ctx: Context): Promise<void>;
    getArgumentCompletions?(prefix: string): { value: string; label: string; description?: string }[] | null;
  }): void;
  on(event: string, handler: (event: unknown, ctx: Context) => void | Promise<void>): void;
  getActiveTools(): string[];
  getThinkingLevel(): string;
}

export default function orcaDispatch(pi: PiAPI): void {
  const packageDir = dirname(fileURLToPath(import.meta.url));
  let generation = 0;
  let activeContext: Context | undefined;
  let storedJobs: StoredJob[] = [];
  let busy = false;
  let refreshRunning = false;
  let timer: ReturnType<typeof setInterval> | undefined;


  async function refresh(): Promise<void> {
    const ctx = activeContext;
    const epoch = generation;
    if (!ctx?.hasUI || refreshRunning) return;
    refreshRunning = true;
    try {
      const current = await Promise.all(storedJobs.map(async (stored) => ({ stored, status: await statusOf(stored) })));
      if (epoch !== generation) return;
      if (current.length === 0) { ctx.ui.setStatus("orca-dispatch", undefined); return; }
      const working = current.filter((item) => ["working", "starting"].includes(item.status.state)).length;
      const waiting = current.filter((item) => ["idle", "ready"].includes(item.status.state)).length;
      const errors = current.filter((item) => ["failed", "blocked", "unknown"].includes(item.status.state)).length;
      const parts = [working ? `${working} 起動・実行中` : "", waiting ? `${waiting} 待機中` : "", errors ? `${errors} 要確認` : ""].filter(Boolean);
      ctx.ui.setStatus("orca-dispatch", `Orca: ${parts.length ? parts.join(" / ") : "終了"} · --list`);
    } finally { refreshRunning = false; }
  }

  async function load(ctx: Context): Promise<void> {
    const epoch = generation;
    const jobs = await listJobs(resolveSessionDir(ctx.sessionManager.getSessionDir(), ctx.cwd), ctx.sessionManager.getSessionId());
    if (epoch === generation) storedJobs = jobs;
  }

  pi.on("session_start", async (_event, ctx) => {
    generation++;
    activeContext = ctx;
    storedJobs = [];
    if (timer) clearInterval(timer);
    try { await load(ctx); await refresh(); }
    catch { /* A stale optional job index must not prevent pi from starting. */ }
    timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
    timer.unref();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    activeContext = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx.ui.setStatus("orca-dispatch", undefined);
  });

  async function showJobs(ctx: Context): Promise<void> {
    await load(ctx);
    if (storedJobs.length === 0) {
      ctx.ui.notify("この会話から送り出した作業はありません。", "info");
      return;
    }
    const rows = await Promise.all(storedJobs.map(async (stored, index) => ({
      stored,
      status: await statusOf(stored),
      index,
    })));
    const labels = rows.map(({ stored, status, index }) => `${index + 1}. ${status.label} · ${stored.job.title}`);
    const selected = await ctx.ui.select("Orca の作業を開く", labels);
    if (selected === undefined) return;
    const row = rows[labels.indexOf(selected)];
    if (!row) return;
    if (!row.stored.receipt.handle) {
      ctx.ui.notify(`${row.status.error ?? "タブ情報がありません。Orca のタブ一覧を確認してください。"}\n派生セッション: ${row.stored.job.sessionFile}`, "warning");
      return;
    }
    try {
      // The job's own cwd may be gone; the CLI only needs a directory that exists.
      await switchTerminal({ cwd: ctx.cwd, handle: row.stored.receipt.handle });
    } catch (error) {
      ctx.ui.notify(`タブを開けませんでした。Orca のタブ一覧から開いてください。\n${error instanceof Error ? error.message : String(error)}\n派生セッション: ${row.stored.job.sessionFile}`, "warning");
    }
  }

  /** Removes finished jobs from the list, closing their Orca tabs. */
  async function cleanJobs(ctx: Context): Promise<void> {
    const sessionDir = resolveSessionDir(ctx.sessionManager.getSessionDir(), ctx.cwd);
    const parentId = ctx.sessionManager.getSessionId();
    // Other sessions' jobs are invisible to --list, so nothing else would clean them.
    const [mine, orphans] = await Promise.all([
      listJobs(sessionDir, parentId),
      listOrphanJobs(sessionDir, parentId),
    ]);
    const all = [...mine, ...orphans];
    if (all.length === 0) {
      ctx.ui.notify("片付ける作業はありません。", "info");
      return;
    }
    const rows = await Promise.all(all.map(async (stored) => ({ stored, status: await statusOf(stored) })));
    const finished = rows.filter((row) => isFinished(row.status.state)).map((row) => row.stored);
    const actions = [
      ...(finished.length
        ? [{ label: `終了済み ${finished.length} 件を片付ける（タブを閉じる）`, targets: finished, confirm: false }]
        : []),
      { label: `すべて ${all.length} 件を片付ける（実行中のタブも閉じる）`, targets: all, confirm: true },
    ];
    const selected = await ctx.ui.select("Orca の作業を片付ける", actions.map((action) => action.label));
    if (selected === undefined) return;
    const action = actions.find((candidate) => candidate.label === selected);
    if (!action) return;
    if (action.confirm) {
      const proceed = await ctx.ui.confirm(
        "実行中の作業も片付けますか？",
        `${action.targets.length} 件の Orca タブを閉じるため、実行中の子の作業はそこで中断されます。子タブで一度も使っていない派生セッションだけを削除し、使用済みの会話は残します。`,
      );
      if (!proceed) return;
    }
    const removed: string[] = [];
    const keptFiles: string[] = [];
    const failures: string[] = [];
    for (const stored of action.targets) {
      let tabGone = true;
      if (stored.receipt.handle) {
        try { await closeTerminal({ cwd: ctx.cwd, handle: stored.receipt.handle }); }
        catch (error) {
          const code = error instanceof OrcaError ? error.code : "";
          // A closed or superseded tab is already gone; anything else is worth reporting.
          tabGone = code === "terminal_exited" || code === "selector_not_found";
        }
      }
      const unused = await snapshotUnused(stored);
      try { await removeJob(stored, { snapshot: unused }); }
      catch (error) {
        failures.push(`${stored.job.title}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      removed.push(stored.job.title);
      if (!unused) keptFiles.push(stored.job.sessionFile);
      if (!tabGone) failures.push(`${stored.job.title}: タブを閉じられませんでした`);
    }
    await load(ctx);
    await refresh();
    const lines = [`${removed.length} 件を片付けました。`];
    if (keptFiles.length) {
      lines.push(`子タブで作業済みの派生セッション ${keptFiles.length} 件は残しました:\n${keptFiles.slice(0, 3).join("\n")}${keptFiles.length > 3 ? `\nほか ${keptFiles.length - 3} 件` : ""}`);
    }
    if (failures.length) lines.push(`未処理: ${failures.join(" / ")}`);
    ctx.ui.notify(lines.join("\n"), failures.length ? "warning" : "info");
  }

  pi.registerCommand("orca-dispatch", {
    description: "今の会話を保持して Orca の別タブへ指示を渡す。--list で作業一覧、--clean で片付け",
    getArgumentCompletions(prefix) {
      if (!prefix.startsWith("-")) return null;
      return [
        { value: "--list", label: "--list", description: "この会話から送り出した作業を開く" },
        { value: "--clean", label: "--clean", description: "終了した作業のタブと履歴を片付ける" },
        { value: "--help", label: "--help", description: "使い方" },
      ].filter((item) => item.value.startsWith(prefix));
    },
    async handler(args, ctx) {
      if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui")) {
        ctx.ui.notify("/orca-dispatch は対話型の pi ターミナルから実行してください。", "error");
        return;
      }
      if (args.trim() === "--help") {
        const cli = resolveOrcaCommand();
        ctx.ui.notify(`/orca-dispatch <指示> — 同じフォルダ・モデルで別タブへ送信\n/orca-dispatch — 複数行の指示を入力\n/orca-dispatch --list — この会話から送り出した作業を開く\n/orca-dispatch --clean — 終了した作業のタブと履歴を片付ける\nOrca CLI: ${cli ?? "未検出（Orca アプリの CLI を確認してください）"}`, "info");
        return;
      }
      if (args.trim() === "--list") {
        try { await showJobs(ctx); }
        catch (error) { ctx.ui.notify(String(error), "error"); }
        return;
      }
      if (args.trim() === "--clean") {
        try { await cleanJobs(ctx); }
        catch (error) { ctx.ui.notify(String(error), "error"); }
        return;
      }
      if (busy) { ctx.ui.notify("先ほどの指示を送り出しています。", "info"); return; }
      busy = true;
      const epoch = generation;
      const parentId = ctx.sessionManager.getSessionId();
      const isCurrent = () => generation === epoch && ctx.sessionManager.getSessionId() === parentId;
      let prompt = args;
      try {
        if (!prompt.trim()) prompt = await ctx.ui.editor("Orca の別タブへ渡す指示", "") ?? "";
        if (!prompt.trim()) return;
        if (!ctx.isIdle()) {
          ctx.ui.notify("本筋の処理が終わると、会話を引き継いで起動します。", "info");
          if (!ctx.waitForIdle) throw new Error("本筋の処理が終わってから実行してください。");
          await ctx.waitForIdle();
        }
        if (!isCurrent()) return;
        if (!ctx.model) throw new Error("モデルが選択されていません。/model で選択してください。");
        const stored = await dispatchTask(prompt, {
          manager: ctx.sessionManager,
          sessionDir: resolveSessionDir(ctx.sessionManager.getSessionDir(), ctx.cwd),
          cwd: ctx.cwd,
          model: ctx.model,
          thinkingLevel: pi.getThinkingLevel(),
          activeTools: pi.getActiveTools(),
          packageDir,
          isCurrent,
        });
        if (!isCurrent()) return;
        storedJobs.unshift(stored);
        await refresh();
        ctx.ui.notify(`Orca の別タブへ送り出しました: ${stored.job.title}\n元の会話をそのまま続けられます。`, "info");
        if (stored.receipt.warning) ctx.ui.notify(stored.receipt.warning, "warning");
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof DispatchError && error.stored) {
          storedJobs.unshift(error.stored);
          await refresh();
        }
        const ambiguous = error instanceof DispatchError && error.ambiguous;
        const message = error instanceof Error ? error.message : String(error);
        const recovery = error instanceof DispatchError && error.stored ? `\n派生セッション: ${error.stored.job.sessionFile}` : "";
        ctx.ui.notify(`${message}${recovery}`, "error");
        // Never overwrite a new draft, and don't invite a duplicate launch after
        // an uncertain mutation. The task remains in its private job directory.
        if (!ambiguous && prompt.trim() && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(`/orca-dispatch ${prompt}`);
      } finally { busy = false; }
    },
  });
}
