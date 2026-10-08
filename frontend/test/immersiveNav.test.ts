import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';
import type * as ImmersiveNav from '../src/utils/immersiveNav.ts';

type StateDelta = Parameters<ImmersiveNav.ImmersivePage['setState']>[0];
interface FakePage extends ImmersiveNav.ImmersivePage {
  stateCalls: StateDelta[];
}

describe('immersiveNav', () => {
  let enterImmersive: typeof ImmersiveNav.enterImmersive;
  let exitImmersive: typeof ImmersiveNav.exitImmersive;
  let decodeImmersiveHash: typeof ImmersiveNav.decodeImmersiveHash;
  let historyCalls: (string | URL | null | undefined)[][];

  before(async () => {
    global.window = mock<typeof window>({
      location: mock<Location>({ pathname: '/posts/demo', search: '', hash: '' }),
      history: mock<History>({
        pushState: (...args) => { historyCalls.push(['pushState', args[2]]); },
        replaceState: (...args) => { historyCalls.push(['replaceState', args[2]]); },
        back: () => { historyCalls.push(['back']); },
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const mod = await import('../src/utils/immersiveNav.ts');
    ({ enterImmersive, exitImmersive, decodeImmersiveHash } = mod);
  });

  beforeEach(() => { historyCalls = []; });

  function fakePage(): FakePage {
    return {
      stateCalls: [],
      setState(s) { this.stateCalls.push(s); },
    };
  }

  // ── decodeImmersiveHash ────────────────────────────────────────────────────

  test('no hash → not immersive, first slide', () => {
    assert.deepStrictEqual(decodeImmersiveHash(''), { startIndex: 0, forceImmersive: false });
  });

  test('#1 → immersive at first slide', () => {
    assert.deepStrictEqual(decodeImmersiveHash('#1'), { startIndex: 0, forceImmersive: true });
  });

  test('#3 → immersive at third slide', () => {
    assert.deepStrictEqual(decodeImmersiveHash('#3'), { startIndex: 2, forceImmersive: true });
  });

  test('non-numeric and zero hashes are ignored', () => {
    assert.deepStrictEqual(decodeImmersiveHash('#section'), { startIndex: 0, forceImmersive: false });
    assert.deepStrictEqual(decodeImmersiveHash('#0'), { startIndex: 0, forceImmersive: false });
  });

  // ── enterImmersive ─────────────────────────────────────────────────────────

  test('enterImmersive pushes a #N entry and sets state', () => {
    const page = fakePage();
    enterImmersive(page, 2);
    assert.deepStrictEqual(historyCalls, [['pushState', '/posts/demo#3']]);
    assert.strictEqual(page._immersivePushed, true);
    assert.deepStrictEqual(page.stateCalls, [{ forceImmersive: true, startIndex: 2 }]);
  });

  test('enterImmersive defaults to the first slide (#1)', () => {
    const page = fakePage();
    enterImmersive(page);
    assert.deepStrictEqual(historyCalls, [['pushState', '/posts/demo#1']]);
  });

  // ── exitImmersive ──────────────────────────────────────────────────────────

  test('exit after enter unwinds via history.back()', () => {
    const page = fakePage();
    enterImmersive(page, 0);
    historyCalls = [];
    exitImmersive(page);
    assert.deepStrictEqual(historyCalls, [['back']]);
    assert.strictEqual(page._immersivePushed, false);
    // no setState — the router's popstate → hash decode drives the re-render
    assert.deepStrictEqual(page.stateCalls, [{ forceImmersive: true, startIndex: 0 }]);
  });

  test('exit without a pushed entry (direct #N link) strips the hash in place', () => {
    const page = fakePage();
    exitImmersive(page);
    assert.deepStrictEqual(historyCalls, [['replaceState', '/posts/demo']]);
    assert.deepStrictEqual(page.stateCalls, [{ forceImmersive: false }]);
  });
});
