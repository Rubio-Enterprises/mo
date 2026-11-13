const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summary, readMember, comment, select } = require('./coverage-report.cjs');
const repo = { owner: 'Rubio-Enterprises', repo: 'mo' };
const commit = 'a'.repeat(40);
const run = { id: 1, run_attempt: 1, repository: { full_name: 'Rubio-Enterprises/mo' }, head_repository: { full_name: 'Rubio-Enterprises/mo' }, head_sha: commit, name: 'Test Gate', path: '.github/workflows/test-gate.yml', event: 'pull_request', conclusion: 'success' };
const pull = { number: 407, state: 'open', head: { sha: commit, repo: { full_name: 'Rubio-Enterprises/mo' } }, base: { ref: 'main', sha: commit } };
const main = { ...run, name: 'standards', path: '.github/workflows/standards.yml', event: 'push', head_branch: 'main' };
const numbers = { covered: 8, total: 10, code: 20, test: 40 };
function api(responses) {
  return {
    rest: { repos: { listPullRequestsAssociatedWithCommit: 'pulls' }, actions: { listWorkflowRunArtifacts: 'artifacts', listWorkflowRunsForRepo: 'runs' }, git: { getCommit: async ({ commit_sha }) => ({ data: { tree: { sha: responses.trees[commit_sha] } } }) } },
    paginate: async (endpoint) => responses[endpoint] || [],
  };
}
test('API binds the current same-repository PR', async () => {
  assert.equal((await select(api({ pulls: [pull] }), repo, run, 'main')).pull, 407);
});
test('stale, closed and fork PRs are not commented on', async () => {
  for (const p of [{ ...pull, state: 'closed' }, { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } }, { ...pull, head: { ...pull.head, repo: { full_name: 'outside/mo' } } }]) assert.equal(await select(api({ pulls: [p] }), repo, run, 'main'), null);
});
test('head_repository blocks both PR and main fork triggers even with matching repository', async () => {
  for (const candidate of [run, main]) assert.equal(await select(api({ pulls: [pull] }), repo, { ...candidate, head_repository: { full_name: 'outside/mo' } }, 'main'), null);
});
test('main artifact selection does not hardcode a concern list', async () => {
  assert.equal((await select(api({ artifacts: [{ name: 'test-gate-linux-test-typecheck-reports-1' }] }), repo, main, 'main')).run.id, 1);
});
for (const [label, tree, headRepository, succeeds] of [['identical tree', 'tree', 'Rubio-Enterprises/mo', true], ['different tree', 'different', 'Rubio-Enterprises/mo', false], ['fork-triggered evidence', 'tree', 'outside/mo', false]]) {
  test(`reused-run lookup: ${label}`, async () => {
    const head = 'b'.repeat(40);
    const merged = { ...pull, merged_at: '2026-11-13', merge_commit_sha: commit, head: { ...pull.head, sha: head } };
    const result = select(api({ pulls: [merged], trees: { [commit]: 'tree', [head]: tree }, runs: [{ ...run, id: 2, head_sha: head, head_repository: { full_name: headRepository } }] }), repo, main, 'main');
    if (succeeds) assert.equal((await result).run.id, 2);
    else await assert.rejects(result, /no coverage artifact/);
  });
}
function read(t, content, extras = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-summary-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'reports.zip');
  const entries = content === undefined ? extras : [['coverage/summary.json', content], ...extras];
  execFileSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:\n for name,value in json.load(sys.stdin): z.writestr(name,value)', archive], { input: JSON.stringify(entries) });
  return summary(readMember(archive, 'coverage/summary.json'));
}
test('schema reader accepts numeric summaries and ignores unrelated ZIP members', (t) => {
  assert.deepEqual(read(t, JSON.stringify(numbers), [['../payload.sh', 'exit 1'], ['coverage/metrics.json', '{not parsed}']]), numbers);
});
for (const [label, content] of [
  ['oversize', JSON.stringify(numbers) + ' '.repeat(4096)],
  ['fractional integer', JSON.stringify({ ...numbers, test: 1.5 })],
  ['negative', JSON.stringify({ ...numbers, covered: -1 })],
  ['covered greater than total', JSON.stringify({ ...numbers, covered: 11 })],
  ['missing member', undefined],
  ['missing field', '{"covered":1}'],
  ['extra field', JSON.stringify({ ...numbers, filename: 'untrusted' })],
  ['unsafe integer', JSON.stringify({ ...numbers, total: 2**53 })],
  ['numeric string', JSON.stringify({ ...numbers, total: '10' })],
  ['nonfinite integer', '{"covered":1,"total":1e999,"code":1,"test":1}'],
]) test(`schema reader rejects ${label}`, (t) => assert.throws(() => read(t, content)));
test('zero totals remain finite in the fixed-text comment', () => {
  const zero = summary({ covered: 0, total: 0, code: 0, test: 0 });
  assert.doesNotMatch(comment(zero, zero, 0), /NaN|Infinity/);
});
test('comment posts only fixed text and numeric metrics', () => {
  const body = comment(numbers, { ...numbers, covered: 7 }, 10);
  assert.match(body, /80.00%/);
  assert.match(body, /10.00 pp/);
  assert.match(body, /mo-central-coverage/);
});
test('real summary producer matches octocov totals from this repository Go and frontend output', () => {
  execFileSync('sh', ['bin/coverage-summary.sh'], { stdio: 'pipe' });
  const raw = JSON.parse(fs.readFileSync('reports/coverage/metrics.json', 'utf8'));
  assert.ok(raw.coverage.files.some((f) => f.file.endsWith('.go')));
  assert.ok(raw.coverage.files.some((f) => /\.tsx?$/.test(f.file)));
  const actual = summary(JSON.parse(fs.readFileSync('reports/coverage/summary.json', 'utf8')));
  assert.deepEqual(actual, { covered: raw.coverage.covered, total: raw.coverage.total, code: raw.code_to_test_ratio.code, test: raw.code_to_test_ratio.test });
  assert.ok(actual.total > 0 && actual.code > 0 && actual.test > 0);
});
