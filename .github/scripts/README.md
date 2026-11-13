# Central coverage reporter

The central Test Gate produces Go coverage and frontend LCOV under
`reports/coverage/`. The separate `coverage.yml` workflow measures that data with
octocov. It never runs the source revision's scripts, dependencies or configuration.

## Trust boundary

- Only default-branch reporter code is checked out. Checkout persists no credential.
- GitHub API metadata binds a successful run to the current same-repository PR head.
  Forks, stale heads, closed PRs and ambiguous associations are not commented on.
- Downloads are bounded while streaming. ZIP validation bounds entry count,
  individual size and expanded size. It rejects traversal, duplicate paths,
  encryption, special files and coverage symlinks before writing anything.
- Source is a GitHub-generated archive at the tested SHA, not an executable checkout.
  Only regular Go and frontend TypeScript files are copied, with no execute bits.
  Other source symlinks are never followed. No repository config is copied.
- Go block coordinates and LCOV line numbers must refer to those source files.
  Only paths and numeric line hits are passed to octocov from LCOV.
- The octocov configuration comes from the trusted reporter. Its native comment,
  summary and datastore output are disabled. A small adapter publishes only numeric
  totals, ratios and differences using fixed text. It never publishes artifact
  strings or file names.
- The reporter uses the runner's existing Python standard library for ZIP validation
  and the pinned octocov reporting action. It installs no project toolchain.
  Unit tests run through `just test`, including adversarial real ZIP files.
- Only the PR reporter has pull-requests write. Main reporting has read-only
  permissions. Artifact upload uses the Actions runtime token. No test execution
  gets write access.

## Baseline and timing

The central comment has its own marker and heading, distinct from legacy octocov.
Main baselines contain only numeric metrics, the commit SHA and source run ID.
Only successful runs of this trusted listener can supply a baseline. The chosen
baseline must be an ancestor of the PR's base commit. No baseline is silently
invented on the first run.

The listener also handles successful main-push `standards` verification. It first
looks for that run's Linux reports. If verification reused PR evidence, it finds a
merged PR with the same Git tree as main and uses its successful Test Gate artifact.
A missing or expired artifact fails reporting rather than rerunning tests.
Lifecycle timing comes from the source Linux job's API step timestamps and is labeled
as Lifecycle execution, not the reporting job's runtime or test-only time.

This is a preparatory rollout. The legacy test workflow stays until the listener,
main baseline and reused-run lookup have been exercised after merge. The existing
inline gotestsum dispatcher is retained temporarily: the published mandate Check
requires its literal presence in `bin/test.sh`. Delegation to `bin/test-go.sh` is
part of the final refactor once that shared Check accepts the delegate.
