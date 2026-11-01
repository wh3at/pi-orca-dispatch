# Issue #4: startup registration validation

## Contract and ordering

Every saved `activeTools` name is required, regardless of its source. The observer starts a bounded registration check without awaiting it in `session_start`, allowing subsequent startup handlers to initiate asynchronous registration. The initial `input` waits on that check; it never forwards the task with missing tools. Registration is polled every 100 ms within a single 30-second startup budget. If all tools already exist, no timer is needed.

Pi 1.4.0's installed `dist/core/extensions/runner.js` was inspected: `emit()` awaits session handlers in extension/registration order, while `emitInput()` awaits input handlers in the same order and short-circuits on `handled`. Waiting in the observer's startup handler would prevent later startup initialization. Passing an unverified input onward would risk executing with the wrong configuration. This fix therefore waits only after startup handlers have had the opportunity to start their work. Registration that can begin only in a later input handler, rather than at startup or asynchronously, cannot be advanced by this gate and will time out safely.

## Automated regression coverage

Run `node --experimental-strip-types --test tests/launcher.test.ts` for observer and launcher coverage, and `npm test` for the complete suite.

Tests use the observer's event/API boundary and real temporary job files. Mocked timers make the 30-second deadline reproducible. They cover delayed namespace and non-MCP tool registration, immediate readiness, one non-renewable budget, partial availability, timeout without recovery, saved instructions, acceptance markers, strict model/tool checks, and cancellation on new/resume/reload/shutdown including resolved-promise races. Existing ownership and post-acceptance configuration protection tests remain in place.

## Version and integration scope

- Regression tests and TypeScript checks were run on Linux with Node.js 26.13.0.
- A separate temporary harness used the installed Pi 1.4.0 `ExtensionRunner`, with the actual observer first and a subsequent extension starting asynchronous registration in `session_start`. The runner's real `emit`, `emitInput`, and `emitToolCall` methods verified that startup proceeds, tool calls are blocked while waiting, the initial input reaches the subsequent handler once, and the expected tools and acceptance marker are restored without extension errors. The registry/registration producer in that harness was simulated.
- README's previous Pi 0.85.1 verification is historical; that version was not rerun for this fix.
- The issue reports Node.js 24.22.1 and pi-mcp-adapter 7.0.0. Neither that exact stack nor an end-to-end Orca child process with real MCP servers was tested here. No claim is made that all MCP servers connected, authenticated, or passed project trust. No adapter-specific API or dependency was introduced.
