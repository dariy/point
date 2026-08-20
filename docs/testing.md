# Testing Conventions

This project strictly separates **Unit Tests** and **Integration Tests** in the Go backend.

> [!NOTE]
> **Integration tests run by default.**
> A bare `go test ./...` will build and run all tests, including integration tests. To run only unit tests, pass the `unit` build tag (`-tags=unit`) or use `./scripts/run-tests.sh --unit`.

## Test Runner (`scripts/run-tests.sh`)

The recommended way to run tests is using the provided script from the project root. It handles paths and tags automatically.

*   **All tests (default):** `./scripts/run-tests.sh` (runs both unit and integration tests)
*   **Unit tests only:** `./scripts/run-tests.sh --unit`
*   **Verbose output:** `./scripts/run-tests.sh --verbose` (or `-v`)
*   **HTML Coverage:** `./scripts/run-tests.sh --html` (generates an HTML coverage report)

## Unit Tests

*   **Location:** Reside in `*_test.go` files next to the source code (e.g., `api/internal/services/auth_service_test.go`).
*   **Mocks:** MUST use the `mockRepository` (defined in `mock_repository_test.go`) to isolate service logic from the database.
*   **Goal:** Test business logic, sanitization, and error handling in total isolation.
*   **Execution:** Use `./scripts/run-tests.sh --unit`. *(Note: Coverage numbers printed during a unit-only run will be artificially low).*

## Integration Tests

*   **Location:** Reside in `*_integration_test.go` files next to the source code.
*   **Build Tag:** MUST include the `//go:build !unit` constraint at the very top of the file.
*   **Database:** Use a real SQLite `:memory:` database (via `setupTestDB`).
*   **Goal:** Verify the interplay between services and the actual repository/SQL layer.
*   **Execution:** Run via `go test ./...` or `./scripts/run-tests.sh` (included by default).

## Service Pattern

*   **Dependency Injection:** All services MUST accept the `repository.Repository` **interface** in their constructors.
*   **Interface Location:** The main `Repository` interface is defined in `api/internal/repository/db.go` and encompasses both SQLC queries and custom repo methods.

## Verifying a UI change

A green test suite does not prove that a page looks right, and `frontend/test/` runs
under `node --test` with no DOM. Anything visual has to be looked at. This is the
procedure for doing that from a clean clone, with no human at the keyboard —
`playwright-cli` drives a real Chromium from the shell, so an agent can follow it too.

Set the browser up once per clone:

```bash
npx playwright-cli install    # downloads Chromium, writes the gitignored .playwright/
```

Without it the CLI looks for Google Chrome at a system path and fails on a machine that
has none. The command set is documented in `.claude/skills/playwright-cli/SKILL.md`,
which ships in this repository.

### 1. Serve an instance that is past setup

`./scripts/run.sh` serves on `http://localhost:8001`, but a clean clone has no owner
yet, so the server 302s every path to `/setup` and there is nothing to look at. Complete
setup over the API instead of clicking through the wizard. Two details are easy to get
wrong, both because the browser hashes the password before sending it:

*   the password field is called `name`, not `password` — in `POST /api/setup` *and* in
    `POST /api/auth/login` (`api/internal/api/setup.go`, `api/internal/api/auth.go`);
*   its value is a SHA-256 hex digest of the password, and a value that is not 64 hex
    characters is rejected as `invalid password format`.

```bash
./scripts/run.sh &   # :8001, serves until killed
PW=$(node -e 'console.log(require("crypto").createHash("sha256").update("devpassword").digest("hex"))')

curl -s -X POST http://localhost:8001/api/setup \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$PW\",\"blog_title\":\"Dev Blog\",\"author_name\":\"Dev\",\"email\":\"dev@example.com\"}"
```

Setup creates the owner as `the_owner` and returns already authenticated. A fresh
instance has no posts, though, and an empty archive hides most of the public site — the
grid, the cards, the tag strip. Publish something before judging a layout:

```bash
curl -s -c cookies.txt -X POST http://localhost:8001/api/auth/login \
  -H 'Content-Type: application/json' -d "{\"username\":\"the_owner\",\"name\":\"$PW\"}"

curl -s -b cookies.txt -X POST http://localhost:8001/api/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"A post","content":"Body text.","excerpt":"Card text.","status":"published"}'
```

For a change that needs a photograph rather than a text card, upload one — any JPEG will
do (`ffmpeg -f lavfi -i testsrc=size=1200x800 -frames:v 1 shot.jpg` makes one from
nothing) — and the response carries the `/YYYY/MM/<file>` path to reference:

```bash
curl -s -b cookies.txt -X POST http://localhost:8001/api/media/upload -F "file=@shot.jpg"
```

### 2. Get the browser into the admin UI

The public site needs no login. `/light` does, and the login form is not worth driving:
the session cookie from step 1 is all the browser needs.

```bash
npx playwright-cli cookie-set session "$(awk '/session/{print $7}' cookies.txt)" --domain=localhost
npx playwright-cli goto http://localhost:8001/light
npx playwright-cli find "Dashboard"    # confirms it is the dashboard, not the login page
```

### 3. Look at the page, then change it, then look again

```bash
npx playwright-cli open http://localhost:8001
npx playwright-cli screenshot --filename=before.png
# …edit frontend/src/ or frontend/css/…
./scripts/run.sh &                     # rebuild AND restart — see below
npx playwright-cli reload
npx playwright-cli screenshot --filename=after.png
npx playwright-cli close
```

Four things that will otherwise cost you an hour:

*   **Rebuilding is not enough — restart the server.** Stylesheets and bundles are served
    at content-hashed URLs (`/assets/css/main.<hash>.css`) resolved from
    `frontend/css/asset-manifest.json`, which the server reads at startup. After
    `./scripts/build-css.sh` the HTML still points at the old hash, the browser has that
    URL cached as immutable, and the page looks exactly as it did. Re-running
    `./scripts/run.sh` rebuilds and restarts in one step, which is why the recipe uses it
    rather than the individual build scripts.
*   **`reload` after a data change; not `goto` to the same URL,** which can restore the
    page from cache and show you the archive as it was before your `POST`.
*   **Confirm you are looking at the element you changed.** `playwright-cli find "text"`
    and `--raw eval "getComputedStyle(document.querySelector('.sel')).prop"` cost one
    command each and distinguish "my CSS did not apply" from "that text is rendered by a
    different element" — the site title in the header, for instance, is a breadcrumb link
    and not the `.site-title` heading, which carries only the logo.
*   **Two console errors on the public site are normal:** a `401` from `/api/auth/me`
    when logged out (`client.js` exempts exactly that endpoint from the redirect-to-login
    event) and a `404` from `/api/timeline` when the timeline plugin is off. Check
    `playwright-cli console` against that baseline rather than treating any error as new.

### 4. Say what you saw

State in the PR which page you loaded, what you did on it, and what changed —
"published post grid at :8001, card outline is now 3px crimson, screenshot attached"
rather than "verified visually". A screenshot is the evidence; `playwright-cli console`
output is worth quoting when the change touches JS.

> [!NOTE]
> **Why not the static demo?** `demo/` builds the frontend against recorded fixtures and
> needs no backend, which makes it the tempting target — but `demo/mock/fixtures/fixtures.json`
> is gitignored, and regenerating it (`demo/scripts/make-content.sh`) wants a Gemini key
> and several minutes of network. A clean clone therefore cannot build the demo, while it
> can always run `./scripts/run.sh`. If you *do* have fixtures on disk,
> `demo/scripts/run.sh` serves the same UI on :8002 with a fuller archive behind it, and
> `node demo/scripts/test.mjs --base=http://localhost:8002` checks it headlessly.
