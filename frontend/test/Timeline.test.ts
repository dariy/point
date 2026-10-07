import { test, describe } from 'node:test';
import assert from 'node:assert';
import { yearsOf, renderTimeline } from '../src/plugins/timeline/index.ts';
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
