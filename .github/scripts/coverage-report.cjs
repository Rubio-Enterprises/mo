const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIMIT = 32 * 1024 * 1024;
const BASELINE = 'central-coverage-baseline';
const MARKER = '<!-- mo-central-coverage -->';
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const sha = (s) => /^[a-f0-9]{40}$/.test(s);
const gate = (r) => r.name === 'Test Gate' && r.path === '.github/workflows/test-gate.yml' && r.event === 'pull_request' && r.conclusion === 'success';

function metrics(report) {
  const { total, covered } = report.coverage || {};
  const { code, test } = report.code_to_test_ratio || {};
  if (![total, covered, code, test].every(integer) || !total || !code || covered > total) {
    throw new Error('Missing or invalid coverage or code-to-test metrics');
  }
  return { total, covered, code, test };
}

function comment(current, baseline, seconds) {
  const percent = (m) => 100 * m.covered / m.total;
  const ratio = (m) => m.test / m.code;
  return `${MARKER}\n## Central Test Gate coverage\n\n` +
    '| Metric | Current | Main | Difference |\n| :-- | --: | --: | --: |\n' +
    `| Coverage | ${percent(current).toFixed(2)}% | ${baseline ? percent(baseline).toFixed(2) + '%' : 'Not established'} | ${baseline ? (percent(current) - percent(baseline)).toFixed(2) + ' pp' : 'Not established'} |\n` +
    `| Test/code ratio | ${ratio(current).toFixed(3)} | ${baseline ? ratio(baseline).toFixed(3) : 'Not established'} | ${baseline ? (ratio(current) - ratio(baseline)).toFixed(3) : 'Not established'} |\n` +
    `| Covered / total | ${current.covered} / ${current.total} | ${baseline ? baseline.covered + ' / ' + baseline.total : 'Not established'} | |\n` +
    `\nLinux Lifecycle execution: ${seconds} seconds.\n\n` +
    'Measured by octocov from validated Test Gate coverage. Separate from the legacy test workflow report.\n';
}

async function select(github, repo, run, defaultBranch) {
  if (run.repository.full_name !== `${repo.owner}/${repo.repo}` || !sha(run.head_sha) || !integer(run.id)) {
    throw new Error('Unexpected source repository, commit or run');
  }
  if (run.conclusion !== 'success') return null;
  if (gate(run)) {
    const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...repo, commit_sha: run.head_sha, per_page: 100 });
    const matches = pulls.filter((p) => p.state === 'open' && p.head.sha === run.head_sha && p.head.repo?.full_name === run.repository.full_name && p.base.ref === defaultBranch);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('Ambiguous pull request for coverage');
    return { run, commit: run.head_sha, pull: matches[0].number, base: matches[0].base.sha };
  }
  if (run.path !== '.github/workflows/standards.yml' || run.event !== 'push' || run.head_branch !== defaultBranch) return null;
  const own = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
  if (own.some((a) => /^test-gate-linux-.*-reports-\d+$/.test(a.name))) return { run, commit: run.head_sha };

  // Reused verification has no fresh artifact. Require exactly the same Git tree.
  const main = await github.rest.git.getCommit({ ...repo, commit_sha: run.head_sha });
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...repo, commit_sha: run.head_sha, per_page: 100 });
  for (const pull of pulls.filter((p) => p.merged_at && p.merge_commit_sha === run.head_sha && p.head.repo?.full_name === run.repository.full_name)) {
    const head = await github.rest.git.getCommit({ ...repo, commit_sha: pull.head.sha });
    if (head.data.tree.sha !== main.data.tree.sha) continue;
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { ...repo, head_sha: pull.head.sha, event: 'pull_request', per_page: 100 });
    const source = runs.find(gate);
    if (source) return { run: source, commit: run.head_sha };
  }
  throw new Error('Verified main has no coverage artifact or exact-tree PR artifact');
}

async function bytes(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.data) {
    length += chunk.length;
    if (length > LIMIT) throw new Error('Download exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function download(github, repo, artifact, destination) {
  if (artifact.expired || artifact.size_in_bytes > LIMIT) throw new Error('Expired or oversized coverage artifact');
  const response = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: 'zip', request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(60000) } });
  fs.writeFileSync(destination, await bytes(response), { mode: 0o600 });
}

function validator(...args) {
  return execFileSync('python3', [path.join(__dirname, 'coverage-input.py'), ...args], { encoding: 'utf8', maxBuffer: LIMIT, timeout: 60000 });
}

async function prepare({ github, context, core }) {
  const repo = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const selected = await select(github, repo, context.payload.workflow_run, defaultBranch);
  if (!selected) { core.setOutput('selected', 'false'); return; }
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: selected.run.id, per_page: 100 });
  const reports = artifacts.filter((a) => a.name === `test-gate-linux-test-typecheck-e2e-package-reports-${selected.run.run_attempt}`);
  if (reports.length !== 1) throw new Error('Expected one current-attempt Linux reports artifact');
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'mo-coverage-'));
  await download(github, repo, reports[0], path.join(directory, 'reports.zip'));
  const archive = await github.rest.repos.downloadZipballArchive({ ...repo, ref: selected.run.head_sha, request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(60000) } });
  fs.writeFileSync(path.join(directory, 'source.zip'), await bytes(archive), { mode: 0o600 });
  validator(path.join(directory, 'source.zip'), path.join(directory, 'reports.zip'), path.join(directory, 'source'));
  fs.copyFileSync(path.join(__dirname, '..', 'coverage-gate.yml'), path.join(directory, 'source', '.octocov.yml'), fs.constants.COPYFILE_EXCL);
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, { ...repo, run_id: selected.run.id, attempt_number: selected.run.run_attempt, per_page: 100 });
  const steps = jobs.filter((j) => j.name.endsWith('test-gate-linux')).flatMap((j) => j.steps || []).filter((s) => s.name === 'Run Lifecycle Scripts');
  if (steps.length !== 1 || steps[0].conclusion !== 'success') throw new Error('Missing Linux Lifecycle timing');
  const seconds = Math.round((Date.parse(steps[0].completed_at) - Date.parse(steps[0].started_at)) / 1000);
  if (!integer(seconds) || seconds > 7200) throw new Error('Invalid Lifecycle timing');
  fs.writeFileSync(path.join(directory, 'selection.json'), JSON.stringify({ ...selected, seconds, defaultBranch }));
  core.setOutput('selected', 'true');
  core.setOutput('directory', directory);
  core.setOutput('baseline', selected.pull ? 'false' : 'true');
}

async function finish({ github, context, core }, directory) {
  const selected = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8'));
  const current = metrics(JSON.parse(fs.readFileSync(path.join(directory, 'source', 'metrics.json'), 'utf8')));
  let baseline = null;
  if (selected.pull) {
    const pulls = await github.rest.pulls.get({ ...context.repo, pull_number: selected.pull });
    if (pulls.data.head.sha !== selected.commit || pulls.data.state !== 'open') return;
    const candidates = await github.paginate(github.rest.actions.listArtifactsForRepo, { ...context.repo, name: BASELINE, per_page: 100 });
    for (const artifact of candidates.filter((a) => !a.expired).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
      const producer = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: artifact.workflow_run.id })).data;
      if (producer.path !== '.github/workflows/coverage.yml' || producer.event !== 'workflow_run' || producer.head_branch !== selected.defaultBranch || producer.conclusion !== 'success') continue;
      const zip = path.join(directory, 'baseline.zip');
      await download(github, context.repo, artifact, zip);
      const saved = JSON.parse(validator('--baseline', zip));
      if (!sha(saved.commit)) throw new Error('Invalid baseline commit');
      const comparison = await github.rest.repos.compareCommits({ ...context.repo, base: saved.commit, head: selected.base });
      if (!['identical', 'ahead'].includes(comparison.data.status)) continue;
      baseline = metrics(saved);
      break;
    }
    const body = comment(current, baseline, selected.seconds);
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: selected.pull, per_page: 100 });
    const previous = comments.find((c) => c.user.login === 'github-actions[bot]' && c.body.startsWith(MARKER));
    if (previous) await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
    else await github.rest.issues.createComment({ ...context.repo, issue_number: selected.pull, body });
    await core.summary.addRaw(body).write();
  } else {
    fs.writeFileSync(path.join(directory, 'baseline.json'), JSON.stringify({ coverage: { total: current.total, covered: current.covered }, code_to_test_ratio: { code: current.code, test: current.test }, commit: selected.commit, source_run: selected.run.id }));
    await core.summary.addRaw(comment(current, null, selected.seconds)).write();
  }
}

module.exports = { metrics, comment, select, prepare, finish };
