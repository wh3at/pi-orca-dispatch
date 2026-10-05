import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeTerminal, launchTerminal, OrcaError, orcaSpawnPlan, preflight, resolveOrcaCommand, switchTerminal } from '../src/orca.ts';

async function mockCli(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-orca-cli-'));
  const orcaCommand = join(cwd, 'mock-orca');
  await writeFile(orcaCommand, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { cwd, orcaCommand, clean: () => rm(cwd, { recursive: true, force: true }) };
}

test('preflight uses the enclosing worktree and preserves its explicit ID', async () => {
  const fixture = await mockCli(`
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ id: 'rpc', ok: true, result: { worktree: {
      id: 'repo-id::' + __dirname, path: __dirname
    } }, _meta: { runtimeId: 'runtime' } }));
  `);
  try {
    const nested = join(fixture.cwd, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    assert.deepEqual(await preflight({ ...fixture, cwd: nested }), {
      worktreeId: 'repo-id::' + fixture.cwd,
      worktreePath: fixture.cwd,
    });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.cwd, 'args.json'), 'utf8')), ['worktree', 'current', '--json']);
  } finally { await fixture.clean(); }
});

test('launch passes literal argv and reveals the created tab', async () => {
  const fixture = await mockCli(`
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ id: 'rpc', ok: true, result: { terminal: {
      handle: 'term-123', surface: 'visible'
    } }, _meta: { runtimeId: 'runtime' } }));
  `);
  try {
    const title = "案B $(touch SHOULD_NOT_EXIST) ' quote";
    const command = "pi --session '/tmp/session with spaces.jsonl'";
    assert.deepEqual(await launchTerminal({ placement: 'tab', ...fixture, worktreeId: 'repo::/workspace', title, command }), {
      handle: 'term-123', surface: 'visible',
    });
    const args = JSON.parse(await readFile(join(fixture.cwd, 'args.json'), 'utf8'));
    assert.deepEqual(args, ['terminal', 'create', '--worktree', 'id:repo::/workspace', '--title', title, '--command', command, '--focus', '--json']);
    await assert.rejects(readFile(join(fixture.cwd, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
  } finally { await fixture.clean(); }
});

test('launch retains success warnings when UI reveal failed', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: true, result: { terminal: {
    handle: 'term-123', surface: 'background', warning: 'Could not reveal tab'
  } } }));`);
  try {
    assert.deepEqual(await launchTerminal({ placement: 'tab', ...fixture, title: 'task', command: 'pi' }), {
      handle: 'term-123', surface: 'background', warning: 'Could not reveal tab',
    });
  } finally { await fixture.clean(); }
});

test('preflight rejects unrelated worktree paths before mutation', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: true, result: { worktree: { id: 'wrong', path: '/definitely/another/worktree' } } }));`);
  try {
    await assert.rejects(preflight(fixture), (error: unknown) => error instanceof OrcaError && error.code === 'orca_wrong_worktree' && !error.ambiguous);
  } finally { await fixture.clean(); }
});

test('structured selector failures are definite and preserve the runtime message', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: false, error: { code: 'selector_not_found', message: 'Workspace was removed' } })); process.exitCode = 1;`);
  try {
    await assert.rejects(launchTerminal({ placement: 'tab', ...fixture, title: 'task', command: 'pi' }), (error: unknown) =>
      error instanceof OrcaError && !error.ambiguous && error.message === 'Workspace was removed');
  } finally { await fixture.clean(); }
});

test('timeout after creation may have reached the host, and is not retried', async () => {
  const fixture = await mockCli(String.raw`
    const fs = require('node:fs');
    fs.appendFileSync(__dirname + '/calls', 'called\n');
    setInterval(() => {}, 1000);
  `);
  try {
    await assert.rejects(launchTerminal({ placement: 'tab', ...fixture, title: 'task', command: 'pi', timeoutMs: 300 }), (error: unknown) =>
      error instanceof OrcaError && error.code === 'orca_timeout' && error.ambiguous);
    assert.equal(await readFile(join(fixture.cwd, 'calls'), 'utf8'), 'called\n');
  } finally { await fixture.clean(); }
});

test('malformed creation response is ambiguous, while malformed preflight is not', async () => {
  const fixture = await mockCli(`console.log('not JSON');`);
  try {
    await assert.rejects(launchTerminal({ placement: 'tab', ...fixture, title: 'task', command: 'pi' }), (error: unknown) =>
      error instanceof OrcaError && error.ambiguous && error.code === 'orca_invalid_response');
    await assert.rejects(preflight(fixture), (error: unknown) =>
      error instanceof OrcaError && !error.ambiguous && error.code === 'orca_invalid_response');
  } finally { await fixture.clean(); }
});

test('missing CLI executable is a definite failure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-orca-cli-'));
  try {
    await assert.rejects(launchTerminal({ placement: 'tab', cwd, orcaCommand: join(cwd, 'missing'), title: 'task', command: 'pi' }), (error: unknown) =>
      error instanceof OrcaError && error.code === 'ENOENT' && !error.ambiguous);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('preflight refuses a known remote execution host despite an identical path', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: true, result: { worktree: {
    id: 'remote-repo::' + __dirname, path: __dirname, hostId: 'ssh:another-machine'
  } } }));`);
  try {
    await assert.rejects(preflight(fixture), (error: unknown) =>
      error instanceof OrcaError && error.code === 'orca_remote_worktree' && !error.ambiguous);
  } finally { await fixture.clean(); }
});

test('switch targets only the explicitly selected terminal', async () => {
  const fixture = await mockCli(`
    const fs = require('node:fs');
    fs.writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, result: { focus: { handle: 'term-selected' } } }));
  `);
  try {
    await switchTerminal({ ...fixture, handle: 'term-selected' });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.cwd, 'args.json'), 'utf8')), [
      'terminal', 'switch', '--terminal', 'term-selected', '--json',
    ]);
  } finally { await fixture.clean(); }
});

test('resolves the Orca CLI from Orca variables and OS defaults only', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'pi-orca-path-'));
  const orcaIde = join(bin, 'orca-ide');
  const orca = join(bin, 'orca');
  await writeFile(orcaIde, '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(orca, '#!/bin/sh\n', { mode: 0o700 });
  try {
    const env = { PATH: `${bin}:/usr/bin` };
    assert.equal(resolveOrcaCommand(env, 'linux'), orcaIde);
    assert.equal(resolveOrcaCommand({ ...env, ORCA_CLI_COMMAND: ' /opt/orca ' }, 'linux'), '/opt/orca');
    assert.equal(resolveOrcaCommand({ ...env, ORCA_DEV_REPO_ROOT: '/repo' }, 'linux'), 'orca-dev');
    // A PATH without the platform CLI must resolve to nothing, never to another binary.
    assert.equal(resolveOrcaCommand({ PATH: '/nonexistent' }, 'linux'), undefined);
    // macOS and Windows use `orca`, never the Linux-only `orca-ide`.
    assert.equal(resolveOrcaCommand(env, 'darwin'), orca);
    assert.equal(resolveOrcaCommand({ PATH: '/nonexistent' }, 'darwin'), undefined);
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test('resolves Windows batch shims through PATHEXT instead of falling back to a bare name', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'pi-orca-win-'));
  const shim = join(bin, 'orca.cmd');
  await writeFile(shim, '@echo off\r\n', { mode: 0o700 });
  try {
    assert.equal(resolveOrcaCommand({ PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'), shim);
    assert.equal(resolveOrcaCommand({ PATH: bin, PATHEXT: '.EXE;.COM' }, 'win32'), undefined);
    assert.equal(resolveOrcaCommand({ PATH: bin }, 'win32'), shim);
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test('spawns Windows batch shims through cmd.exe without dropping or mangling arguments', () => {
  const command = 'C:\\Program Files\\Orca\\orca.cmd';
  const args = ['terminal', 'create', '--title', 'pi: 案B & more', '--json'];
  const plan = orcaSpawnPlan(command, args, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32');
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  const payload = plan.args[3]!;
  // The documented cmd.exe /s /c shape: one quoted command line, ^-escaped.
  assert.ok(payload.startsWith('"^\\"C:\\Program^ Files'));
  assert.ok(payload.endsWith('"'));
  assert.ok(payload.includes('^&'));
  assert.ok(payload.includes('pi:^ 案B'));
  assert.ok(payload.includes('^"terminal^"'));

  // Real executables and PowerShell scripts are spawned without cmd.exe.
  assert.deepEqual(orcaSpawnPlan('C:\\Orca\\orca.exe', args, {}, 'win32'), { file: 'C:\\Orca\\orca.exe', args, verbatim: false });
  assert.deepEqual(orcaSpawnPlan('C:\\Orca\\orca.ps1', ['status'], {}, 'win32'), {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-File', 'C:\\Orca\\orca.ps1', 'status'],
    verbatim: false,
  });
  assert.deepEqual(orcaSpawnPlan('orca-ide', args, {}, 'linux'), { file: 'orca-ide', args, verbatim: false });
});

test('a missing Linux CLI reports the fix instead of falling back to the screen reader', { skip: process.platform !== 'linux' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-orca-cli-'));
  const saved = {
    PATH: process.env.PATH,
    ORCA_CLI_COMMAND: process.env.ORCA_CLI_COMMAND,
    ORCA_DEV_REPO_ROOT: process.env.ORCA_DEV_REPO_ROOT,
  };
  // A PATH without orca-ide and no Orca variables must fail, never fall back to /usr/bin/orca.
  process.env.PATH = join(cwd, 'empty');
  delete process.env.ORCA_CLI_COMMAND;
  delete process.env.ORCA_DEV_REPO_ROOT;
  try {
    await assert.rejects(preflight({ cwd, timeoutMs: 1_000 }), (error: unknown) =>
      error instanceof OrcaError && error.code === 'orca_cli_missing' && !error.ambiguous);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('close reports the closed tab and never invents a missing confirmation', async () => {
  const fixture = await mockCli(`
    const fs = require('node:fs');
    fs.writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, result: { close: { handle: 'term-closed', ptyKilled: true } } }));
  `);
  try {
    await closeTerminal({ ...fixture, handle: 'term-closed' });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.cwd, 'args.json'), 'utf8')), [
      'terminal', 'close', '--terminal', 'term-closed', '--json',
    ]);
    await assert.rejects(closeTerminal({ ...fixture, handle: 'other' }), (error: unknown) =>
      error instanceof OrcaError && error.code === 'orca_invalid_response' && !error.ambiguous);
  } finally { await fixture.clean(); }
});

test('an exited tab surfaces the Orca error code for the caller to ignore', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: false, error: { code: 'terminal_exited', message: 'terminal_exited' } }));`);
  try {
    await assert.rejects(closeTerminal({ ...fixture, handle: 'term-gone' }), (error: unknown) =>
      error instanceof OrcaError && error.code === 'terminal_exited' && !error.ambiguous);
  } finally { await fixture.clean(); }
});

test('split targets the source pane with literal argv and leaves direction and focus to Orca', async () => {
  const fixture = await mockCli(`
    require('node:fs').writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, result: { split: { handle: 'split-child', tabId: 'parent-tab', leafId: 'child-leaf' } } }));
  `);
  try {
    const command = "pi --session '/tmp/quote ; $(touch INJECTED).jsonl'";
    assert.deepEqual(await launchTerminal({ ...fixture, sourceTerminalHandle: 'source-pane', title: 'task', command }), { handle: 'split-child' });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.cwd, 'args.json'), 'utf8')), ['terminal', 'split', '--terminal', 'source-pane', '--command', command, '--json']);
  } finally { await fixture.clean(); }
});

test('split refuses missing source identity without invoking the CLI', async () => {
  const fixture = await mockCli(`require('node:fs').writeFileSync(__dirname + '/called', 'yes');`);
  try {
    await assert.rejects(launchTerminal({ ...fixture, sourceTerminalHandle: '', title: 'task', command: 'pi' }), (error: unknown) => error instanceof OrcaError && error.code === 'orca_source_missing' && !error.ambiguous);
    await assert.rejects(readFile(join(fixture.cwd, 'called')), { code: 'ENOENT' });
  } finally { await fixture.clean(); }
});

test('split distinguishes definite stale sources from ambiguous creation failures', async () => {
  for (const [code, ambiguous] of [['terminal_handle_stale', false], ['terminal_exited', false], ['terminal_split_source_not_found', true]] as const) {
    const fixture = await mockCli(`console.log(JSON.stringify({ ok: false, error: { code: '${code}', message: 'split failed' } }));`);
    try {
      await assert.rejects(launchTerminal({ ...fixture, sourceTerminalHandle: 'source', title: 'task', command: 'pi' }), (error: unknown) => error instanceof OrcaError && error.code === code && error.ambiguous === ambiguous);
    } finally { await fixture.clean(); }
  }
});

test('split success without a child handle is ambiguous', async () => {
  const fixture = await mockCli(`console.log(JSON.stringify({ ok: true, result: { split: { tabId: 'tab' } } }));`);
  try {
    await assert.rejects(launchTerminal({ ...fixture, sourceTerminalHandle: 'source', title: 'task', command: 'pi' }), (error: unknown) => error instanceof OrcaError && error.ambiguous);
  } finally { await fixture.clean(); }
});
