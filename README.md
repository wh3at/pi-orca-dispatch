# pi-orca-dispatch

A [Pi](https://github.com/earendil-works/pi) extension for handing the current conversation to a new [Orca](https://www.onorca.dev) split pane, which opens with the same folder, model, and tools while the parent session stays untouched.

## Install

```bash
pi install npm:pi-orca-dispatch
```

Restart Pi after installation.

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review the [source code](https://github.com/wh3at/pi-orca-dispatch) before installing third-party packages.

### Requirements

- **Orca** running on the same machine, with its CLI registered. SSH workspaces and paired remote runtimes are refused, because the new terminal has to read this machine's session files.
- **Pi started inside an Orca terminal pane in a managed worktree.** Split mode requires `ORCA_TERMINAL_HANDLE` to identify the source pane; it never falls back to the active pane or a new tab. Dispatch stops when the current directory is outside the worktree.
- **Node.js 22.19.0 or later**, which is also Pi's own requirement.

The Orca CLI is located without any extension-specific configuration:

| Platform | CLI | Note |
| --- | --- | --- |
| Linux | `orca-ide` | Bare `orca` is the GNOME screen reader, so it is never used as a fallback. |
| macOS / Windows | `orca` | Windows resolves `.exe`, `.cmd`, and `.ps1` entries through `PATHEXT`, and starts batch shims through `cmd.exe`. |

`ORCA_CLI_COMMAND` overrides the lookup, and `ORCA_DEV_REPO_ROOT` selects `orca-dev` for Orca development checkouts.

### Pi peer dependencies

This package has no runtime dependencies and imports no Pi packages. It uses documented extension APIs only (`registerCommand`, the `session_start` and `session_shutdown` events, the `input` and `tool_call` results, `ui.editor`/`ui.select`/`ui.confirm`, and the read-only `ctx.sessionManager` accessors), so no peer dependencies are declared. Verified against Pi 0.85.1.

## Install from source

Cloning into Pi's auto-discovered extension directory keeps `/reload` working:

```bash
git clone https://github.com/wh3at/pi-orca-dispatch.git \
  ~/.pi/agent/extensions/pi-orca-dispatch
```

Or register a checkout as a local package instead:

```bash
pi install /absolute/path/to/pi-orca-dispatch
```

## Global configuration

To opt into new tabs instead of split panes, create `~/.pi/agent/orca-dispatch.json`:

```json
{
  "placement": "tab"
}
```

When `PI_CODING_AGENT_DIR` is set, the file lives in that directory instead. Set `placement` to `"split"` to explicitly select split panes. A missing file or omitted field defaults to split panes. The file must contain a JSON object; invalid JSON, invalid placement values, and read failures stop dispatch.

Configuration is read on every dispatch, so changes apply without restarting Pi. Only this global file is used; project configuration and per-command placement flags are not supported. Tab mode preserves the existing `pi: <first line>` tab title and focuses the created tab.

## Usage

Send an instruction to a new terminal:

```text
/orca-dispatch 失敗しているテストを直して
```

Then the extension:

1. Captures the active branch of this conversation into a new session file. The parent session file is never modified, and your editor draft is left alone.
2. Splits the pane running this Pi session and focuses the new pane. Direction is left to Orca (currently a right-hand, half-width split). The parent tab is not renamed; the child pane title is managed by Pi and Orca.
3. Starts Pi there with the same provider, model, thinking level, and active tools, and delivers the instruction as its first message.

The parent conversation stays free for other work, and either session can dispatch again.

A successful dispatch reports nothing: the new terminal becomes active. Warnings and errors are still shown, and a failed dispatch leaves the instruction in the editor when nothing else is being typed and creation is known not to have occurred.

Without arguments, `/orca-dispatch` opens a multi-line editor for the instruction. Canceling it sends nothing.

```text
/orca-dispatch --list    Open one of the sessions dispatched from this conversation
/orca-dispatch --clean   Retire finished dispatches
/orca-dispatch --help    Show the resolved Orca CLI and the available flags
```

### `--list`

Lists the sessions dispatched from this conversation with their current state (`起動待ち`, `起動済み`, `実行中`, `待機中`, `終了`, `エラー終了`, `起動エラー`, `起動状況未確認`) and opens the selected Orca terminal. When the terminal is already gone, the derived session file to resume is reported instead.

### `--clean`

By default, `--clean` only retires jobs that are finished (`終了`, `エラー終了`, `起動エラー`), then closes their Orca terminals. Running children are closed and interrupted only through the explicit "close everything" choice, which asks for confirmation first.

Cleanup also sees jobs left behind by other conversations in this project, which `--list` cannot show. It removes the job directory, and deletes the derived session file **only when the child never wrote to it**; a conversation that was worked on in the child terminal is kept, and its path is reported.

## What is written where

One directory per dispatched session, under the project's session directory:

```text
<session dir>/orca-dispatch/<parent session id>/<child session id>/
  job.json            startup description: argv, cwd, model, tools, snapshot length
  task.txt            the instruction, as the child's first message
  receipt.json        Orca terminal handle, or the failure reason
  claimed             written by the launcher wrapper before it starts Pi
  task-started        written by the observer once the instruction was accepted
  runner-status.json  launcher wrapper state and exit code
  agent-status.json   live child state (ready, working, idle, closed, blocked)
```

The derived session file lives beside the parent session file in the project's session directory. The parent's model, tools, and messages are never changed.

## Limits

- The child inherits the conversation **as of the dispatch**, plus the model and tool selection at that moment. Later parent turns and later model changes stay in the parent; the child re-applies its model and tool selection once, at startup.
- Dispatch stays in the same folder. A worktree on another host is refused rather than guessed.
- On Windows the terminal command is passed as a single base64-encoded PowerShell command, so CMD and PowerShell parse it identically. An Orca terminal configured to use WSL as its default shell is not supported.
- Repeated split dispatches subdivide the originating pane again. There is no automatic equalization or tab fallback.
- Cleanup is manual. Nothing expires on its own; run `/orca-dispatch --clean`.

## License

MIT
