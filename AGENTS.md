# Agent Instructions

Point is a self-hosted photo blog engine: Go 1.26 + Echo v4 backend, SQLite (pure-Go
`modernc.org/sqlite`, no CGO), and a vanilla-JS SPA with no runtime dependencies. One binary serves
the API, the SPA, and media bytes.

This file is the contract for anyone — human or agent — changing this repository. Everything in it
is meant to be true and runnable; if a command here does not work, that is a bug worth reporting.

## Start here

<!-- verify:skip run.sh serves until interrupted (CI smokes it separately); check.sh is the gate CI already runs -->
```bash
./scripts/run.sh      # build everything, serve on http://localhost:8001
./scripts/check.sh    # the quality gate: lint, vet, tests, coverage floors, vuln scan
```

`run.sh` needs no configuration on a fresh clone. It builds CSS and JS (running `npm ci` itself if
`esbuild` is missing), compiles the Go binary, creates `data/`, initializes the SQLite schema, and
serves. First run opens a setup wizard at the root URL.

`check.sh` is the same set of checks CI runs. Run it before you open a PR — it keeps going after a
failure and prints a PASS/FAIL summary, so one red step still tells you about the rest.

## Reading the codebase: ask the index, don't grep the tree

828 files, ~168k lines, two languages. A `grep -r` for anything interesting here returns hundreds of
hits, and reading files to find out whether they matter spends the context you need for the actual
change. This repository is indexed by [Repowise](https://repowise.dev), and its MCP tools answer
structural questions from that index — verified against the live tree, with citations — for a
fraction of the tokens a search costs. The index itself lives in `.repowise/` and is not committed:
`repowise init --yes` builds it locally and needs no API key, `repowise update` resyncs it.

**Query the tools first. Reach for `grep`/`find`/`cat` only when they come up empty**, and then
scoped to a directory one of them named, never repo-wide.

| What you want | Call | Instead of |
|---|---|---|
| How does X work / where does Y happen | `get_answer("how are session cookies issued?")` | a `grep -r` sweep and four file reads |
| Orientation on a file, module or symbol before touching it | `get_context(targets=["api/internal/api/posts.go"])` — docs, signatures, hotspot and fix history, no source bytes | `cat` the file to see what is in it |
| The whole shape of a file, verified | `get_context(targets=[…], include=["skeleton"])` | `grep '^func'` |
| Find code by name or by concept | `search_codebase("carousel transition strategy")` | `find` piped into `grep` |
| One symbol's body, when a previous answer named its id | `get_symbol("api/internal/services/post_service.go::CreatePost")` | `sed -n '120,180p'` |
| Why is it built this way / may I diverge from the pattern | `get_why("why does the repository embed *models.Queries?")` | `git log -S` archaeology |
| What else moves if I change this | `get_risk(targets=["api/internal/repository/db.go"])` | guessing, then a broken build |
| A review pass over what you just wrote | `get_change_risk()`, then `get_health(targets=[…])` | hoping CI notices |
| First session in this repo | `get_overview()` — once, then never again | reading the directory tree |

The rules that keep this honest:

- **Read before you edit — always.** The tools decide *which* file to open and what to expect in it;
  they do not replace opening the file you are about to change. An `Edit` against a file you have
  not read in this session is a guess, and the harness will reject it anyway.
- **The index is built from committed code.** Your own uncommitted edits are not in it: after you
  change a file, your edit is the truth and the index is stale about it. `repowise update` resyncs,
  and a reply whose `_meta.hint` says the index is behind HEAD is telling you to.
- **Read the confidence fields rather than skimming past them.** `verified: true` and
  `_meta.complete` mean the bytes were checked against the live tree — don't re-read those. An
  empty `callers` list carries a `*_basis` saying how much of the call graph resolved; a zero with a
  weak basis is "unknown", not "nothing calls this". The generated section at the end of this file
  spells the fields out.
- **Send noisy commands through `repowise distill`.** Tests, builds, `git log`/`git diff`, long
  listings: `repowise distill ./scripts/check.sh` runs the same command, preserves its exit code,
  and prints errors first. A `[repowise#<ref>: N lines omitted]` marker expands with
  `repowise expand <ref>` (`-q <regex>` to filter) — never re-run the command to see what was cut.
- **Record a decision you had to reason out**: `repowise decision add --title T --decision D`. It
  lands as `proposed`, for a person to confirm. Anything a future reader would otherwise have to
  re-derive belongs there or in `docs/features/`.
- **No tools in your session?** Nothing here depends on them: the "Where things live" table below
  is the entry point, `docs/architecture/map.md` is the same map written out longhand, and `rg`
  scoped to one directory from either is the fallback.

## Commands

| Task | Command |
|---|---|
| Environment check | `./scripts/doctor.sh` — PASS/WARN/FAIL per tool, `--json` for machine use; exits non-zero only when a build is impossible |
| Dev server (no Docker) | `./scripts/run.sh` — port 8001; `-d`/`--debug` serves the debug bundle <!-- verify:skip serves until interrupted; CI starts it and curls /health instead --> |
| Dev server (Docker) | `./scripts/rebuild.sh` — port 8000 <!-- verify:skip needs Docker; the image is built by the docker-smoke job --> |
| Full quality gate | `./scripts/check.sh` (`--fix` autofixes lint, `--short` skips slow tests, `--lint` lints only) <!-- verify:skip the gate CI already runs, one job per step --> |
| Go tests | `./scripts/run-tests.sh` (`--unit`, `--verbose`, `--race`, `--short`, `--bench`, `--html`) |
| Frontend tests | `npm run test:frontend` — `node --test frontend/test/*.test.js` |
| Frontend typecheck | `npm run typecheck` — `tsc --noEmit` over the JSDoc types; no `.ts` files, no emit |
| Browser automation | `npx --no-install playwright-cli --version` — drives a real Chromium from the shell, so a UI change can be looked at; see [Verifying your change](#verifying-your-change) |
| Rebuild CSS | `./scripts/build-css.sh` |
| Rebuild JS | `./scripts/build-js.sh` |
| Regenerate SQL layer | `cd api && sqlc generate` <!-- verify:skip needs the sqlc binary, which is not part of the documented toolchain --> |
| Check the SQL layer | `./scripts/check-sql-layer.sh` — no shadowed queries, generated models match `api/sql/` |
| Release tarball | `./scripts/build-tarball.sh` — `dist/point-linux-{amd64,arm64}.tar.gz`, what `install.sh --method=native` downloads <!-- verify:skip cross-compiles both arches; the release workflow builds and boots it on every tag --> |

Any of these that prints more than a screenful is worth wrapping in `repowise distill` — the failure
still surfaces, the 400 passing test lines do not.

`check.sh` also needs `golangci-lint` and `govulncheck` on your `PATH`; everything else in this
table runs with just Go and Node. `doctor.sh` is where that becomes visible before a failing run
does it for you — it reports every version this repo requires against what you have, reading them
from `api/go.mod` and `.github/workflows/test.yml` so it cannot disagree with CI, and prints the
install line for whatever is missing.

Every command in this file, in [CONTRIBUTING.md](CONTRIBUTING.md), in [QUICKSTART.md](QUICKSTART.md)
and in [ai-declaration.md](ai-declaration.md) is executed on every PR by the `docs-commands` job — locally, that is `./scripts/check-docs.sh`. If a
command you add cannot run unattended, mark it in the source with
`<!-- verify:skip reason -->` rather than teaching the runner about it.

## Conventions that will bite you

**Never edit generated files.** They are gitignored and rebuilt on every run:

- `frontend/css/main.css`, `light.css`, `viewer.css`, `common/theme.css`, `css/p/`,
  `asset-manifest.json` — edit the sources in `frontend/css/{light,common,public}/*.css`, then run
  `./scripts/build-css.sh`.
- `frontend/js/`, `frontend/js-debug/` — edit `frontend/src/`, then `./scripts/build-js.sh`.
- `api/internal/models/queries.sql.go`, `models.go`, `querier.go`, `db.go` — edit
  `api/sql/queries.sql` (and `schema.sql` for DDL), then `cd api && sqlc generate`. Config lives in
  `api/sqlc.yaml`. `extra.go` in the same package is hand-written. Keep `queries.sql` ASCII: sqlc
  expands `SELECT *` by byte offset, so one em dash in a comment breaks every query after it.
- The `REPOWISE_AGENTS` block at the end of *this* file — written by `repowise agents`. Edit the
  prose above the marker; anything below it is overwritten on the next sync.

**Two vendored files carry a Point patch.** `frontend/vendor/leaflet/leaflet.js`
and `frontend/vendor/codejar/codejar.js` route their own HTML writes through a
Trusted Types policy, because the CSP enforces
`require-trusted-types-for 'script'` and a plain string at `.innerHTML` is
refused — leaflet would die at import time, codejar would corrupt the buffer on
Ctrl+Z. A version bump that drops a fresh upstream build over either file
reverts the patch; re-apply the block marked `/* Point patch — Trusted Types */`
at the top of the file. `scripts/check-vendor-sinks.sh` fails when that has not
happened, and [docs/vendors.md](docs/vendors.md) has the detail.

**Do not add a query whose name is already a method on `*sqliteRepository`.** The repository embeds
`*models.Queries`, and a hand-written method shadows the promoted one — the generated query
compiles and never runs, with nothing to catch it. `scripts/check-sql-layer.sh` (part of
`check.sh` and CI) fails on any such collision, and on generated files that no longer match the
SQL. When the repository needs dynamic SQL sqlc cannot express, the query belongs only in
`api/internal/repository/queries_*.go`, declared on the `Repository` interface in `db.go`.

**Integration tests run by default.** They live in `*_integration_test.go` files carrying
`//go:build !unit` and use a real in-memory SQLite. A plain `go test ./...` builds and runs them.
Pass `-tags=unit` (or `./scripts/run-tests.sh --unit`) to narrow to unit tests only — and expect the
coverage number from a unit-only run to be much lower, because it is measured against a smaller set
of tests. Full conventions, including the `mockRepository` pattern for unit tests, are in
[docs/testing.md](docs/testing.md).

**New services take the `repository.Repository` interface**, not a concrete type — that is what
makes the unit-test mocks possible. The interface is defined in `api/internal/repository/db.go`.

**Plugins are gated end to end.** A feature registered in `api/internal/plugins/registry.go` only
exists when enabled: its API routes 404 via `RequirePlugin`, and its JS chunk is withheld from the
client manifest. If a route or a UI element "disappears", check whether its plugin is on before
assuming a bug.

**Local dev binds loopback by default.** `scripts/run.sh` honors an optional `LOCAL_RUN` environment
variable as the bind host; unset, the server listens on `127.0.0.1`. Set `LOCAL_RUN=0.0.0.0` only if
you need to reach the dev server from another device.

## Where things live

The shortcut for the destinations people ask for most. It is not a directory listing — for anything
not on it, `get_answer` or `search_codebase` will place you faster than a search will.

| To change… | Start at |
|---|---|
| An HTTP route | `api/cmd/api/routes.go` — one `register*Routes` function per domain, called from `setupEcho` in registration order. New routes go here; `/mcp` and `/comments` mount their own subtrees from their packages, but still only via this file |
| Global middleware | `api/cmd/api/middleware_stack.go` — `installMiddleware`: Echo's own config, the `e.Use`/`e.Pre` chain, the public rate limiter |
| CSP | `api/cmd/api/csp.go` — `buildContentSecurityPolicy` and the `trusted-types` tail |
| The HTML shells, handler construction | `api/cmd/api/assets.go` (`loadHTMLShells`) and `api/cmd/api/wiring.go` (`initHandlers`); `setupEcho` in `server.go` wires the pieces together |
| Startup, shutdown, migrations | `api/cmd/api/main.go` — process lifecycle only; services are wired in `wiring.go`, subcommands dispatched in `cli.go` |
| A CLI subcommand (`setup`, `reset-password`, …) | `api/cmd/api/cli.go` decides which one the args name; the command itself gets its own file |
| Serving media bytes / frontend assets | `api/cmd/api/media.go`, `api/cmd/api/assets.go`; cache headers for HTML and API responses in `api/cmd/api/cache.go` |
| Request handling / validation | `api/internal/api/` |
| Business logic | `api/internal/services/` |
| A BFF page aggregate (`/api/pages/...`) | `api/internal/services/pageview/` composes the view; `api/internal/api/pages.go` renders it to JSON |
| Database access | `api/internal/repository/` (hand-written) and `api/internal/models/` (sqlc-generated) |
| The schema | `api/sql/schema.sql` + a migration in `api/internal/migrations/` |
| Auth, sessions, API keys | `api/internal/api/middleware.go`, `api/internal/services/auth_service.go` |
| MCP tools | `api/internal/mcp/tools.go` (see `api/internal/mcp/README.md`) |
| A page or component | `frontend/src/pages/`, `frontend/src/components/` |
| A plugin | `api/internal/plugins/registry.go` + `frontend/src/plugins/<id>/` |
| Themes | `frontend/themes/*.css` — a theme is a CSS custom-property file, not a template |

The fuller version of this table — the whole request path, where plugins, themes, migrations and MCP
attach, and which files are generated — is [docs/architecture/map.md](docs/architecture/map.md).

Architecture in depth: [docs/architecture/backend.md](docs/architecture/backend.md),
[docs/architecture/frontend.md](docs/architecture/frontend.md). Every significant feature has a doc
under [docs/features/](docs/features/) that records what was built **and what was considered and
rejected** — `get_why` surfaces the relevant one, and reading it before redesigning something is
cheaper than rediscovering why the obvious approach was dropped.

## Before you touch a file

Two calls, and they take seconds:

- `get_context(targets=[…])` on what you are about to edit — it reports the fix history and hotspot
  score. Some files here are bug magnets (`api/cmd/api/main.go`,
  `frontend/src/pages/light/PostEditPage.js`), and knowing that before you start changes how much
  test you write.
- `get_risk(targets=[…])` when the file is shared — a repository method, a `frontend/src/core/`
  module, a plugin registry entry. It names the callers that a signature change will break.

`get_why` first if you are about to diverge from an established pattern. This codebase has made
deliberate, unobvious choices — the `Repository` interface, plugin gating, Trusted Types on two
vendored files — and each has a reason that is written down somewhere.

## Git & PRs

- **PRs target `develop`.** `main` is for releases only.
- Tests accompany new or changed behaviour; coverage floors are enforced in CI and will fail the
  build if you lower them.
- Run `./scripts/check.sh` before pushing.
- Then `get_change_risk()` over the diff and `get_health(targets=[…])` on the files you touched.
  Both are cheap, and both catch the class of thing a green test run does not: a change that is
  structurally larger than it looks, a function that just became the worst-scoring one in its
  package. Say in the PR what they told you if it was interesting.

## Verifying your change

Do not stop at "it compiles". Prove the change:

- **Backend** — a test in the matching `*_test.go` / `*_integration_test.go`, plus `curl` against
  `./scripts/run.sh` for anything HTTP-facing.
- **Frontend** — a test in `frontend/test/`, plus loading the page on :8001.
- **Anything user-visible** — say in the PR what you actually ran and what you saw.

If you are an agent, "loading the page" is something you can do too. `npm ci` puts `playwright-cli`
in `node_modules/.bin`, and one command makes it usable:

<!-- verify:skip downloads a browser; the Commands table checks that the CLI itself is installed -->
```bash
npx playwright-cli install                       # once: downloads Chromium, writes .playwright/
npx playwright-cli open http://localhost:8001    # then drive the page: snapshot, click, fill, console
```

Without that first command the CLI looks for Google Chrome at a system path and fails on a machine
that has none. `.claude/skills/playwright-cli/` ships in this repository so the whole command set is
documented where an agent will read it.

A clean clone has nothing to look at, though: the server 302s every path to `/setup` until an owner
exists, and an empty archive hides most of the public site. Get past both over the API, then drive
the page:

<!-- verify:skip drives a browser against a server this runner does not start -->
```bash
./scripts/run.sh &                                                          # :8001
PW=$(node -e 'console.log(require("crypto").createHash("sha256").update("devpassword").digest("hex"))')
curl -s -X POST http://localhost:8001/api/setup -H 'Content-Type: application/json' \
  -d "{\"name\":\"$PW\",\"blog_title\":\"Dev Blog\",\"author_name\":\"Dev\",\"email\":\"dev@example.com\"}"
curl -s -c cookies.txt -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"the_owner\",\"name\":\"$PW\"}"
curl -s -b cookies.txt -X POST http://localhost:8001/api/posts -H 'Content-Type: application/json' \
  -d '{"title":"A post","content":"Body text.","excerpt":"Card text.","status":"published"}'

npx playwright-cli open http://localhost:8001
npx playwright-cli screenshot --filename=before.png
```

The password field is named `name` and holds a SHA-256 hex digest — the browser hashes before
sending, and both endpoints expect what the browser would send. For the admin UI, hand the browser
that session instead of driving the login form:
`npx playwright-cli cookie-set session "$(awk '/session/{print $7}' cookies.txt)" --domain=localhost`.

**After editing CSS or JS, re-run `./scripts/run.sh` before reloading.** Assets are served at
content-hashed URLs read from `asset-manifest.json` at startup, so a rebuild alone leaves the page
pointing at the old hash it has already cached, and your change appears to have done nothing.

The full recipe — seeding media, which console errors are normal, and how to tell "my CSS did not
apply" from "that text comes from a different element" — is in
[docs/testing.md](docs/testing.md#verifying-a-ui-change).

That directory is written by the tool itself and is not edited by hand, which is why `package.json`
pins `@playwright/cli` to an exact version rather than a range. If the two ever drift — after a
dependency bump, say — the CLI prints a warning on every run, and `npx playwright-cli install
--skills` rewrites the skill to match.

<!-- REPOWISE_AGENTS:START — Do not edit below this line. Auto-generated by Repowise. -->
## Codebase Intelligence for point (Repowise)

Indexed by [Repowise](https://repowise.dev). Last indexed: 2026-09-08 (commit 995a37c). Confidence: 100%.
### How to work in this repo

- **Trust the index.** `verified: true` and `_meta.complete` mean the bytes were checked against the live tree, so never re-read them. Re-read only what `bounds: "approximate"` or `_meta.stale_warning` names. `confidence` rates the prose, not the evidence: on `low` read the `fallback_targets` or `best_guesses` the reply names, and run `repowise update` and ask again if `_meta.hint` says the index is behind HEAD. `index_behind: true` alone is informational.
- **A zero carries its basis.** An empty `callers`/`callees`/`used_by` comes with a `*_basis` saying how much of that language's calls the graph resolved, so read it before concluding nothing calls a symbol. `_meta.scope_hint` names the areas the answer did not touch.
- **Pre-edit, not instead-of-edit.** These tools decide *which* files to read and edit. Reading a file before you edit it is correct and expected.
- **Noisy commands** (tests, builds, `git log`/`diff`, searches, listings): prefer `repowise distill <cmd>`, the same command with its exit code preserved and errors-first output. A `[repowise#<ref>: N lines omitted]` marker is recoverable via `repowise expand <ref>` (add `-q <regex>` to filter); never re-run the command to see omitted output.
- **Recording a decision** you had to reason out: `repowise decision add --title T --decision D` records it without prompting and prints the id (`--format json` to parse it back). It lands `proposed`, for a person to confirm.

### Tools

| Tool | When and why |
|------|--------------|
| `get_answer(question)` | First call for any how/where/why question. Cite `confidence: "high"` or `grounding: "extracted"` directly; `degraded` means judge by `retrieval_quality`. `symbol_bodies` has live bodies. |
| `get_context(targets=[...])` | Triage card for files/modules/symbols: docs, signatures, hotspot, fix history. No source bytes — `include=["skeleton"]` for the whole file verified, `["callers"|"decisions"]` for depth. Batch targets. |
| `get_symbol(id, depth?)` | **Follow-up, not an entry point** — one verified body for an id a prior response named (`path.py::Name`, `path.py:140-180`, `repowise#<hex>`). Never walk a file symbol by symbol; Read it. |
| `search_codebase(query)` | Hybrid search, auto-routed by query shape; force with `mode=symbol|path|concept|hybrid`. A hit whose `sources` are `[fts]` only has no semantic agreement, so verify it. |
| `get_why(query, targets?)` | Why the code is shaped this way: decision records, git archaeology, rationale comments. Call before a refactor or a pattern divergence. |
| `get_risk(targets, changed_files?, include?)` | File history and structural reach. PR mode leads with `directive`; its 0-10 structural heuristic is uncalibrated, not a probability. Read typed test recommendations and coverage state first. |
| `get_change_risk(revspec?, extensions?, exclude_patterns?)` | Deterministic live-diff review signal for a commit or range. Lead with benchmarked percentile/classification; the 0-10 diff-shape score is supporting, not a probability. `get_risk` scores paths. |
| `get_health(targets?, include?)` | Defect / maintainability / performance scores and findings. Self-check the files you touched before finishing. |
| `get_dead_code(tier?, min_confidence?, safe_only?)` | Confidence-tiered unreachable files / unused exports / zombie packages. For cleanup sweeps, not targeted fixes. |
| `get_overview()` | Architecture map. Call once, first, in an unfamiliar repo; skip it after that. |

### Architecture
**Files:** 828 | **Lines:** 168045
point is a javascript codebase of 828 files. Execution starts at demo/mock/entry.js, frontend/src/app.js, api/cmd/api/cli.go and 5 other entry points. ---
*Built from the code's structure. It states what is there, not why it is that
way.

### Key modules
- `api/internal` — api/internal/api · api/internal/config · api/internal/mcp · api/internal/mcp/oauth · api/internal/metrics · api/internal/migrations · and 6…
- `frontend/src/utils` — frontend/src/utils
**Language:** javascript | **Files:** 41 | **Public symbols:** 248 / 362
Covers the 41 source files in…
- `api/internal/services` — api/internal/services
**Language:** go | **Files:** 37 | **Public symbols:** 336 / 543
Covers the 37 source files in api/internal/services
- `api/internal/models` — api/internal/models · api/internal/plugins · api/internal/repository
**Language:** go | **Files:** 14 | **Public symbols:** 146 /…
- `frontend` — frontend · frontend/src · frontend/types
**Language:** javascript | **Files:** 5 | **Public symbols:** 23 / 66
Covers the 5 source files in…
- `frontend/src/plugins` — frontend/src/plugins/breadcrumbs · frontend/src/plugins/carousel · frontend/src/plugins/comments · frontend/src/plugins/distraction-free ·…
- `frontend/src/api` — frontend/src/api
**Language:** javascript | **Files:** 17 | **Public symbols:** 134 / 149
Covers the 17 source files in frontend/src/api
- `api/internal/api` — api/internal/api
**Language:** go | **Files:** 29 | **Public symbols:** 214 / 378
Covers the 29 source files in api/internal/api
- `frontend/src/components/shared` — frontend/src/components/shared · frontend/src/core
**Language:** javascript | **Files:** 11 | **Public symbols:** 178 / 191
Covers the 11…
- `frontend/src/components` — frontend/src/components · frontend/src/components/light · frontend/src/components/light/sections · frontend/src/components/light/tags ·…

### Entry points
- `frontend/src/app.js`
- `api/internal/mcp/server.go`
- `api/cmd/api/cli.go`
- `api/cmd/api/main.go`
- `api/cmd/api/server.go`
- `api/cmd/migrate-paths/main.go`

### Files that need care (bug-fix history first, then churn — check `get_risk` before editing)
- `frontend/src/pages/light/PostEditPage.js` — 11 bug fixes, last fix 5 days ago (bug magnet); 38 commits/90d
- `api/cmd/api/main.go` — 9 bug fixes, last fix 5 days ago (bug magnet); 62 commits/90d
- `frontend/src/components/light/PhotoLibraryPickerDialog.js` — 5 bug fixes, last fix 5 days ago (bug magnet); 12 commits/90d
- `frontend/src/pages/public/TagPage.js` — 6 bug fixes, last fix 10 days ago (bug magnet); 32 commits/90d
- `frontend/src/pages/public/PostPage.js` — 6 bug fixes, last fix 2 weeks ago (bug magnet); 21 commits/90d

### Code health
Three co-equal signals: defect risk 6.31/10 avg, hotspot health 4.23/10 (stable), worst `api/internal/api/posts.go` at 1.4/10 · maintainability 8.17/10 · performance risk 148 open static I/O-in-loop / N+1 findings. Detail: `get_health()`.

Critical files:
- `frontend/src/pages/light/TagsManagerPage.js` — god class (TagsManagerPage) — impact −2.3
- `frontend/src/plugins/carousel/index.js` — god class (CarouselStudioPage) — impact −2.1
- `frontend/src/components/light/MediaBrowser.js` — god class (MediaBrowser) — impact −2.1
- `frontend/src/utils/icons.js` — untested hotspot — impact −2.0
- `frontend/src/components/shared/MediaViewer.js` — god class (MediaViewer) — impact −1.9

### Commands
- Build: `npm run build`
- Test: `npm run test`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

<!-- REPOWISE_AGENTS:END -->
