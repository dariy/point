/**
 * The Health section of the System page and the health dot of the dashboard
 * (NF-14). The markup is tied to the report shape of
 * GET /api/system/health/checks (services.SiteHealthReport).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.ts';
import type { SiteHealthReport } from '../src/api/system.ts';

const okReport: SiteHealthReport = {
  checked_at: new Date(Date.now() - 120_000).toISOString(),
  duration_ms: 12,
  status: 'ok',
  items: [
    { key: 'derivatives', status: 'ok', count: 0 },
    { key: 'originals', status: 'ok', count: 0 },
    { key: 'references', status: 'ok', count: 0 },
    { key: 'backup', status: 'ok', count: 0, at: new Date(Date.now() - 3_600_000).toISOString() },
    { key: 'restore_check', status: 'ok', count: 0, at: new Date(Date.now() - 86_400_000).toISOString() },
    { key: 'storage', status: 'ok', count: 0, free_bytes: 50 * 2 ** 30, total_bytes: 100 * 2 ** 30 },
  ],
};

const badReport: SiteHealthReport = {
  checked_at: new Date().toISOString(),
  duration_ms: 40,
  status: 'fail',
  items: [
    { key: 'derivatives', status: 'warn', count: 3, ids: [11, 12, 13], detail: 'media with missing derivatives' },
    { key: 'originals', status: 'fail', count: 1, ids: [21], detail: 'media whose original file is missing' },
    { key: 'references', status: 'fail', count: 2, ids: [7, 8], samples: ['/2024/05/gone.jpg'], detail: 'published posts that show missing media' },
    { key: 'backup', status: 'fail', count: 0, detail: 'no backup exists' },
    { key: 'restore_check', status: 'warn', count: 0, detail: 'no restore check has run' },
    { key: 'storage', status: 'warn', count: 0, free_bytes: 5 * 2 ** 30, total_bytes: 100 * 2 ** 30, detail: 'free storage is under 10 %' },
  ],
};

const noJobs = { counts: { queued: 0, running: 0, failed: 0, done: 4 }, jobs: [] };
const failedJobs = {
  counts: { queued: 0, running: 0, failed: 2, done: 0 },
  jobs: [
    { id: 42, kind: 'video_transcode', state: 'failed' as const, attempts: 3, max_attempts: 3, next_run_at: '', last_error: 'ffmpeg exited 1' },
    { id: 41, kind: 'video_poster', state: 'failed' as const, attempts: 3, max_attempts: 3, next_run_at: '', last_error: 'older error' },
  ],
};

describe('System page Health section', () => {
  let dom: ReturnType<typeof setupDOM>;
  let SystemPage: typeof import('../src/pages/light/SystemPage.ts').default;

  before(async () => {
    dom = setupDOM();
    SystemPage = (await import('../src/pages/light/SystemPage.ts')).default;
  });

  after(() => { dom.cleanup(); });

  function pageMarkup(state: object) {
    const page = new SystemPage(document.createElement('div'), {});
    Object.assign(page.state, {
      loading: false, migrations: [], diskInfo: { total: 100, free: 40, used: 60 },
      health: { tasks: [], degraded: 0, uptime: 60 }, jobs: noJobs, checks: okReport,
    }, state);
    const el = document.createElement('div');
    el.innerHTML = String(page.render());
    return el;
  }

  test('one Health section groups the checks, the job queue, the background jobs and the disk', () => {
    const el = pageMarkup({});
    const health = el.querySelector('#health');
    assert.ok(health, 'the section has the id the dashboard dot links to');
    assert.equal(health.querySelector('h2')?.textContent, 'Health');
    const titles = [...health.querySelectorAll('h3')].map((h) => h.textContent);
    assert.deepEqual(titles, ['Site checks', 'Job Queue', 'Background Jobs', 'Disk Usage (Server)']);
  });

  test('every item is ok: each row shows OK and no repair action', () => {
    const el = pageMarkup({});
    const rows = [...el.querySelectorAll('[data-health-item]')];
    assert.deepEqual(rows.map((r) => r.getAttribute('data-health-item')),
      ['jobs', 'derivatives', 'originals', 'references', 'backup', 'restore_check', 'storage']);
    for (const r of rows) assert.equal(r.getAttribute('data-status'), 'ok');
    assert.equal(el.querySelector('#health-rebuild-btn'), null);
    assert.equal(el.querySelector('.health-item [data-retry-job]'), null);
    assert.match(el.querySelector('[data-health-item="storage"]')!.textContent!, /50(\.0)? GB free of 100(\.0)? GB/);
  });

  test('problems show their status and their repair actions', () => {
    const el = pageMarkup({ checks: badReport, jobs: failedJobs });
    const status = (k: string) => el.querySelector(`[data-health-item="${k}"]`)!.getAttribute('data-status');
    assert.equal(status('jobs'), 'warn');
    assert.equal(status('derivatives'), 'warn');
    assert.equal(status('originals'), 'fail');
    assert.equal(status('references'), 'fail');

    // Failed jobs: the newest failed job, its last error, and a retry.
    const jobs = el.querySelector('[data-health-item="jobs"]')!;
    assert.match(jobs.textContent!, /2 failed jobs/);
    assert.match(jobs.textContent!, /ffmpeg exited 1/);
    assert.equal(jobs.querySelector('[data-retry-job]')?.getAttribute('data-retry-job'), '42');

    // Derivatives: the rebuild action.
    assert.ok(el.querySelector('[data-health-item="derivatives"] #health-rebuild-btn'));

    // References: open each post, and the sample path.
    const refs = el.querySelector('[data-health-item="references"]')!;
    const hrefs = [...refs.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['/light/posts/7/edit', '/light/posts/8/edit']);
    assert.match(refs.textContent!, /\/2024\/05\/gone\.jpg/);

    // Backup with no time: the server detail as a sentence.
    assert.match(el.querySelector('[data-health-item="backup"]')!.textContent!, /No backup exists\./);
  });

  test('backups off: the backup and restore check items are info with an Enable backups link', () => {
    const items = okReport.items.map((i) => i.key === 'backup' || i.key === 'restore_check'
      ? { key: i.key, status: 'info' as const, count: 0, detail: 'scheduled backups are off' }
      : i);
    const el = pageMarkup({ checks: { ...okReport, status: 'info', items } });
    for (const k of ['backup', 'restore_check']) {
      const row = el.querySelector(`[data-health-item="${k}"]`)!;
      assert.equal(row.getAttribute('data-status'), 'info');
      assert.match(row.textContent!, /Info/);
      assert.match(row.textContent!, /Scheduled backups are off\./);
      assert.equal(row.querySelector('[data-enable-backups]')?.getAttribute('href'), '/light/plugins?plugin=backups');
    }
    // An ok or a failed backup has no Enable backups link.
    assert.equal(pageMarkup({}).querySelector('[data-enable-backups]'), null);
    assert.equal(pageMarkup({ checks: badReport }).querySelector('[data-enable-backups]'), null);
  });

  test('a partial check says that its count is not complete', () => {
    const report = { ...badReport, items: [{ key: 'derivatives' as const, status: 'ok' as const, count: 0, partial: true }] };
    const el = pageMarkup({ checks: report });
    assert.match(el.querySelector('[data-health-item="derivatives"]')!.textContent!, /not complete/);
  });

  test('no report: the section still renders the jobs and says the checks are not available', () => {
    const el = pageMarkup({ checks: null });
    assert.match(el.querySelector('[data-testid="health-checks"]')!.textContent!, /not available/);
    assert.ok(el.querySelector('[data-health-item="jobs"]'));
  });

  test('the rebuild sends the ids of the derivatives item, then runs the checks again', async () => {
    const calls: Array<{ url: string, method: string, body: unknown }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      const payload = String(url).includes('/derivatives/rebuild')
        ? { rebuilt: 3, video_jobs: 0, failed: [] }
        : okReport;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const container = document.createElement('div');
      const page = new SystemPage(container, {});
      Object.assign(page.state, { loading: false, migrations: [], jobs: noJobs, checks: badReport });
      await page._handleRebuildDerivatives();
      const rebuild = calls.find((c) => c.url.includes('/api/media/derivatives/rebuild'));
      assert.ok(rebuild, 'the rebuild endpoint was called');
      assert.equal(rebuild.method, 'POST');
      assert.deepEqual(rebuild.body, { ids: [11, 12, 13] });
      const refresh = calls.find((c) => c.url.includes('/api/system/health/checks'));
      assert.equal(refresh?.method, 'POST');
      assert.equal(page.state.checks.status, 'ok');
      assert.equal(page.state.rebuildingDerivatives, false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('Dashboard health dot', () => {
  let dom: ReturnType<typeof setupDOM>;
  let DashboardPage: typeof import('../src/pages/light/DashboardPage.ts').default;
  let healthDotStatus: typeof import('../src/api/system.ts').healthDotStatus;

  before(async () => {
    dom = setupDOM();
    DashboardPage = (await import('../src/pages/light/DashboardPage.ts')).default;
    ({ healthDotStatus } = await import('../src/api/system.ts'));
  });

  after(() => { dom.cleanup(); });

  function dotOf(healthDot: string | null) {
    const page = new DashboardPage(document.createElement('div'), {});
    Object.assign(page.state, { loading: false, stats: null, healthDot });
    const el = document.createElement('div');
    el.innerHTML = String(page.render());
    return el.querySelectorAll('[data-testid="health-dot"]');
  }

  test('no dot when every item is ok', () => {
    assert.equal(dotOf(null).length, 0);
  });

  test('one dot that links to the Health section', () => {
    for (const s of ['warn', 'fail']) {
      const dots = dotOf(s);
      assert.equal(dots.length, 1);
      assert.equal(dots[0].getAttribute('href'), '/light/system#health');
      assert.ok(dots[0].classList.contains(`health-dot--${s}`));
      assert.ok(dots[0].getAttribute('aria-label'));
    }
  });

  test('the dot status is the worst item; a failed job is warn', () => {
    assert.equal(healthDotStatus(null, 0), null);
    assert.equal(healthDotStatus(okReport, 0), null);
    assert.equal(healthDotStatus(okReport, 1), 'warn');
    const warn = { ...okReport, items: [{ key: 'backup' as const, status: 'warn' as const, count: 0 }] };
    assert.equal(healthDotStatus(warn, 0), 'warn');
    assert.equal(healthDotStatus(badReport, 0), 'fail');
  });

  test('backups off is info: no dot; a stale or failed backup shows the dot', () => {
    const withBackup = (status: 'ok' | 'info' | 'warn' | 'fail') => ({
      ...okReport,
      items: okReport.items.map((i) => (i.key === 'backup' ? { ...i, status } : i)),
    });
    assert.equal(healthDotStatus(withBackup('info'), 0), null);
    assert.equal(healthDotStatus(withBackup('ok'), 0), null);
    assert.equal(healthDotStatus(withBackup('warn'), 0), 'warn');
    assert.equal(healthDotStatus(withBackup('fail'), 0), 'fail');
  });
});
