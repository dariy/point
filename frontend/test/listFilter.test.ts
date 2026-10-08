import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_FILTER, withPlace, withYears, isFiltered, listRequest } from '../src/utils/listFilter.ts';

describe('listFilter', () => {
  it('no filter loads the plain feed', () => {
    assert.deepEqual(listRequest(NO_FILTER), { place: null });
    assert.equal(isFiltered(NO_FILTER), false);
  });

  it('geo-tag alone', () => {
    const f = withPlace(NO_FILTER, 'paris');
    assert.deepEqual(listRequest(f), { place: 'paris' });
    assert.equal(isFiltered(f), true);
  });

  it('time range alone', () => {
    const f = withYears(NO_FILTER, [2019, 2021]);
    assert.deepEqual(listRequest(f), { place: null, year_from: 2019, year_to: 2021 });
    assert.equal(isFiltered(f), true);
  });

  it('both filters combine in one request', () => {
    const f = withYears(withPlace(NO_FILTER, 'paris'), [2019, 2021]);
    assert.deepEqual(listRequest(f), { place: 'paris', year_from: 2019, year_to: 2021 });
  });

  it('setting one filter keeps the other', () => {
    const f = withPlace(withYears(NO_FILTER, [2020, 2020]), 'rome');
    assert.deepEqual(f, { place: 'rome', years: [2020, 2020] });
  });

  it('clearing the place keeps the time range', () => {
    const f = withPlace(withYears(withPlace(NO_FILTER, 'paris'), [2019, 2021]), null);
    assert.deepEqual(listRequest(f), { place: null, year_from: 2019, year_to: 2021 });
  });

  it('clearing the time range keeps the place', () => {
    const f = withYears(withYears(withPlace(NO_FILTER, 'paris'), [2019, 2021]), null);
    assert.deepEqual(listRequest(f), { place: 'paris' });
  });

  it('clearing both returns to the plain feed', () => {
    const f = withYears(withPlace(withYears(withPlace(NO_FILTER, 'paris'), [2019, 2021]), null), null);
    assert.deepEqual(f, NO_FILTER);
    assert.equal(isFiltered(f), false);
  });

  it('does not mutate its input', () => {
    withPlace(NO_FILTER, 'paris');
    withYears(NO_FILTER, [1, 2]);
    assert.deepEqual(NO_FILTER, { place: null, years: null });
  });
});
