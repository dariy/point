import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * The folder chip strip replaces the folder tree on narrow screens. A row has
 * space for one level of the hierarchy, so the chips drill down: years at the
 * root, then the months of whichever year is in context.
 */
describe('folderChips', () => {
  let folderChips, groupFoldersByYear;

  const FOLDERS = [
    { year: '2026', month: '08', path: '2026/08' },
    { year: '2026', month: '07', path: '2026/07' },
    { year: '2025', month: '12', path: '2025/12' },
    { year: '2024', month: '01', path: '2024/01' },
  ];

  before(async () => {
    ({ folderChips, groupFoldersByYear } = await import('../src/utils/mediaFolders.js'));
  });

  test('at the root: All media plus one chip per year, newest first', () => {
    const chips = folderChips(FOLDERS, null);
    assert.deepStrictEqual(
      chips.map((c) => c.label),
      ['All media', '2026', '2025', '2024'],
    );
    assert.ok(chips[0].active, '"All media" is the active folder at the root');
    assert.ok(!chips.slice(1).some((c) => c.active));
  });

  test('inside a year: back chip, the year, and only that year\'s months', () => {
    const chips = folderChips(FOLDERS, '2026');
    assert.deepStrictEqual(
      chips.map((c) => c.label),
      ['‹ All', '2026', 'Aug', 'Jul'],
    );
    assert.deepStrictEqual(
      chips.map((c) => c.folder),
      ['', '2026', '2026/08', '2026/07'],
    );
    assert.ok(chips[1].active, 'the year itself is selected');
    assert.ok(!chips.some((c) => c.label === 'Dec'), 'other years stay collapsed');
  });

  test('inside a month: the month is active, its year is not', () => {
    const chips = folderChips(FOLDERS, '2026/08');
    const aug = chips.find((c) => c.label === 'Aug');
    const year = chips.find((c) => c.kind === 'year');
    assert.ok(aug.active);
    assert.ok(!year.active);
    assert.strictEqual(chips[0].kind, 'back');
  });

  test('month numbers become names', () => {
    const chips = folderChips([{ year: '2025', month: '12', path: '2025/12' }], '2025');
    assert.strictEqual(chips.at(-1).label, 'Dec');
  });

  test('an unknown folder falls back to the root chips', () => {
    // Folders load after the first render, and a deep link can name a folder
    // the list does not have — neither may produce a strip with no way back.
    assert.deepStrictEqual(
      folderChips([], '2026/08').map((c) => c.label),
      ['All media'],
    );
    assert.deepStrictEqual(
      folderChips(FOLDERS, '1999').map((c) => c.label),
      ['All media', '2026', '2025', '2024'],
    );
  });

  test('groupFoldersByYear keeps years descending', () => {
    const { years, byYear } = groupFoldersByYear(FOLDERS);
    assert.deepStrictEqual(years, ['2026', '2025', '2024']);
    assert.strictEqual(byYear['2026'].length, 2);
  });
});
