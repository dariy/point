# E2E tests

Playwright tests that `node --test` runs. There is no Playwright config.

```bash
./scripts/run-e2e.sh                                  # all files, Chromium
./scripts/run-e2e.sh frontend/e2e/atlas-layer-map.test.ts   # one file
```

`scripts/run-e2e.sh` builds the frontend and the Go binary. It starts one server with an empty
storage path for each file. `./scripts/check.sh --only e2e` runs it.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `E2E_DEVICE` | `chromium` | `ipad` runs the test on WebKit with `devices['iPad Pro 11']`: 834x1194, touch, mobile, the iPad user agent. `run-e2e.sh` then installs WebKit too. |
| `E2E_PORT` | `8005` | The port of the server that `run-e2e.sh` starts. |
| `E2E_BASE_URL` | `http://127.0.0.1:8001` | The server that a test file uses. `run-e2e.sh` sets it. |

Only a file that gets its browser from `devices.ts::launchFor` follows `E2E_DEVICE`. Other files
stay on Chromium. Use `onIpad` from `devices.ts` to skip a test that is for Chromium only, and
give the reason in the skip.

CI runs all files on Chromium, then `atlas-layer-map.test.ts` again with `E2E_DEVICE=ipad`.

```bash
npx playwright install webkit
E2E_DEVICE=ipad ./scripts/run-e2e.sh frontend/e2e/atlas-layer-map.test.ts
```
