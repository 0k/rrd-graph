import { test } from 'vitest'
import assert from 'node:assert/strict'
import { admitted, PRELOAD_COUNT } from '../src/utils/schedule.ts'

// Acceptance ledger: admission waits for every visible card, stays bounded
// below the last visible index, ignores unknown ids, and stops at list end.
const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const result = (visible, settled, ids = order) =>
  [...admitted(ids, new Set(visible), new Set(settled))].sort()

test('visible only until every visible card settles', () => {
  assert.equal(PRELOAD_COUNT, 4)
  assert.deepEqual(result(['b', 'c'], []), ['b', 'c'])
  assert.deepEqual(result(['b', 'c'], ['b']), ['b', 'c'])
})
test('next four after the last visible card once all visible settle', () => {
  assert.deepEqual(result(['b', 'c'], ['b', 'c']), ['b', 'c', 'd', 'e', 'f', 'g'])
})
test('fewer than four remaining cards and nothing beyond list end', () => {
  assert.deepEqual(result(['g'], ['g']), ['g', 'h'])
  assert.deepEqual(result(['h'], ['h']), ['h'])
})
test('no visible ordered cards means no admission', () => {
  assert.deepEqual(result([], order), [])
  assert.deepEqual(result(['unknown'], ['unknown']), [])
})
test('preload never includes cards above or between visible cards', () => {
  assert.deepEqual(result(['b', 'f'], ['b', 'f']), ['b', 'f', 'g', 'h'])
})
test('unknown visible and settled ids are ignored', () => {
  assert.deepEqual(result(['unknown', 'c'], ['c']), ['c', 'd', 'e', 'f', 'g'])
})
