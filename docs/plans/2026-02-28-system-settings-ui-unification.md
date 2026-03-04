# System & Settings UI Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework `/light/system` and `/light/settings` to use the same card/form patterns as the rest of the admin (Security, Dashboard pages) and clean up duplicate/unused CSS.

**Architecture:** No new components or API calls. Pure HTML structure + CSS class name fixes in two page components, plus CSS cleanup in their corresponding stylesheets.

**Tech Stack:** Vanilla JS SPA components, CSS custom properties/tokens.

---

## Reference: Established Patterns

These patterns are already used by SecurityPage and SettingsPage and must be applied consistently:

**Card structure:**
```html
<div class="card">
  <div class="card-header">
    <h2>Title</h2>
    <div class="header-actions"><!-- optional buttons/selects --></div>
  </div>
  <div class="card-body">…</div>
</div>
```

**Collapsible card** (cards.css already supports `.card.collapsed`):
```html
<div class="card" id="migrations-card">
  <div class="card-header">
    <h2>Title</h2>
    <span class="toggle-icon">${CHEVRON_SVG}</span>
  </div>
  <div class="card-body">…</div>
</div>
```
Click handler: `card.classList.toggle('collapsed')`. Card starts with `class="card collapsed"`.

**Op-item row** (title+description on left, action button on right):
```html
<div class="ops-list">
  <div class="op-item">
    <div class="op-info">
      <h4>Operation Name</h4>
      <p>Short description of what it does.</p>
    </div>
    <button class="btn btn-secondary">Action</button>
  </div>
</div>
```

**Backup item card:**
```html
<div class="backup-item">
  <div class="backup-info">
    <div class="backup-filename">filename.zip</div>
    <div class="backup-meta">
      <span class="backup-date">2026-01-01</span>
      <span class="backup-size">1.2 MB</span>
    </div>
  </div>
  <div class="backup-actions">
    <button class="btn btn-sm restore-backup-btn" data-file="…" title="Restore">${RESTORE_SVG}</button>
    <button class="btn btn-sm btn-danger delete-backup-btn" data-file="…">✕</button>
  </div>
</div>
```

**Form label:** `<label class="form-label">Field Name</label>`

**Checkbox:**
```html
<div class="form-checkbox">
  <label class="checkbox-label">
    <input type="checkbox" name="${key}" class="form-checkbox-input" ${checked ? 'checked' : ''}>
    Label Text
  </label>
</div>
```

**Select:** `<select name="${key}" class="form-select">…</select>`

**Textarea:** `<textarea name="${key}" class="form-input form-textarea" rows="3">…</textarea>`

---

## Task 1: Rewrite SystemPage.js

**File:** `frontend/src/pages/light/SystemPage.js`

**Changes:**
1. Remove state fields: `stats`, `logs`, `logType`, `logLines`, `loadingLogs`
2. Remove imports: nothing — keep all existing imports
3. Rewrite `render()` to produce three cards (see below)
4. Remove `_loadLogs()` method entirely
5. In `_loadInitial()`: remove `getStats()` and `getLogs()` calls, keep only `listBackups()` and `getMigrations()`
6. In `afterRender()`: remove the log-related event listeners (`#log-type-select`, `#log-lines-select`, `#refresh-logs-btn`)
7. Add a collapse toggle for the migrations card

**Complete new `render()` output structure:**

```javascript
render() {
  const { loading, error, backups, migrations, creatingBackup, updatingCoords, coordsResult } = this.state;

  if (loading) {
    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header"><h1>System</h1></header>
          <main class="light-content">
            <div class="loading-spinner" aria-label="Loading system data…"></div>
          </main>
        </div>
      </div>`;
  }

  if (error) {
    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header"><h1>System</h1></header>
          <main class="light-content">
            <p class="error-state" role="alert">${escapeHtml(error)}</p>
          </main>
        </div>
      </div>`;
  }

  return `
    <div class="light-layout">
      <div id="sidebar-mount"></div>
      <div class="light-main">
        <header class="light-header">
          <h1>System</h1>
        </header>
        <main class="light-content">

          <div class="card">
            <div class="card-header"><h2>Maintenance</h2></div>
            <div class="card-body">
              <div class="ops-list">
                <div class="op-item">
                  <div class="op-info">
                    <h4>Clear Cache</h4>
                    <p>Clear the server-side file cache (thumbnails, optimized images).</p>
                  </div>
                  <button id="clear-cache-btn" class="btn btn-secondary">Clear Cache</button>
                </div>
                <div class="op-item">
                  <div class="op-info">
                    <h4>Update Map Coordinates</h4>
                    <p>Auto-geocode tags under <strong>city / cities / country / countries</strong> that have no coordinates yet. Uses OpenStreetMap Nominatim (rate-limited — may take a while).</p>
                  </div>
                  <button id="update-coords-btn" class="btn btn-secondary" ${updatingCoords ? 'disabled' : ''}>
                    ${updatingCoords ? 'Geocoding…' : 'Update Coordinates'}
                  </button>
                </div>
              </div>
              ${coordsResult ? this._renderCoordsResult(coordsResult) : ''}
            </div>
          </div>

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
              ${this._renderBackups(backups)}
            </div>
          </div>

          <div class="card collapsed" id="migrations-card">
            <div class="card-header">
              <h2>Database Migrations</h2>
              <span class="toggle-icon">${CHEVRON_SVG}</span>
            </div>
            <div class="card-body">
              <div class="table-container">
                <table class="table">
                  <thead><tr><th>Migration</th><th>Applied At</th></tr></thead>
                  <tbody>
                    ${migrations.map(m => `
                      <tr>
                        <td><code>${escapeHtml(m.name)}</code></td>
                        <td>${escapeHtml(formatDateShort(m.applied_at))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        </main>
      </div>
    </div>`;
}
```

**New `_renderBackups()`:**
```javascript
_renderBackups(backups) {
  if (!backups.length) return '<p class="empty-state">No backups found.</p>';
  return backups.map(b => `
    <div class="backup-item">
      <div class="backup-info">
        <div class="backup-filename" title="${escapeHtml(b.filename)}">${escapeHtml(b.filename)}</div>
        <div class="backup-meta">
          <span class="backup-date">${escapeHtml(formatDateShort(b.created_at || b.modified_at || ''))}</span>
          <span class="backup-size">${escapeHtml(formatFileSize(b.size))}</span>
        </div>
      </div>
      <div class="backup-actions">
        <button class="btn btn-sm restore-backup-btn" data-file="${escapeHtml(b.filename)}" title="Restore">${RESTORE_SVG}</button>
        <button class="btn btn-sm btn-danger delete-backup-btn" data-file="${escapeHtml(b.filename)}">✕</button>
      </div>
    </div>
  `).join('');
}
```

**New `_loadInitial()`:**
```javascript
async _loadInitial() {
  this.setState({ loading: true, error: null });
  try {
    const [backups, migrations] = await Promise.all([
      listBackups(),
      getMigrations(),
    ]);
    this.setState({ loading: false, backups, migrations });
  } catch (err) {
    this.setState({ loading: false, error: err.message || 'Failed to load system data.' });
  }
}
```

**Add to `afterRender()` (replace log listener block with toggle):**
```javascript
// Migrations collapse toggle
this.$('#migrations-card .card-header')?.addEventListener('click', () => {
  this.$('#migrations-card')?.classList.toggle('collapsed');
});
```

**Remove from `afterRender()`:**
- The three log-related listeners (`#log-type-select`, `#log-lines-select`, `#refresh-logs-btn`)

**Remove unused import:**
- `getStats` and `getLogs` from the import line (keep the rest)

**No changes needed to:**
- `_handleClearCache`, `_handleCreateBackup`, `_handleRestoreBackup`, `_handleDeleteBackup`, `_handleUpdateCoords`, `_renderCoordsResult`, `_showConfirm`, `_handleLogout`

**Step: Verify backup API shape**

Before finalising `_renderBackups`, check what fields `listBackups()` actually returns by reading `frontend/src/api/system.js`. The backup date field might be `created_at`, `modified_at`, or embedded in the filename. Adjust `_renderBackups` accordingly — if there's no date field, just omit the `.backup-date` span.

---

## Task 2: Clean up system.css

**File:** `frontend/css/light/system.css`

Remove these blocks entirely (unused or superseded by cards.css / dashboard.css / common CSS):
- `.system-grid` — use `.grid-2-col` from dashboard.css (not needed now anyway)
- `.system-card` — use `.card` from cards.css
- `.card-header` (the duplicate in system.css) — already in cards.css; **check for any overrides that are actually needed before deleting**
- `.card-title`
- `.stats-list`, `.stat-item`, `.stat-label`, `.stat-value`
- `.log-viewer`, `.log-content`, `.log-line`, `.log-line.empty`, `.log-line.error`
- `.header-actions select` and its hover/focus/option variants — log viewer controls removed
- `.backups-card .ops-list` — overly specific
- `.loading`, `.empty-state`, `.error-state` — in common/empty-state.css
- `.btn-toggle`, `.btn-toggle .arrow` — replaced by `.toggle-icon` from cards.css
- `.system-card.collapsed …` — replaced by `.card.collapsed` from cards.css
- The second `.card-header { cursor: pointer; user-select: none; }` block at line 276
- `#thumbnail-controls`, `.thumbnail-settings-row` and children — not present in SystemPage

**Keep:**
- `.ops-list`, `.op-item`, `.op-info h4`, `.op-info p`
- `.backups-list`, `.migrations-list` (used for max-height scroll)
- `.backup-item`, `.backup-item:hover`, `.backup-item:last-child`
- `.backup-info`, `.backup-filename`, `.backup-meta`, `.backup-date::before`, `.backup-size::before`
- `.backup-actions`

---

## Task 3: Fix SettingsPage.js

**File:** `frontend/src/pages/light/SettingsPage.js`

In `_renderGroup()`, three fixes:

**Fix 1 — Labels:** Change `<label>` to `<label class="form-label">`:
```javascript
// Before:
return `<div class="form-group ${isCheckbox ? 'checkbox-group' : ''}">
  ${isCheckbox ? '' : `<label>${escapeHtml(label)}</label>`}
  ${input}
  ${isCheckbox ? `<label>${escapeHtml(label)}</label>` : ''}
</div>`;

// After:
return isCheckbox
  ? `<div class="form-checkbox">
       <label class="checkbox-label">
         ${input}
         ${escapeHtml(label)}
       </label>
     </div>`
  : `<div class="form-group">
       <label class="form-label">${escapeHtml(label)}</label>
       ${input}
     </div>`;
```

**Fix 2 — Checkbox input:** The `input` variable for checkboxes must not include `class="form-input"` (checkboxes use `form-checkbox-input`):
```javascript
// Before:
input = `<input type="checkbox" name="${key}" ${checked ? 'checked' : ''}>`;

// After:
input = `<input type="checkbox" name="${key}" class="form-checkbox-input" ${checked ? 'checked' : ''}>`;
```

**Fix 3 — Select:** Change `class="form-input"` to `class="form-select"` on select elements:
```javascript
// Before:
input = `<select name="${key}" class="form-input">…</select>`;

// After:
input = `<select name="${key}" class="form-select">…</select>`;
```

**Fix 4 — Form actions inline style:** Remove `style="margin-top: var(--spacing-xl)"`:
```javascript
// Before:
<div class="form-actions" style="margin-top: var(--spacing-xl)">

// After:
<div class="form-actions">
```
(The margin will be added to `settings.css` in Task 4.)

---

## Task 4: Clean up settings.css

**File:** `frontend/css/light/settings.css`

**Remove** (all defined in `frontend/css/common/forms.css`):
- `.form-group { margin-bottom: 20px; }` — forms.css already has it
- `.form-group label { … }` — replaced by `.form-label` in forms.css
- `.form-group input[type=…], .form-group select { … }` — replaced by `.form-input` / `.form-select`
- `.form-group select { … }` (the styled dropdown block) — `.form-select` in forms.css
- `.form-group select:hover`, `.form-group select:focus`, `.form-group select option` — in forms.css
- `.form-row` — not used in current SettingsPage
- `.form-help { … }` — in forms.css
- `.checkbox-group { … }` — replaced by `.form-checkbox` in forms.css
- `.checkbox-label { … }` (the settings.css version) — in forms.css
- `.checkbox-label input { … }` — replaced by `.form-checkbox-input`

**Update:**
- `.form-actions`: add `margin-top: var(--spacing-xl)` to the existing rule

**Keep:**
- `.settings-container`
- `.form-section`, `.section-title` (may be used elsewhere or kept for future use)
- `.form-actions` (with updated margin-top)
- `.save-status`, `.save-status.success`, `.save-status.error`
- `.input-with-button` and children
- `.btn-sm`
- `.connection-test-result` and variants

---

## Task 5: Check the backup API response shape

**File:** `frontend/src/api/system.js`

Read the file and confirm what fields a backup object has. The `_renderBackups` method in Task 1 references `b.created_at || b.modified_at`. If neither exists (e.g. date is parsed from filename), adjust the `.backup-date` span to show the right value or remove it.

---

## Task 6: Build and verify

```bash
cd /home/light/src/blog/point
build/rebuild.sh
```

Then manually visit:
- `/light/system` — check Maintenance card, Backups card, collapsed Migrations card
- `/light/settings` — check labels, checkboxes, selects are styled correctly

---

## Commit

```bash
git add frontend/src/pages/light/SystemPage.js \
        frontend/css/light/system.css \
        frontend/src/pages/light/SettingsPage.js \
        frontend/css/light/settings.css
git commit -m "refactor: unify System and Settings page UI with admin patterns"
```
