# Backup Disk Space Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show free disk space in the admin System page, guard `CreateBackup` against insufficient disk space, display a proactive warning when free space is low relative to the last backup, and verify that the "Enable backup" setting is wired end-to-end.

**Architecture:** Add a `GetDiskInfo()` method to `SystemService` using `syscall.Statfs` (Linux-native, no new deps). Expose it via `GET /api/system/disk`. Guard `CreateBackup` with a pre-flight check: if the largest existing backup × 1.5 exceeds free space, return a 422 error. Frontend loads disk info alongside backups and renders a warning banner + free-space counter in the Backup card header.

**Tech Stack:** Go 1.25 + Echo v4 (backend), Vanilla JS SPA (frontend), `syscall.Statfs` (Linux disk stats)

---

## File Structure

**Modified:**
- `api/internal/services/system_service.go` — add `DiskInfo` type + `GetDiskInfo()` + pre-flight in `CreateBackup()`
- `api/internal/api/system.go` — add `GetDiskInfo` handler
- `api/cmd/api/main.go` — register `GET /api/system/disk` route
- `frontend/src/api/system.js` — add `getDiskInfo()` export
- `frontend/src/pages/light/SystemPage.js` — load disk info, show free-space in backup card, warning banner

**Test files:**
- `api/internal/api/system_test.go` — extend with `TestSystemHandler_GetDiskInfo` and `TestSystemHandler_CreateBackup_InsufficientDisk`

---

## Task 1: Add `DiskInfo` and `GetDiskInfo()` to SystemService

**Files:**
- Modify: `api/internal/services/system_service.go`

- [ ] **Step 1: Write the failing test in `api/internal/api/system_test.go`**

Add this test to `api/internal/api/system_test.go` (after the last existing test):

```go
func TestSystemHandler_GetDiskInfo(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/disk", nil)
	rec := httptest.NewRecorder()
	if err := h.GetDiskInfo(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetDiskInfo failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	for _, key := range []string{"total", "free", "used"} {
		if _, ok := resp[key]; !ok {
			t.Errorf("response missing field %q", key)
		}
	}
}
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd api && go test ./internal/api/ -run TestSystemHandler_GetDiskInfo -v
```

Expected: compile error — `GetDiskInfo` not defined on handler.

- [ ] **Step 3: Add `DiskInfo` type and `GetDiskInfo()` to `system_service.go`**

Add imports `"syscall"` to the existing import block in `api/internal/services/system_service.go`, then add after the `NewSystemService` function:

```go
type DiskInfo struct {
	Total int64 `json:"total"`
	Free  int64 `json:"free"`
	Used  int64 `json:"used"`
}

func (s *SystemService) GetDiskInfo() (DiskInfo, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(s.dataPath, &stat); err != nil {
		return DiskInfo{}, fmt.Errorf("statfs: %w", err)
	}
	total := int64(stat.Blocks) * stat.Bsize
	free := int64(stat.Bavail) * stat.Bsize
	return DiskInfo{
		Total: total,
		Free:  free,
		Used:  total - free,
	}, nil
}
```

Note: `Bsize` is `int64` on Linux; `Blocks` and `Bavail` are `uint64`. The cast is safe for any filesystem that fits in int64 (which is all practical cases).

- [ ] **Step 4: Add `GetDiskInfo` handler to `api/internal/api/system.go`**

Add this method to `SystemHandler` at the end of `system.go`:

```go
func (h *SystemHandler) GetDiskInfo(c echo.Context) error {
	info, err := h.systemService.GetDiskInfo()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, info)
}
```

- [ ] **Step 5: Register route in `api/cmd/api/main.go`**

Find the `systemGroup` block (around line 238). Add after the `/stats` line:

```go
systemGroup.GET("/disk", systemHandler.GetDiskInfo, api.AuthMiddleware(svcs.Auth))
```

- [ ] **Step 6: Run the test to confirm it passes**

```bash
cd api && go test ./internal/api/ -run TestSystemHandler_GetDiskInfo -v
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /home/light/src/blog/point
git add api/internal/services/system_service.go api/internal/api/system.go api/cmd/api/main.go api/internal/api/system_test.go
git commit -m "feat(system): add GetDiskInfo endpoint (GET /api/system/disk)"
```

---

## Task 2: Guard `CreateBackup` against insufficient disk space

**Files:**
- Modify: `api/internal/services/system_service.go`
- Modify: `api/internal/api/system_test.go`

- [ ] **Step 1: Write the failing test**

Add to `api/internal/api/system_test.go`:

```go
func TestSystemService_CreateBackup_InsufficientDisk(t *testing.T) {
	// This test verifies that CreateBackup returns an error when a previous
	// backup exists and a fabricated backup file exceeds 2/3 of free space
	// (so that 1.5x the backup size > free space).
	// We simulate this by creating a fake backup file and then checking that
	// GetDiskInfo and the size logic work — we can't artificially fill a disk,
	// so we test the size-check logic directly on SystemService.
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	defer func() { _ = repo.Close() }()

	svc := services.NewSystemService(repo, tmpDir)

	// Get actual free space
	info, err := svc.GetDiskInfo()
	if err != nil {
		t.Fatalf("GetDiskInfo: %v", err)
	}

	// Create a fake "previous backup" whose size > free/1.5 (i.e., 1.5x exceeds free)
	backupDir := filepath.Join(tmpDir, "backups")
	_ = os.MkdirAll(backupDir, 0755)
	fakeSize := info.Free/1 + 1 // larger than free space itself
	fakeFile := filepath.Join(backupDir, "backup_20200101_000000.tar.gz")
	// Write a sparse file of the target size using Truncate
	f, _ := os.Create(fakeFile)
	_ = f.Truncate(fakeSize)
	_ = f.Close()

	_, _, err = svc.CreateBackup(context.Background())
	if err == nil {
		t.Fatal("expected error for insufficient disk space, got nil")
	}
	if !strings.Contains(err.Error(), "insufficient disk space") {
		t.Errorf("expected 'insufficient disk space' in error, got: %v", err)
	}
}
```

Also add `"context"` and `"strings"` to the import block in `system_test.go` if not already present.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd api && go test ./internal/api/ -run TestSystemService_CreateBackup_InsufficientDisk -v
```

Expected: FAIL — `CreateBackup` returns nil error (no check yet).

- [ ] **Step 3: Add pre-flight disk check to `CreateBackup` in `system_service.go`**

Replace the existing `CreateBackup` function body. The function starts on line 29. Add a `largestBackupSize` helper and disk check before the tar.gz creation:

```go
func (s *SystemService) CreateBackup(ctx context.Context) (string, int64, error) {
	backupDir := filepath.Join(s.dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return "", 0, fmt.Errorf("failed to create backup directory: %w", err)
	}

	// Pre-flight: check disk space against the largest existing backup.
	if prevSize := s.largestBackupSize(backupDir); prevSize > 0 {
		disk, err := s.GetDiskInfo()
		if err == nil && disk.Free < int64(float64(prevSize)*1.5) {
			return "", 0, fmt.Errorf("insufficient disk space: need %d bytes (1.5× last backup), have %d free", int64(float64(prevSize)*1.5), disk.Free)
		}
	}

	timestamp := time.Now().Format("20060102_150405")
	backupName := fmt.Sprintf("backup_%s.tar.gz", timestamp)
	backupPath := filepath.Join(backupDir, backupName)

	if err := s.createTarGz(backupPath); err != nil {
		return "", 0, fmt.Errorf("backup failed: %w", err)
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		return backupName, 0, nil
	}

	return backupName, info.Size(), nil
}

// largestBackupSize returns the size in bytes of the largest .tar.gz in backupDir,
// or 0 if there are none.
func (s *SystemService) largestBackupSize(backupDir string) int64 {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return 0
	}
	var largest int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Size() > largest {
			largest = info.Size()
		}
	}
	return largest
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd api && go test ./internal/api/ -run TestSystemService_CreateBackup_InsufficientDisk -v
```

Expected: PASS

- [ ] **Step 5: Run all system tests to confirm no regressions**

```bash
cd api && go test ./internal/api/ -run TestSystem -v
```

Expected: all PASS

- [ ] **Step 6: Commit**

```bash
cd /home/light/src/blog/point
git add api/internal/services/system_service.go api/internal/api/system_test.go
git commit -m "feat(backup): guard CreateBackup against insufficient disk space"
```

---

## Task 3: Frontend — expose `getDiskInfo` + load in SystemPage

**Files:**
- Modify: `frontend/src/api/system.js`
- Modify: `frontend/src/pages/light/SystemPage.js`

- [ ] **Step 1: Add `getDiskInfo` to `frontend/src/api/system.js`**

Add after the `getVersion` export at the end of the file:

```js
/**
 * Get disk usage for the data directory.
 * @returns {Promise<{total: number, free: number, used: number}>}
 */
export function getDiskInfo() {
  return api.get('/api/system/disk');
}
```

- [ ] **Step 2: Import `getDiskInfo` in `SystemPage.js`**

Find the import line at the top of `frontend/src/pages/light/SystemPage.js`:

```js
  clearCache, listBackups,
  createBackup, restoreBackup, deleteBackup, getMigrations,
```

Replace with:

```js
  clearCache, listBackups,
  createBackup, restoreBackup, deleteBackup, getMigrations, getDiskInfo,
```

- [ ] **Step 3: Add `diskInfo` to initial state**

Find the `this.state = {` block in the constructor. Add `diskInfo: null` to it:

```js
    this.state = {
      loading: true,
      backups: [],
      migrations: [],
      creatingBackup: false,
      diskInfo: null,
      // ... (keep all existing state fields)
    };
```

(There are more fields — add `diskInfo: null` anywhere in the existing state object, don't remove any existing fields.)

- [ ] **Step 4: Load disk info in `_loadData`**

Find the `_loadData` method. It does a `Promise.all([listBackups(), getMigrations(), ...])`. Add `getDiskInfo()` to that promise:

```js
      const [backups, migrations, lastSync, queue, stats, diskInfo] = await Promise.all([
        listBackups(),
        getMigrations(),
        // ... (keep all existing calls in order)
        getDiskInfo().catch(() => null),
      ]);
      this.setState({ loading: false, backups, migrations, diskInfo, /* ...existing fields... */ });
```

Note: Use `.catch(() => null)` so a disk-info failure doesn't break the whole page load.

The exact shape of the `Promise.all` depends on the current code. Find the existing destructuring line that looks like:
```js
      const [backups, migrations, lastSync, queue, stats] = await Promise.all([
```
and add `diskInfo` as the last element of both the destructured array and the `Promise.all` array, followed by adding `diskInfo` to the `setState` call.

- [ ] **Step 5: Destructure `diskInfo` in `render()`**

Find the destructuring line in `render()`:
```js
    const { loading, error, backups, migrations, creatingBackup, updatingCoords, coordsResult, scanningMedia, scanResult, importConfigured } = this.state;
```

Add `diskInfo` to it.

- [ ] **Step 6: Commit (frontend wiring, no visible changes yet)**

```bash
cd /home/light/src/blog/point
git add frontend/src/api/system.js frontend/src/pages/light/SystemPage.js
git commit -m "feat(frontend): wire getDiskInfo into SystemPage state"
```

---

## Task 4: Frontend — render disk space and warning in Backup card

**Files:**
- Modify: `frontend/src/pages/light/SystemPage.js`
- Modify: `frontend/src/utils/helpers.js` (if `formatFileSize` is not already imported)

- [ ] **Step 1: Verify `formatFileSize` is available in SystemPage**

Search for `formatFileSize` in `SystemPage.js`. If it is already imported, skip to Step 2.

If not imported, find the import block at the top and add it. `formatFileSize` lives in `frontend/src/utils/formatters.js`:

```js
import { formatFileSize } from '../../utils/formatters.js';
```

(Check where it is actually defined by running: `grep -rn "export.*formatFileSize" frontend/src/`)

- [ ] **Step 2: Add a `_renderDiskInfo` helper method to SystemPage**

Add this method to the `SystemPage` class (before or after `_renderBackups`):

```js
  _renderDiskInfo(diskInfo, backups) {
    if (!diskInfo) return '';
    const free = diskInfo.free;
    const total = diskInfo.total;
    const usedPct = total > 0 ? Math.round((diskInfo.used / total) * 100) : 0;
    const lastBackupSize = backups.length > 0
      ? Math.max(...backups.map(b => b.size || 0))
      : 0;
    const isLow = lastBackupSize > 0 && free < lastBackupSize * 1.5;

    return `
      <div class="disk-info">
        <span class="disk-free">Free: <strong>${escapeHtml(formatFileSize(free))}</strong> of ${escapeHtml(formatFileSize(total))} (${usedPct}% used)</span>
      </div>
      ${isLow ? `
        <div class="backup-warning" role="alert">
          <strong>Low disk space.</strong> Free space (${escapeHtml(formatFileSize(free))}) may be insufficient for a new backup (estimated ${escapeHtml(formatFileSize(Math.round(lastBackupSize * 1.5)))} needed).
        </div>
      ` : ''}
    `;
  }
```

- [ ] **Step 3: Render disk info inside the Backup card**

Find the backup card template in `render()`:

```js
            ${enableBackup ? `
            <div class="card">
              <div class="card-header">
                <h2>Backups</h2>
                <div class="header-actions">
                  <button id="create-backup-btn" ...>
```

Replace with:

```js
            ${enableBackup ? `
            <div class="card">
              <div class="card-header">
                <h2>Backups</h2>
                <div class="header-actions">
                  <button id="create-backup-btn" class="btn btn-primary btn-sm" ${creatingBackup ? 'disabled' : ''}>
                    ${creatingBackup ? 'Creating…' : 'Create Backup'}
                  </button>
                </div>
              </div>
              <div class="card-body">
                ${this._renderDiskInfo(diskInfo, backups)}
                ${this._renderBackups(backups)}
              </div>
            </div>` : ''}
```

Note: This replaces the entire backup card. Make sure the `${this._renderBackups(backups)}` call that was previously there is still present.

- [ ] **Step 4: Add CSS for `.disk-info` and `.backup-warning`**

Edit `frontend/css/light/system.css` (or create it if it doesn't exist — check with `ls frontend/css/light/`).

Add to the end of the file:

```css
.disk-info {
  margin-bottom: var(--spacing-sm);
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.backup-warning {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-warning-bg, #fff3cd);
  color: var(--color-warning-text, #856404);
  border: 1px solid var(--color-warning-border, #ffc107);
  border-radius: var(--radius-sm);
  margin-bottom: var(--spacing-md);
  font-size: var(--text-sm);
}
```

- [ ] **Step 5: Rebuild CSS bundle**

```bash
cd /home/light/src/blog/point && ./scripts/build-css.sh
```

Expected: outputs `frontend/css/light.bundle.css` with new rules.

- [ ] **Step 6: Commit**

```bash
cd /home/light/src/blog/point
git add frontend/src/pages/light/SystemPage.js frontend/css/light/system.css frontend/css/light.bundle.css
git commit -m "feat(system): display disk free space and low-space warning in Backup card"
```

---

## Task 5: Verify "Enable backup" setting is wired end-to-end

**Files:**
- Read: `api/internal/services/scheduler.go` (no changes expected)
- Read: `frontend/src/pages/light/SystemPage.js` (no changes expected)

This task is an audit, not an implementation. Findings are documented inline.

- [ ] **Step 1: Confirm scheduler respects the setting**

Read `api/internal/services/scheduler.go` lines 57-65. The daily backup task reads `enable_backup` from settings and returns early if it is not `"true"`. This is correct — if a user sets `enable_backup = false` in the UI, the daily scheduled backup will be skipped.

- [ ] **Step 2: Confirm UI hides backup card when disabled**

Read `SystemPage.js` lines 59 and 172. The `enableBackup` flag is derived from `settings.enable_backup !== false`. The entire Backup card (including the manual "Create Backup" button) is conditionally rendered only when `enableBackup` is true.

Conclusion: The setting works correctly. Both the scheduler and the manual UI respect it. No code changes needed.

- [ ] **Step 3: Confirm settings API persists the toggle**

`enable_backup` is listed under the `'Storage & System'` group in `SettingsPage.js` (line 26). The `updateSettings` call in `SettingsPage.js` sends the value to `PUT /api/settings`, which persists it in `blog_settings`. When SystemPage loads, it reads from `store.get('settings')` which is populated by `getAllSettings()`.

Conclusion: No gaps. The setting is persisted via the standard settings API and read back correctly.

- [ ] **Step 4: Commit (audit note only if any minor fix was needed)**

If no code was changed in this task, no commit is needed.

---

## Task 6: Run full test suite and final check

- [ ] **Step 1: Run all Go tests**

```bash
cd /home/light/src/blog/point && ./scripts/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 2: Build the CSS bundle (already done in Task 4, re-verify)**

```bash
grep "disk-info\|backup-warning" frontend/css/light.bundle.css
```

Expected: both class names appear.

- [ ] **Step 3: Close the beads issue**

```bash
bd close point-e9h --reason="Disk space endpoint added, pre-backup space guard implemented, warning shown in UI, enable_backup setting verified"
```

- [ ] **Step 4: Push**

```bash
git pull --rebase && bd dolt push && git push
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Show free space in `/light` | Task 3 + Task 4 |
| Pre-backup free-space check (1.5× last backup) | Task 2 |
| Warning in backup block | Task 4 |
| Verify "Enable backup" setting | Task 5 |

**Gaps:**
- The spec says "show free space in the beginning of backup block" — Task 4 places `.disk-info` before `.backup-warning` before the backup list, which satisfies this.
- No DB schema changes — disk space is runtime, last backup size comes from the existing `listBackups` response.
- `getDiskInfo().catch(() => null)` ensures a disk-stat failure on unusual filesystems doesn't break the System page.
- The `largestBackupSize` helper uses largest (not most recent) backup as a conservative estimate. This is intentional — it's safer to over-estimate.
