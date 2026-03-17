# Point — Metaswarm Knowledge Base

> Last refreshed: 2026-03-17

## Project Identity
- **Name**: Point — self-hosted personal photo blog engine
- **Stack**: Go 1.25 + Echo v4 · SQLite/sqlc (pure-go, no CGO) · Vanilla JS SPA · Podman
- **Auth**: Session-cookie (bcrypt) · no JWT
- **AI**: Google Gemini (`api/data.yml`) · endpoint `POST /api/media/analyze`
- **Issue tracking**: beads (`bd`) — do NOT use TodoWrite or markdown task lists

## Architecture Layers
```
Handler (internal/api/)
  → Service (internal/services/)
    → Repository (internal/repository/)
      → sqlc models (internal/models/)  ← auto-generated, never edit
```

## Critical Rules
1. Never edit `api/internal/models/` — sqlc-generated; edit `api/sql/queries.sql` then `sqlc generate`
2. Never edit CSS bundle files directly — edit modules in `frontend/css/` then run `./scripts/build-css.sh`
3. DB migrations live in `api/cmd/api/main.go` (inline slice), not in `api/migrations/` (empty)
4. Container engine is **Podman** in dev, Docker in prod
5. No frontend build step — JS changes are live immediately
6. Branch names must start with `claude/` for push permissions
7. SQLite uses **pure-go driver** (no CGO) — do not introduce CGO sqlite deps

## Test Commands
```bash
./scripts/run-tests.sh            # standard run (80% coverage required)
./scripts/run-tests.sh --verbose  # verbose output
./scripts/run-tests.sh --race     # race detector
./scripts/run-tests.sh --html     # generates api/coverage.html
```

## Frontend Linting
```bash
npx eslint frontend/src/          # lint frontend JS
# config: eslint.config.js at project root
```

## Adding an Endpoint (checklist)
1. Add query to `api/sql/queries.sql`
2. Run `cd api && sqlc generate`
3. Add repository method (hand-written SQL → `api/internal/repository/extended.go`)
4. Implement service in `api/internal/services/`
5. Add handler in `api/internal/api/`
6. Register route in `api/cmd/api/main.go`
7. Write `*_test.go` alongside handler/service

## Error Response Shape
```go
return echo.NewHTTPError(http.StatusNotFound, "post not found")
// or:
return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
```

## Frontend Patterns
- New page: `src/pages/{light|public}/MyPage.js` → export `render(params)` → register in `src/router.js`
- New API module: `src/api/myresource.js` wrapping `client.js` helpers
- New component: `src/components/{light|public|shared}/MyComponent.js` extending `Component`

## System Tags Architecture (COMPLETE as of 2026-03-15)
All 6 boolean tag flag columns have been **dropped** from the `tags` table. Tag behavior is now expressed via parent-child relationships in `tag_relationships` where the parent is a system tag (slug starts with `_`).

System tags: `_system`, `_root` (nav), `_hidden`, `_hide_posts`, `_is_in_breadcrumbs`, `_with_related`, `_pending` (orphan auto-assign).

Rules:
- Slugs starting with `_` are rejected for user-created tags (400)
- System tags cannot be renamed/deleted/reparented
- System tags excluded from all public API responses
- Key service methods: `EffectivelyHiddenPostsTagIDs()`, `EffectivelyHiddenIDs()`, `InBreadcrumbsIDs()`, `WithRelatedIDs()`, `GetHierarchicalNavTags()`

## Gesture System (COMPLETE)
`frontend/src/utils/gestures.js` — `GestureController` state machine:
- States: `IDLE / SINGLE_TOUCH / MULTI_TOUCH / SWIPING_H / SWIPING_V / PINCHING / PANNING`
- Events: swipe, pinch, pan, tap, double-tap
- `TrackpadDetector` separates trackpad from touch
- `rubberBand()` export for elastic edge effect
- Used in: `PostContent` (pinch-to-zoom), `HomePage`, `TagPage` (swipe nav)
- Trackpad events suppressed on `PublicHeaderTagsBar`

## Notification Log
- `frontend/src/utils/notificationLog.js` — in-memory log of recent notifications
- `frontend/src/components/shared/NotificationLogButton.js` — button to open log overlay
- Integrated into admin layout for debugging

## Offline / PWA
- Mutation queue in `src/utils/mutationQueue.js` + sync in `src/utils/sync.js`
- Temp ID resolution in sync: URL patterns and request bodies are rewritten when a temp ID is replaced
- Offline sync panel added to `SystemPage` (shows queue status, manual trigger)
- SW serves public read endpoints from IDB; admin CRUD is queued client-side only

## Tag Manager (TagsManagerPage)
- Drag-drop reorder + reparenting (heavily reworked)
- System flags rendered inline in tag editor modal
- Parent/child selectors use hierarchical tree view
- Hierarchical nav filtering (breadcrumb-aware)

## Known CI Workflows
- `.github/workflows/test.yml` — Go tests
- `.github/workflows/deploy.yml` — container build + deploy

## External Tools Available
- `gemini` CLI — available for adversarial review and parallel agent tasks
- `codex` — not available
