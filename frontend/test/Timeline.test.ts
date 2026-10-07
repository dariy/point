import { test, describe } from 'node:test';
import assert from 'node:assert';
import { yearsOf, renderTimeline, yearOfTag, yearWindow, stepYear, Timeline } from '../src/plugins/timeline/index.ts';
import type { TimelinePill } from '../src/api/timeline.ts';

const pill = (year: number, is_decade = false): TimelinePill => ({
  slug: String(year), name: String(year), year, is_decade, post_count: 1,
});

const markup = (years: number[], scope: { from: number, to: number } | null) =>
  String(renderTimeline(years, scope));

describe('yearsOf', () => {
  test('keeps years only, ascending, without repeats', () => {
    assert.deepStrictEqual(yearsOf([pill(2026), pill(2020, true), pill(2024), pill(2024)]), [2024, 2026]);
  });
});

describe('renderTimeline', () => {
  test('collapsed: exactly one "All years" pill', () => {
    const out = markup([2024, 2025, 2026], null);
    assert.strictEqual(out.match(/<button/g)?.length, 1);
    assert.match(out, />All years</);
    assert.doesNotMatch(out, /2025/);
  });

  test('expanded: a maximum of 3 pills around the active year', () => {
    const out = markup([2020, 2021, 2022, 2023, 2024], { from: 2022, to: 2022 });
    assert.strictEqual(out.match(/<button/g)?.length, 3);
    assert.match(out, /data-year="2021"/);
    assert.match(out, /data-year="2023"/);
    assert.doesNotMatch(out, /data-year="2020"|data-year="2024"/);
    assert.match(out, /has-more-before has-more-after/);
  });

  test('expanded: no indicator on the side with no hidden years', () => {
    const first = markup([2020, 2021, 2022], { from: 2020, to: 2020 });
    assert.doesNotMatch(first, /has-more-before/);
    assert.match(first, /has-more-after/);
    assert.match(first, /is-expanded has-more-after has-next"/);
  });

  test('expanded: one pill per year, ascending, no arrows', () => {
    const out = markup([2024, 2025, 2026], { from: 2025, to: 2025 });
    assert.strictEqual(out.match(/<button/g)?.length, 3);
    assert.ok(out.indexOf('>2024<') < out.indexOf('>2025<') && out.indexOf('>2025<') < out.indexOf('>2026<'));
    assert.doesNotMatch(out, /All years|‹|›|&lt;|&gt;|nav-btn/);
  });

  test('expanded: only the scope pill is active', () => {
    const out = markup([2024, 2025, 2026], { from: 2025, to: 2025 });
    assert.strictEqual(out.match(/aria-pressed="true"/g)?.length, 1);
    assert.match(out, /is-active" data-action="pick" data-year="2025" aria-pressed="true"/);
    assert.match(out, /data-year="2024" aria-pressed="false"/);
  });

  test('every pill is a button', () => {
    const out = markup([2024, 2025], { from: 2024, to: 2024 });
    assert.strictEqual(out.match(/<button type="button"/g)?.length, 2);
  });
});

describe('yearOfTag', () => {
  test('a year tag gives its year', () => {
    assert.strictEqual(yearOfTag({ kind: 'year', slug: '2026' }), 2026);
  });

  test('other kinds and bad slugs give null', () => {
    assert.strictEqual(yearOfTag({ kind: 'tag', slug: '2026' }), null);
    assert.strictEqual(yearOfTag({ kind: 'year', slug: 'abc' }), null);
    assert.strictEqual(yearOfTag(null), null);
  });
});

describe('yearWindow', () => {
  const years = [2020, 2021, 2022, 2023];
  test('middle year: before, active, after; hidden on both sides when more', () => {
    assert.deepStrictEqual(yearWindow(years, 2021), { shown: [2020, 2021, 2022], moreBefore: false, moreAfter: true });
    assert.deepStrictEqual(yearWindow(years, 2022), { shown: [2021, 2022, 2023], moreBefore: true, moreAfter: false });
  });
  test('first year has no before pill; last year has no after pill', () => {
    assert.deepStrictEqual(yearWindow(years, 2020), { shown: [2020, 2021], moreBefore: false, moreAfter: true });
    assert.deepStrictEqual(yearWindow(years, 2023), { shown: [2022, 2023], moreBefore: true, moreAfter: false });
  });
  test('one year: one pill, no indicators', () => {
    assert.deepStrictEqual(yearWindow([2024], 2024), { shown: [2024], moreBefore: false, moreAfter: false });
  });
});

describe('stepYear / slide', () => {
  test('adjacent year, null at the edges', () => {
    assert.strictEqual(stepYear([2020, 2022, 2025], 2022, -1), 2020);
    assert.strictEqual(stepYear([2020, 2022, 2025], 2022, 1), 2025);
    assert.strictEqual(stepYear([2020, 2022], 2020, -1), null);
    assert.strictEqual(stepYear([2020, 2022], 2022, 1), null);
  });

  test('a slide step calls focusYear with the adjacent year', () => {
    const calls: number[] = [];
    const host = { state: { years: [2020, 2021, 2022], scope: { from: 2021, to: 2021 } }, focusYear: (y: number) => calls.push(y) };
    Timeline.prototype.slide.call(host, 1);
    Timeline.prototype.slide.call(host, -1);
    host.state.scope = { from: 2022, to: 2022 };
    Timeline.prototype.slide.call(host, 1);
    assert.deepStrictEqual(calls, [2022, 2020]);
  });
});

describe('drag preview', () => {
  const host = () => {
    const calls: number[] = [];
    const h = {
      calls,
      state: { years: [2020, 2021, 2022, 2023], scope: { from: 2023, to: 2023 }, preview: null as number | null },
      setState(d: object) { Object.assign(h.state, d); },
      focusYear: (y: number) => calls.push(y),
      _rerender() {},
    };
    return h;
  };

  test('steps move the preview only; focusYear runs once on commit', () => {
    const h = host();
    Timeline.prototype._previewStep.call(h, -1);
    Timeline.prototype._previewStep.call(h, -1);
    assert.strictEqual(h.state.preview, 2021);
    assert.deepStrictEqual(h.calls, []);
    Timeline.prototype._commitPreview.call(h);
    assert.deepStrictEqual(h.calls, [2021]);
    assert.strictEqual(h.state.preview, null);
  });

  test('no preview: commit does nothing; the preview stops at the edge', () => {
    const h = host();
    Timeline.prototype._commitPreview.call(h);
    Timeline.prototype._previewStep.call(h, 1);
    assert.strictEqual(h.state.preview, null);
    assert.deepStrictEqual(h.calls, []);
  });
});
