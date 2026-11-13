# Central coverage reporter

The unprivileged Test Gate runs the image-pinned octocov with no token or network
requirement. It writes `reports/coverage/summary.json`: `covered`, `total`, `code`
and `test`, all safe non-negative integers. Existing Go and frontend coverage
remain available under `reports/coverage/`. Download the central reports artifact
to inspect `coverage/summary.json` and the JUnit reports together. The Linux
summary drives comments and the main baseline; the macOS leg emits the same format.

The privileged listener checks out only its default-branch reporter. It downloads
one bounded Linux reports artifact and reads only `coverage/summary.json` with a
4 KiB cap. It extracts nothing and executes no artifact content, source, project
toolchain or third-party measurement binary. Extra archive members are ignored.
Malformed summaries fail the run before any comment.

Only API-bound current same-repository PRs can receive a comment. Both triggers and
reused-run selection require the same `head_repository`. PR concurrency is keyed
by that repository and branch. Main baseline jobs have a separate group and read-only permissions. Its newest
pending run replaces older pending work; only the newest main baseline matters.
Only PR reporting has pull-requests write.

The fixed-text numeric comment has a distinct marker from legacy octocov.
Main baseline artifacts last 90 days and must be ancestors of the PR base.
Reused verification requires an identical Git tree and passing same-repository
Test Gate artifact. Missing evidence fails reporting, never reruns tests.
Timing comes from the source Linux Lifecycle step, including typecheck, e2e and
package, not just tests.

The legacy per-file "files in pull request scope" table and Details block are
intentionally dropped by the lead's decision. Total coverage, covered/total,
the main diff, test/code ratio and Lifecycle timing remain.

The central Test Gate is the only automated test run. Coverage reporting consumes
its summary without a second test job. The inline gotestsum dispatcher stays until
the shared mandate Check supports delegation to `bin/test-go.sh`.
