const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { metrics, comment, select } = require('./coverage-report.cjs');

const repo = { owner: 'Rubio-Enterprises', repo: 'mo' };
const commit = 'a'.repeat(40);
const run = { id: 1, repository: { full_name: 'Rubio-Enterprises/mo' }, head_sha: commit, name: 'Test Gate', path: '.github/workflows/test-gate.yml', event: 'pull_request', conclusion: 'success' };
const pull = { number: 407, state: 'open', head: { sha: commit, repo: { full_name: 'Rubio-Enterprises/mo' } }, base: { ref: 'main', sha: commit } };
const main = { ...run, name: 'standards', path: '.github/workflows/standards.yml', event: 'push', head_branch: 'main' };

function api(responses) {
  return {
    rest: { repos: { listPullRequestsAssociatedWithCommit: 'pulls' }, actions: { listWorkflowRunArtifacts: 'artifacts', listWorkflowRunsForRepo: 'runs' }, git: { getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: responses.trees[commit_sha] } } }) } },
    paginate: async (endpoint) => responses[endpoint] || [],
  };
}

test('binds a current same-repository PR using the API, not artifact metadata', async () => {
  const selected = await select(api({ pulls: [pull] }), repo, run, 'main');
  assert.equal(selected.pull, 407);
});
test('does not comment on stale, closed or fork PRs', async () => {
  for (const p of [{ ...pull, state: 'closed' }, { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } }, { ...pull, head: { ...pull.head, repo: { full_name: 'outside/mo' } } }]) {
    assert.equal(await select(api({ pulls: [p] }), repo, run, 'main'), null);
  }
});
test('rejects a different source repository', async () => {
  await assert.rejects(select(api({}), repo, { ...run, repository: { full_name: 'outside/mo' } }, 'main'));
});
test('uses the main verification artifact when execution was required', async () => {
  assert.equal((await select(api({ artifacts: [{ name: 'test-gate-linux-test-reports-1' }] }), repo, main, 'main')).run.id, 1);
});
test('reused verification uses a passing PR artifact only for the identical Git tree', async () => {
  const head = 'b'.repeat(40);
  const merged = { ...pull, merged_at: '2026-11-13', merge_commit_sha: commit, head: { ...pull.head, sha: head } };
  const selected = await select(api({ pulls: [merged], trees: { [commit]: 'tree', [head]: 'tree' }, runs: [{ ...run, id: 2, head_sha: head }] }), repo, main, 'main');
  assert.equal(selected.run.id, 2);
  assert.equal(selected.commit, commit);
});
test('rejects a reused artifact for different files', async () => {
  const head = 'b'.repeat(40);
  const merged = { ...pull, merged_at: '2026-11-13', merge_commit_sha: commit, head: { ...pull.head, sha: head } };
  await assert.rejects(select(api({ pulls: [merged], trees: { [commit]: 'main', [head]: 'different' }, runs: [run] }), repo, main, 'main'), /no coverage artifact/);
});
test('rejects absent, negative, nonfinite and out-of-range metrics', () => {
  for (const total of [undefined, NaN, Infinity, -1, 0, 2**53]) {
    assert.throws(() => metrics({ coverage: { total, covered: 1 }, code_to_test_ratio: { code: 2, test: 3 } }));
  }
});
test('comment contains static text and numeric metrics only', () => {
  const current = { total: 10, covered: 8, code: 20, test: 40, filename: '[pwn](https://attacker.example)' };
  const body = comment(current, { ...current, covered: 7 }, 10);
  assert.match(body, /80.00%/);
  assert.match(body, /10.00 pp/);
  assert.match(body, /mo-central-coverage/);
  assert.doesNotMatch(body, /pwn|attacker/);
});

const go = 'package main\nfunc main() {\n println("ok")\n}\n';
const frontend = 'export const x = 1;\n';
const profile = 'mode: count\ngithub.com/k1LoW/mo/main.go:2.13,4.2 1 1\n';
const lcov = 'SF:src/x.ts\nDA:1,1\nend_of_record\n';
function checkArchive(t, { source, reports } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-input-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtures = { source: source || [['root/main.go', go], ['root/internal/frontend/src/x.ts', frontend], ['root/evil.sh', 'exit 1']], reports: reports || [['coverage/go.out', profile], ['coverage/frontend/lcov.info', lcov]] };
  execFileSync('python3', ['-c', `import json,sys,zipfile
from pathlib import Path
for kind, entries in json.load(sys.stdin).items():
 with zipfile.ZipFile(Path(sys.argv[1]) / (kind + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
  for entry in entries:
   info = zipfile.ZipInfo(entry[0])
   info.external_attr = (entry[2] if len(entry) > 2 else 0o100644) << 16
   archive.writestr(info, entry[1], compress_type=zipfile.ZIP_DEFLATED)
`, directory], { input: JSON.stringify(fixtures) });
  const result = spawnSync('python3', [path.join(__dirname, 'coverage-input.py'), path.join(directory, 'source.zip'), path.join(directory, 'reports.zip'), path.join(directory, 'output')], { encoding: 'utf8' });
  return { ...result, directory };
}
test('valid ZIPs produce only inert source and sanitized coverage', (t) => {
  const result = checkArchive(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(result.directory, 'output/evil.sh')), false);
  assert.match(fs.readFileSync(path.join(result.directory, 'output/gate-lcov.info'), 'utf8'), /SF:internal\/frontend\/src\/x.ts/);
});
for (const [label, entries] of [
  ['traversal', [['../outside', 'bad']]],
  ['absolute path', [['/outside', 'bad']]],
  ['duplicate path', [['x', 'a'], ['x', 'b']]],
  ['symlink', [['coverage/go.out', profile, 0o120777]]],
  ['special file', [['coverage/go.out', profile, 0o010644]]],
  ['oversized member', [['large', 'x'.repeat(8 * 1024 * 1024 + 1)]]],
  ['missing frontend', [['coverage/go.out', profile]]],
  ['source escape', [['coverage/go.out', profile.replace('main.go', '../main.go')], ['coverage/frontend/lcov.info', lcov]]],
  ['invalid number', [['coverage/go.out', profile.replace(' 1 1', ' 1 -1')], ['coverage/frontend/lcov.info', lcov]]],
  ['unknown LCOV source', [['coverage/go.out', profile], ['coverage/frontend/lcov.info', lcov.replace('src/x.ts', '../../secret')]]],
  ['invalid LCOV line', [['coverage/go.out', profile], ['coverage/frontend/lcov.info', lcov.replace('DA:1,1', 'DA:999,1')]]],
]) {
  test(`rejects untrusted ${label}`, (t) => {
    const extras = ['traversal', 'absolute path', 'duplicate path', 'symlink', 'special file', 'oversized member'].includes(label);
    const reports = extras ? [['coverage/go.out', profile], ['coverage/frontend/lcov.info', lcov], ...entries.map(([name, text, mode]) => [name === 'coverage/go.out' ? 'extra' : name, text, mode || 0o100644])] : entries;
    assert.notEqual(checkArchive(t, { reports }).status, 0);
  });
}
test('rejects source symlinks instead of reading their targets', (t) => {
  assert.notEqual(checkArchive(t, { source: [['root/main.go', go, 0o120777], ['root/internal/frontend/src/x.ts', frontend]] }).status, 0);
});
