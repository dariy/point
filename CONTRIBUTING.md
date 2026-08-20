# Contributing to Point

Thank you for considering a contribution.

Point is a small project with a single maintainer, so the most useful thing you can do is make your
change easy to verify: state what you ran, and what you saw.

## Getting the project running

You need Go (the version in `api/go.mod`), Node 22+, and `git`. Nothing else — no database to
install, no services to configure. `./scripts/doctor.sh` checks all of that on your machine and
says what to install if something is missing or too old.

<!-- verify:skip clones the repository over the network, then serves until interrupted -->
```bash
git clone https://github.com/dariy/point.git
cd point
./scripts/run.sh
```

That builds the CSS, the JS bundles (installing npm dev dependencies if needed) and the Go binary,
creates a local SQLite database under `data/`, and serves on <http://localhost:8001>. The first page
you see is the setup wizard. No configuration is required; `.env.example` documents the optional
extras (AI analysis, comments, SMTP, photo-library import) if you want them.

## The change loop

<!-- verify:skip run.sh serves until interrupted (CI smokes it separately); check.sh is the gate CI already runs -->
```bash
./scripts/run.sh          # develop against localhost:8001
./scripts/check.sh        # the full gate — run this before you push
```

`scripts/check.sh` runs exactly what CI runs: Go lint, JS lint, `go vet`, Go tests with a coverage
floor, frontend tests with a coverage floor, and a vulnerability scan. It keeps going after a
failure and prints a PASS/FAIL summary at the end. `--short` skips the slow tests while you iterate,
and `--fix` applies the lint autofixes; run it once without either before opening a PR.

It is the one command that needs more than Go and Node: `golangci-lint` (the v2 module path) and
`govulncheck` have to be on your `PATH` — `.github/workflows/test.yml` pins the versions CI uses.
Without them the gate reports those steps as failures; `./scripts/doctor.sh` warns you about that
in advance and prints the `go install` line for each.

For a tighter loop, `./scripts/run-tests.sh` takes `--unit`, `--race`, `--bench` and `--html`, and
`npm run test:frontend` runs just the frontend suite.

**[AGENTS.md](AGENTS.md) is the working reference** — the commands, the conventions that will bite
you (generated files you must not edit by hand, the test build tags, the plugin gating), and a table
of where things live. It is written for coding agents, and it is equally the fastest orientation for
a human. Read it before your first change.

## Where to start

Issues labelled [`agent-ready`](https://github.com/dariy/point/issues?q=is%3Aissue+is%3Aopen+label%3Aagent-ready)
are picked to be workable by someone — or something — that has never seen this codebase. Each one
names the files involved and **the command that proves it done**, so you can tell you are finished
without waiting for a review round. Several are also labelled `good first issue`.

If one interests you, say so in a comment before you start, so two people don't write the same patch.

Anything else in the tracker is fair game too; those just come with less scaffolding.

## Reporting bugs

* Test against the latest version first.
* Open a GitHub issue with a clear title, the steps to reproduce, what you expected, and what
  actually happened.
* Include your Point version (shown in the admin sidebar, or `./point --version`) and how you run it
  (Docker, Podman, or native).

## Proposing features

Open an issue describing the feature and why it is needed, and let's discuss it before you write the
code. Point deliberately says no to a lot — it is a single-user photo blog, not a photo library, a
gallery CMS, or a multi-tenant platform — so a quick conversation can save you an afternoon.

Many features already have a design document under [`docs/features/`](docs/features/) recording what
was built **and what was considered and rejected**. If one covers your area, read it first; it may
already answer your question.

## Pull requests

1. **Target `develop`.** `main` is for releases only.
2. Include tests for new or changed behaviour. Coverage floors are enforced in CI and a PR that
   lowers them will fail.
3. Make sure `./scripts/check.sh` passes.
4. Follow the surrounding style; let the linters run clean.
5. In the PR description, say what you ran to verify the change.

Then a maintainer reviews and merges it.

## Working with an AI coding agent

That is fine, and this repository is set up for it — [AGENTS.md](AGENTS.md) is committed precisely
so your agent starts with the project's real conventions instead of guessing.

The bar for the resulting PR is exactly the same as any other: the tests pass, the change is
verified, and **you understand and stand behind the diff**. Please don't open a PR you haven't read.
