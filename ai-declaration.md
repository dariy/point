# AI Declaration

Point is built with coding agents, deliberately and throughout. This page states where and how
much, by category, so that anyone reading the code knows what they are reading.

This is a disclosure, not a disclaimer. The project's position is that agent-written code is
ordinary code: it is reviewed, it is tested, and a human is answerable for it. `AGENTS.md` is
committed for the same reason — the conventions an agent needs are public, so the way this
repository was built is the way a contributor can build in it.

## Summary

| Category | Level | In short |
|---|---|---|
| Design | **Pair** | Architecture and feature decisions reached in conversation; scope and the final call are the maintainer's. |
| Implementation | **Pair** | Most code is agent-written turn by turn, directed and reviewed change by change. |
| Testing | **Pair** | Tests are largely agent-written; what a change must prove is decided by the maintainer. |
| Documentation | **Generated** | Most docs are agent-written end to end from the code and the session that changed it, then read and accepted. |
| Review | **Pair** | Agent review runs on changes; the maintainer accepts or rejects each finding and is the gate. |
| Deployment | **Assisted** | Agents wrote most of the build and release tooling; real deploys are run and supervised by the maintainer. |

## Levels

| Level | Meaning |
|---|---|
| **Hint** | An agent suggested an idea or answered a question. The artifact is human-written. |
| **Assisted** | An agent produced parts of the artifact. A human wrote its structure and the rest. |
| **Pair** | Human and agent worked on the same artifact turn by turn. The human directs, and reviews every change before it lands. |
| **Generated** | An agent produced the artifact end to end. A human read it and accepted it. |

No category is unsupervised: nothing in this repository lands without a human reading it and
choosing to keep it.

## By category

### Design — Pair

Feature and architecture decisions are worked out in conversation with an agent, with the
maintainer setting scope and making the call. The record of that is visible in the repository:
each doc under `docs/features/` carries a "considered and rejected" section, which exists because
alternatives were argued through rather than silently dropped.

### Implementation — Pair

Most code changes are agent-written, one session at a time, against the conventions in
`AGENTS.md`. The maintainer directs the change, reads the diff, and is the one who commits it.
Larger refactors are done as explicit move-only passes with a mechanical proof that no behaviour
changed (see the commit messages on the `cmd/api` and `PostService` splits).

Evidence: 129 of 260 non-generated Go and JS source files were last touched by a commit carrying
an AI co-author trailer.

### Testing — Pair

Test code is largely agent-written; what a change is required to prove is a maintainer decision.
`./scripts/check.sh` is the whole gate and it runs the same way for a human and an agent.

Evidence: 110 of 208 test files were last touched by a commit carrying an AI co-author trailer.

### Documentation — Generated

The architecture, feature and guide docs are, for the most part, written by an agent at the end
of the session that made the change, then read and accepted by the maintainer. `AGENTS.md`,
`docs/architecture/map.md` and the `docs/features/` set are all of this kind. CI runs every
command those docs promise, this page's included (`./scripts/check-docs.sh`), because generated
documentation drifts and a prose review does not catch it.

Evidence: 64 of 83 tracked Markdown files were last touched by a commit carrying an AI co-author
trailer.

### Review — Pair

Changes get agent review — `/code-review` locally, and GitHub's Copilot Autofix on the repository
— but a finding is a suggestion until the maintainer accepts it. The bar stated in `README.md`
for an outside contribution is the bar used here: the tests pass, the change is verified, and the
person opening the PR understands and stands behind the diff.

### Deployment — Assisted

Most of `scripts/`, the container build and the release workflow were agent-written. Production
deploys are run and supervised by the maintainer.

Evidence: 17 of 22 files in `scripts/` and 2 of 5 GitHub Actions workflows were last touched by a
commit carrying an AI co-author trailer.

## The verifiable floor

The levels above are a judgement. The numbers below are not — they are countable from the commit
history, and they are a **floor**, not a measurement.

Measured at `576fb30d`, the commit this page was written against. The counts advance with
every commit — including this page's own — so the commands below, not the table, are the
authority; the table is there to be checked against them.

| Metric | Count |
|---|---|
| Commits in history | 481 |
| Commits carrying an AI co-author trailer | 100 (~21%) |
| — of those, by `Claude` | 98 |
| — by `dariy-ai` | 2 |
| — by `Copilot Autofix` | 3 |
| Commits authored by `dariy-ai` | 8 |
| Earliest commit carrying an AI co-author trailer | 2026-05-22 |
| First commit in the repository | 2026-01-22 |

Reproduce them:

```bash
# commits in history
git rev-list --count HEAD

# commits carrying an AI co-author trailer
git log --format='%H %(trailers:key=Co-Authored-By,valueonly,separator=%x2C)' HEAD \
  | grep -iE 'Claude|dariy-ai|Copilot Autofix' | awk '{print $1}' | sort -u | wc -l

# every co-author trailer in the history, by name
git log --format='%(trailers:key=Co-Authored-By,valueonly)' HEAD \
  | grep -i . | sort | uniq -c | sort -rn

# earliest commit carrying one
git log --reverse --format='%ad %H %s' --date=short HEAD \
  --grep='Co-Authored-By: Claude' | sed -n 1p

# squashed pull requests, and Dependabot's commits
git log --format='%s' HEAD | grep -cE '\(#[0-9]+\)$'
git log --format='%H' --author='dependabot' HEAD | wc -l
```

Per-model counts sum to more than 100 because a squash merge can carry trailers from several
sessions.

### Why it is a floor and not a measurement

- **The convention started mid-project.** The first trailer appears on 2026-05-22; the repository
  starts on 2026-01-22. Commits before that date carry no trailer regardless of how they were
  written, so the untrailered majority is not a human-only majority.
- **Squash merges collapse sessions.** 162 of the 481 commits are squashed pull requests. One
  trailered commit can stand for a dozen agent sessions, and one untrailered commit can too.
- **A trailer marks the session, not the lines.** A commit with a trailer may be mostly
  hand-edited, and a commit without one may be mostly agent-written.
- **Dependabot is excluded.** Its 43 commits (45 co-author trailers) are deterministic
  automation, not generative AI, and counting them would inflate the number without meaning
  anything.

The "last touched by" figures in the category sections come from the same trailer set and inherit
the same caveats: a file whose last commit was untrailered may still have been written by an
agent, and one whose last commit was trailered may have been edited by hand in it.

## What this does not claim

- It does not claim that the code is correct because a human reviewed it, or that it is suspect
  because an agent wrote it. Judge it the way you would judge any other repository: read it, run
  `./scripts/check.sh`, and look at the tests.
- It does not extend to the third-party code this project depends on. See
  [`docs/vendors.md`](docs/vendors.md) for what those are.
- It does not describe Point's *product* features. The engine ships an AI analysis feature
  (Gemini-backed title, tag and excerpt suggestions) and an MCP server; those are documented in
  [`docs/features/ai-analysis.md`](docs/features/ai-analysis.md) and
  [`docs/features/mcp.md`](docs/features/mcp.md) and are a separate matter from how the engine
  itself was built.

Responsibility for everything in this repository, however it was produced, rests with the
maintainer.
