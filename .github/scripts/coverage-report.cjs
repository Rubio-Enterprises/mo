const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const LIMIT = 32 * 1024 * 1024;
const BASELINE = 'central-coverage-baseline';
const MARKER = '<!-- mo-central-coverage -->';
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const sha = (s) => /^[a-f0-9]{40}$/.test(s);
const gate = (r, repo) => r.name === 'Test Gate' && r.path === '.github/workflows/test-gate.yml' && r.event === 'pull_request' && r.conclusion === 'success' && r.head_repository?.full_name === `${repo.owner}/${repo.repo}`;
const reports = (artifact, attempt) => artifact.name.startsWith('test-gate-linux-') && artifact.name.endsWith(`-reports-${attempt}`);

function summary(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'code,covered,test,total' || !Object.values(value).every(integer) || value.covered > value.total) throw new Error('Invalid numeric coverage summary');
  return value;
}

function readMember(archive, member) {
  const bytes = execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z, z.open(sys.argv[2]) as f: sys.stdout.buffer.write(f.read(4097))', archive, member], { maxBuffer: 4097, timeout: 10000 });
  if (bytes.length > 4096) throw new Error('Coverage member exceeds 4 KiB');
  return JSON.parse(bytes.toString('utf8'));
}

function comment(current, baseline, seconds) {
  const percent = (m) => m.total ? 100 * m.covered / m.total : 0;
  const ratio = (m) => m.code ? m.test / m.code : 0;
  return `${MARKER}\n## Central Test Gate coverage\n\n` +
    '| Metric | Current | Main | Difference |\n| :-- | --: | --: | --: |\n' +
    `| Coverage | ${percent(current).toFixed(2)}% | ${baseline ? percent(baseline).toFixed(2) + '%' : 'Not established'} | ${baseline ? (percent(current) - percent(baseline)).toFixed(2) + ' pp' : 'Not established'} |\n` +
    `| Test/code ratio | ${ratio(current).toFixed(3)} | ${baseline ? ratio(baseline).toFixed(3) : 'Not established'} | ${baseline ? (ratio(current) - ratio(baseline)).toFixed(3) : 'Not established'} |\n` +
    `| Covered / total | ${current.covered} / ${current.total} | ${baseline ? baseline.covered + ' / ' + baseline.total : 'Not established'} | |\n` +
    `\nLinux Lifecycle execution: ${seconds} seconds.\n\nMeasured in the unprivileged Test Gate.\n`;
}

async function select(github, repo, run, defaultBranch) {
  if (run.repository.full_name !== `${repo.owner}/${repo.repo}` || !sha(run.head_sha) || !integer(run.id)) throw new Error('Unexpected source repository, commit or run');
  if (run.head_repository?.full_name !== `${repo.owner}/${repo.repo}` || run.conclusion !== 'success') return null;
  if (gate(run, repo)) {
    const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...repo, commit_sha: run.head_sha, per_page: 100 });
    const matches = pulls.filter((p) => p.state === 'open' && p.head.sha === run.head_sha && p.head.repo?.full_name === run.repository.full_name && p.base.ref === defaultBranch);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('Ambiguous pull request for coverage');
    return { run, commit: run.head_sha, pull: matches[0].number, base: matches[0].base.sha };
  }
  if (run.path !== '.github/workflows/standards.yml' || run.event !== 'push' || run.head_branch !== defaultBranch) return null;
  const own = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
  if (own.some((a) => reports(a, run.run_attempt))) return { run, commit: run.head_sha };
  const main = await github.rest.git.getCommit({ ...repo, commit_sha: run.head_sha });
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...repo, commit_sha: run.head_sha, per_page: 100 });
  for (const pull of pulls.filter((p) => p.merged_at && p.merge_commit_sha === run.head_sha)) {
    const head = await github.rest.git.getCommit({ ...repo, commit_sha: pull.head.sha });
    if (head.data.tree.sha !== main.data.tree.sha) continue;
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { ...repo, head_sha: pull.head.sha, event: 'pull_request', per_page: 100 });
    const source = runs.find((r) => gate(r, repo));
    if (source) return { run: source, commit: run.head_sha };
  }
  throw new Error('Verified main has no coverage artifact or exact-tree same-repository PR artifact');
}

async function download(github, repo, artifact, destination) {
  if (artifact.expired || artifact.size_in_bytes > LIMIT) throw new Error('Expired or oversized coverage artifact');
  const response = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: 'zip', request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(60000) } });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.data) {
    length += chunk.length;
    if (length > LIMIT) throw new Error('Download exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  fs.writeFileSync(destination, Buffer.concat(chunks), { mode: 0o600 });
}

async function prepare({ github, context, core }) {
  const repo = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const selected = await select(github, repo, context.payload.workflow_run, defaultBranch);
  if (!selected) { core.setOutput('selected', 'false'); return; }
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: selected.run.id, per_page: 100 });
  const matches = artifacts.filter((a) => reports(a, selected.run.run_attempt));
  if (matches.length !== 1) throw new Error('Expected one current-attempt Linux reports artifact');
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'mo-coverage-'));
  const archive = path.join(directory, 'reports.zip');
  await download(github, repo, matches[0], archive);
  const current = summary(readMember(archive, 'coverage/summary.json'));
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, { ...repo, run_id: selected.run.id, attempt_number: selected.run.run_attempt, per_page: 100 });
  const steps = jobs.filter((j) => j.name.endsWith('test-gate-linux')).flatMap((j) => j.steps || []).filter((s) => s.name === 'Run Lifecycle Scripts');
  if (steps.length !== 1 || steps[0].conclusion !== 'success') throw new Error('Missing Linux Lifecycle timing');
  const seconds = Math.round((Date.parse(steps[0].completed_at) - Date.parse(steps[0].started_at)) / 1000);
  if (!integer(seconds) || seconds > 7200) throw new Error('Invalid Lifecycle timing');
  fs.writeFileSync(path.join(directory, 'selection.json'), JSON.stringify({ ...selected, current, seconds, defaultBranch }));
  core.setOutput('selected', 'true');
  core.setOutput('directory', directory);
  core.setOutput('baseline', selected.pull ? 'false' : 'true');
}

async function finish({ github, context, core }, directory) {
  const selected = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8'));
  const current = summary(selected.current);
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
      const saved = readMember(zip, 'baseline.json');
      if (Object.keys(saved).sort().join(',') !== 'commit,source_run,summary' || !sha(saved.commit) || !integer(saved.source_run)) throw new Error('Invalid baseline metadata');
      summary(saved.summary);
      const comparison = await github.rest.repos.compareCommits({ ...context.repo, base: saved.commit, head: selected.base });
      if (!['identical', 'ahead'].includes(comparison.data.status)) continue;
      baseline = saved.summary;
      break;
    }
    const body = comment(current, baseline, selected.seconds);
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: selected.pull, per_page: 100 });
    const previous = comments.find((c) => c.user.login === 'github-actions[bot]' && c.body.startsWith(MARKER));
    if (previous) await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
    else await github.rest.issues.createComment({ ...context.repo, issue_number: selected.pull, body });
    await core.summary.addRaw(body).write();
  } else {
    fs.writeFileSync(path.join(directory, 'baseline.json'), JSON.stringify({ summary: current, commit: selected.commit, source_run: selected.run.id }));
    await core.summary.addRaw(comment(current, null, selected.seconds)).write();
  }
}

module.exports = { summary, readMember, comment, select, prepare, finish };
