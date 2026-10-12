import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { readOnlyShell } from '../server/readonly';
import { decidePermission } from '../server/permissions';
import { createLifecycleHooks, type LifecycleHookDeps } from '../server/lifecycle-hooks';

/** Anonymous gate-only repro: never dispatch a Git command or helper. */
function reproduceShortValues(mode: string) {
  assert.ok(['before', 'after'].includes(mode));
  const prefix = 'git --no-pager -c core.fsmonitor=false log ';
  const guards = '--no-ext-diff --no-textconv --no-show-signature --oneline';
  for (const option of ['-n', '-S', '-G']) {
    for (const [args, expected] of [[`${option} -- ${guards}`, mode === 'before'], [`${guards} ${option}`, false]] as const) {
      const command = prefix + args, allow = readOnlyShell(command);
      assert.equal(allow, expected, command);
      console.log(JSON.stringify({ layer: 'anonymous gate only', command, allow, handlerExecuted: false, mode }));
    }
  }
}

function fingerprint(directory: string) {
  return readdirSync(directory, { recursive: true }).sort().map(name => {
    const path = join(directory, String(name)), info = statSync(path);
    return { name, mode: info.mode, mtimeMs: info.mtimeMs, size: info.size,
      sha256: info.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null };
  });
}

/** Real local handlers behind the production hook; all provider replies are synthetic. */
export async function verifyReadonlyP2(directory: string, requireCaseSensitive = false) {
  const parent = realpathSync(resolve(process.env.KANBAN_TMP ?? process.env.TMPDIR ?? tmpdir()));
  const dir = join(realpathSync(dirname(resolve(directory))), directory.split(sep).at(-1)!);
  const rel = relative(parent, dir);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  mkdirSync(dir);
  const repo = join(dir, 'repo'), home = join(dir, 'IsolatedHome'), lowerHome = join(dir, 'isolatedhome');
  mkdirSync(repo); mkdirSync(home);
  writeFileSync(join(home, 'fake-auth.txt'), 'ARTIFICIAL CREDENTIAL-LIKE TEXT\n', { mode: 0o600 });
  const insensitive = existsSync(lowerHome) && statSync(home).ino === statSync(lowerHome).ino;
  if (requireCaseSensitive) assert.equal(insensitive, false, 'A real case-sensitive volume is required');
  if (!insensitive) { mkdirSync(lowerHome); writeFileSync(join(lowerHome, 'fake-auth.txt'), 'permitted artificial case-distinct reference\n', { mode: 0o640 }); }
  writeFileSync(join(repo, 'sentinel.txt'), 'unchanged artificial sentinel\n', { mode: 0o640 });
  writeFileSync(join(repo, '.gitattributes'), 'data.txt diff=artificial\n');
  writeFileSync(join(repo, 'helper.sh'), '#!/bin/sh\nprintf called > helper-ran\ncat "$1"\n', { mode: 0o700 });
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result;
  };
  git(['init', '-q']);
  writeFileSync(join(repo, 'data.txt'), 'old artificial text\n');
  git(['add', '.gitattributes', 'data.txt']); git(['commit', '-qm', 'artificial baseline']);
  writeFileSync(join(repo, 'data.txt'), 'new artificial text\n');
  git(['add', 'data.txt']); git(['commit', '-qm', 'artificial change']);
  for (const key of ['diff.artificial.textconv', 'diff.external', 'core.fsmonitor', 'core.pager']) git(['config', key, join(repo, 'helper.sh')]);
  git(['config', 'log.showSignature', 'true']);
  git(['config', 'format.pretty', 'artificial']);
  git(['config', 'pretty.artificial', 'format:%G?']);
  const before = fingerprint(dir), responses: any[] = [], events: unknown[] = [];
  let role = 'reviewer', autoAccept = false;
  const readScope = { taskId: 1, workspace: repo, roots: [], temporaryRoot: dir };
  const hooks = createLifecycleHooks({ hookObjects: { agent: () => true }, bind() {},
    permissionContext: () => ({ kanban: true, role, autoAccept, taskId: 1, readScope }),
    decidePermission, addComment() {}, appendEvent() {}, console: { error(message: unknown) { throw Error(String(message)); } },
  } as unknown as LifecycleHookDeps);
  const context = { paseo: { agents: { ref: () => ({ respondToPermission: async (reply: unknown) => { responses.push(reply); } }) } } };
  async function attempt(request: AgentPermissionRequest, expected: string, handler?: () => unknown) {
    await hooks.permission({ agent: { id: 'artificial-p2-agent' }, request } as never, context as never);
    const response = responses.at(-1)?.response;
    assert.equal(response?.behavior, expected, JSON.stringify(request));
    // The assertion precedes dispatch: denied inputs never get a handler.
    const result = response.behavior === 'allow' && handler ? handler() : null;
    assert.deepEqual(fingerprint(dir), before, `${request.id}: directory/hash/mtime/mode changed`);
    assert.equal(existsSync(join(repo, 'helper-ran')), false);
    events.push({ role, autoAccept, request, response, handlerExecuted: result !== null, handlerResult: result, unchanged: true });
  }
  const prefix = ['--no-pager', '-c', 'core.fsmonitor=false', 'log'];
  const guards = ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--oneline'];
  const patches = [['-1', '--oneline'], ['-p'], ['--patch'], ['-u'], ['--cc'], ['-c'], ['-U3'], ['-U'], ['--word-diff'], ['-W'], ['--function-context'], ['--raw'], ['-puW']];
  for (autoAccept of [false, true]) {
    for (const patch of patches) {
      for (const args of [[...prefix, ...patch, '-1'], [...prefix, ...guards, ...patch, '-1'], [...prefix, ...patch, ...guards, '-1']]) {
        const safe = args.includes('--no-textconv');
        await attempt({ id: `git-${events.length}`, provider: 'synthetic', kind: 'tool', name: 'execute', detail: { type: 'shell', command: 'git ' + args.join(' ') } } as AgentPermissionRequest,
          safe ? 'allow' : 'deny', safe ? () => {
            const result = git(args); assert.ok(result.stdout.trim(), 'safe history must produce content');
            if (['-p', '--patch', '-u', '-U3', '-U', '-puW'].includes(patch[0])) {
              assert.ok(result.stdout.includes('-old artificial text')); assert.ok(result.stdout.includes('+new artificial text'));
            }
            return { exitCode: result.status, stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: createHash('sha256').update(result.stdout).digest('hex') };
          } : undefined);
      }
    }
    // Separated required short values cannot swallow the option terminator.
    for (const option of ['-n', '-S', '-G', '-pn', '-pS', '-pG']) {
      for (const options of [[option, '--', ...guards], [...guards, option, '--'], [...guards, option]]) {
        await attempt({ id: `short-value-${events.length}`, provider: 'synthetic', kind: 'tool', name: 'execute', detail: { type: 'shell', command: 'git ' + [...prefix, ...options].join(' ') } } as AgentPermissionRequest, 'deny');
      }
    }
    for (const options of [['-n', '1'], ['-S', 'new'], ['-G', 'new'], ['-n1'], ['-Snew'], ['-Gnew'], ['-p', '-n', '1'], ['-p', '-S', 'new'], ['-p', '-G', 'new'], ['-p', '-n1'], ['-p', '-Snew'], ['-p', '-Gnew'], ['-S--'], ['-G--']]) {
      const args = [...prefix, ...guards, ...options];
      await attempt({ id: `short-value-safe-${events.length}`, provider: 'synthetic', kind: 'tool', name: 'execute', detail: { type: 'shell', command: 'git ' + args.join(' ') } } as AgentPermissionRequest, 'allow', () => {
        const result = git(args);
        if (!options[0].endsWith('--')) assert.ok(result.stdout.trim(), 'safe history output must be nonempty');
        return { exitCode: result.status, stdoutNonempty: Boolean(result.stdout.trim()) };
      });
    }
    for (const tail of [['--textc'], ['--ext-dif'], ['--no-no-textconv'], ['--no-no-ext-diff'], ['--textconv'], ['--ext-diff']]) {
      for (const args of [[...prefix, ...guards, '-u', ...tail], [...prefix, ...tail, '-u', ...guards]]) {
        await attempt({ id: `override-${events.length}`, provider: 'synthetic', kind: 'tool', name: 'execute', detail: { type: 'shell', command: 'git ' + args.join(' ') } } as AgentPermissionRequest, 'deny');
      }
    }
    for (const options of [['-u', '--', ...guards], ['--no-show-signature', '--oneline', '--no-ext-diff', '-S', '--no-textconv', '-u'], ['--no-show-signature', '--oneline', '--no-textconv', '--format', '--no-ext-diff', '-u']]) {
      await attempt({ id: `consumed-${events.length}`, provider: 'synthetic', kind: 'tool', name: 'execute', detail: { type: 'shell', command: 'git ' + [...prefix, ...options].join(' ') } } as AgentPermissionRequest, 'deny');
    }
  }
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (role of ['reader', 'decision']) for (autoAccept of [false, true]) {
      for (const search of [false, true]) for (const [path, expected] of [
        [join(home, 'fake-auth.txt'), 'deny'], [join(lowerHome, 'fake-auth.txt'), insensitive ? 'deny' : 'allow'],
        [join(repo, 'sentinel.txt'), 'allow'], [dir, 'deny'],
      ]) {
        const kind = search ? 'search' : 'read';
        const actualExpected = !search && path === dir ? 'deny' : expected;
        const request = { id: `home-${events.length}`, provider: 'antigravity', name: kind, kind: 'tool',
          detail: search ? { type: kind, query: 'artificial', filePaths: [path] } : { type: kind, filePath: path },
          metadata: { rawRequest: { toolCall: { kind, rawInput: search ? { path, pattern: 'artificial' } : { path }, locations: [{ path }] } } } } as AgentPermissionRequest;
        await attempt(request, actualExpected, actualExpected === 'allow' ? () => {
          const text = readFileSync(path, 'utf8'); assert.ok(text.includes('artificial')); return search ? text.includes('artificial') : 'artificial read completed';
        } : undefined);
      }
      // Alias roots must not turn the host's excluded HOME or all tmp into a grant.
      const ordinary = { id: `root-${events.length}`, provider: 'antigravity', name: 'read', kind: 'tool', detail: { type: 'read', filePath: join(repo, 'sentinel.txt') }, metadata: { rawRequest: { toolCall: { kind: 'read', rawInput: { path: join(repo, 'sentinel.txt') } } } } } as AgentPermissionRequest;
      for (const root of [home, ...(insensitive ? [lowerHome] : []), '/TMP', join(dir, 'nonexistent')]) {
        assert.equal(decidePermission({ kanban: true, role, autoAccept, readScope: { ...readScope, roots: [root] }, request: ordinary }).action, 'deny');
      }
    }
  } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }
  return { evidenceLayer: 'production hook, synthetic provider replies, real local Git/read/search handlers', realProviderEvent: false, realAcpLifecycle: false, insensitive, cases: events.length,
    allow: responses.filter(r => r.response.behavior === 'allow').length, deny: responses.filter(r => r.response.behavior === 'deny').length, baseline: before, unchanged: true, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === '--short-values-before' || mode === '--short-values-after') {
    reproduceShortValues(mode.endsWith('before') ? 'before' : 'after');
  } else if (mode === '--fixture' || mode === '--case-sensitive') {
    assert.ok(directory); console.log(JSON.stringify(await verifyReadonlyP2(directory, mode === '--case-sensitive'), null, 2));
  } else throw new Error('Use --fixture, --case-sensitive, --short-values-before or --short-values-after');
}
