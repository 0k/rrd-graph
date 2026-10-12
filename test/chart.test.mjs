import { test } from 'vitest'
import assert from 'node:assert/strict'
import { toTimeSeries, toYAxis, samplePoints, isStale, mergeTail, tailRange } from '../src/utils/chart.ts'

test('graph data becomes millisecond series with gaps, stacking and bands', () => {
  const graph = { start: 100, step: 60, series: [{ label: 'a', avg: [2, null], min: [1, null], max: [3, null] }] }
  const expected = { id: 'a', label: 'a', points: [[100000, 2], [160000, null]], min: [1, null], max: [3, null] }
  assert.deepEqual(toTimeSeries(graph, true), [{ ...expected, stack: true }])
  assert.deepEqual(toTimeSeries(graph, false), [{ ...expected, stack: false }])
})

test('drawing keys map onto time-chart series options and only when set', () => {
  const graph = { start: 0, step: 1, series: [
    { label: 'conf', avg: [19], color: '#ffff00', fill: 0.1 },
    { label: 'sel', avg: [20], color: 'red', dash: 'dotted', width: 3 },
    { label: 'chauffe', avg: [20], min: [18], max: [20], color: 'red', band: { pattern: 'hatch', opacity: 0.5 }, line: false },
    { label: 'plain band', avg: [2], min: [1], max: [2], band: { pattern: 'solid' }, line: false },
  ] }
  const point = (label, v) => ({ id: label, label, points: [[0, v]], stack: false })
  assert.deepEqual(toTimeSeries(graph, false), [
    { ...point('conf', 19), color: '#ffff00', fill: 0.1 },
    { ...point('sel', 20), color: 'red', dash: 'dotted', width: 3 },
    { ...point('chauffe', 20), min: [18], max: [20], color: 'red', band: { pattern: 'hatch', opacity: 0.5 }, line: false },
    { ...point('plain band', 2), min: [1], max: [2], band: { pattern: 'solid' }, line: false },
  ])
})

test('the y axis maps snake_case JSON onto time-chart options and is absent when unset', () => {
  assert.equal(toYAxis({}), undefined)
  assert.deepEqual(toYAxis({ y_axis: { interval: 1, minor_interval: 0.5 } }), { interval: 1, minorInterval: 0.5 })
  assert.deepEqual(toYAxis({ y_axis: { min: 0, max: 30 } }), { min: 0, max: 30 })
})

test('a tail merge keeps the tail series drawing keys', () => {
  const style = { color: 'red', band: { pattern: 'hatch' }, line: false }
  const held = grid(0, [{ label: 'a', avg: [1, 2], min: [0, 1], max: [1, 2], ...style }], { y_axis: { interval: 1 } })
  const tail = grid(10, [{ label: 'a', avg: [3], min: [2], max: [3], ...style }], { y_axis: { interval: 1 } })
  assert.deepEqual(mergeTail(held, tail, 0), {
    ...tail, start: 0, len: 2,
    series: [{ label: 'a', avg: [1, 3], min: [0, 2], max: [1, 3], ...style }],
  })
})

function grid(start, series, metadata = {}) {
  return { id: 'a', title: 'Held', unit: null, type: 'line', start, step: 10, len: series[0]?.avg.length ?? 0, series, last_update: 20, notes: [], ...metadata }
}

test('tail range uses the real update, rereads its bucket and clamps to the window', () => {
  const held = grid(100, [{ label: 'a', avg: Array(100).fill(null) }], { step: 100 })
  const window = { start: 0, end: 10000, live: true }
  assert.equal(tailRange({ ...held, last_update: null }, window), null)
  assert.equal(tailRange({ ...held, last_update: 4999 }, window), null)
  assert.deepEqual(tailRange({ ...held, last_update: 5000 }, window), { start: 4800, end: 10000, step: 100 })
  assert.deepEqual(tailRange({ ...held, last_update: 8137 }, window), { start: 8000, end: 10000, step: 100 })
  assert.deepEqual(tailRange({ ...held, last_update: 8100 }, window), { start: 7900, end: 10000, step: 100 })
  assert.deepEqual(tailRange({ ...held, last_update: 8137 }, { ...window, start: 8055, end: 8200 }), { start: 8055, end: 8200, step: 100 })
})

test('a long tail replaces every covered bucket including old values and null-padded hours', () => {
  const heldValues = Array.from({ length: 1440 }, (_, i) => i < 1140 ? i : null)
  const tailValues = Array.from({ length: 304 }, (_, i) => i === 2 ? null : 10000 + i)
  const held = grid(60, [{ label: 'a', avg: heldValues }], { step: 60, last_update: 68400 })
  const tail = grid(68220, [{ label: 'a', avg: tailValues }], { step: 60, last_update: 86400 })
  assert.deepEqual(mergeTail(held, tail, 0), {
    ...tail, start: 60, len: 1440,
    series: [{ label: 'a', avg: [...heldValues.slice(0, 1136), ...tailValues] }],
  })
})

test('tail overwrites overlap including null, appends and trims the head without mutating inputs', () => {
  const held = grid(0, [{ label: 'a', avg: [1, 2, 3, 4], min: [0, 1, 2, 3], max: [2, 3, 4, 5] }])
  const tail = grid(20, [{ label: 'a', avg: [null, 40, 50], min: [null, 30, 40], max: [null, 50, 60] }], { title: 'Tail', unit: 'bytes', type: 'stacked', last_update: 40, notes: ['fresh'] })
  const before = structuredClone({ held, tail })
  assert.deepEqual(mergeTail(held, tail, 25), {
    ...tail, start: 20, len: 3,
    series: [{ label: 'a', avg: [null, 40, 50], min: [null, 30, 40], max: [null, 50, 60] }],
  })
  assert.deepEqual(mergeTail(held, tail, 0), {
    ...tail, start: 0, len: 5,
    series: [{ label: 'a', avg: [1, 2, null, 40, 50], min: [0, 1, null, 30, 40], max: [2, 3, null, 50, 60] }],
  })
  assert.deepEqual({ held, tail }, before)
})

test('tail matches labels rather than order and retains held points outside its coverage', () => {
  const held = grid(0, [{ label: 'a', avg: [1, 2, 3] }, { label: 'b', avg: [4, 5, 6] }])
  const tail = grid(10, [{ label: 'b', avg: [50] }, { label: 'a', avg: [20] }])
  assert.deepEqual(mergeTail(held, tail, 0), {
    ...tail, start: 0, len: 3,
    series: [{ label: 'a', avg: [1, 20, 3] }, { label: 'b', avg: [4, 50, 6] }],
  })
})

test('tail rejects resolution, alignment, label set and band presence changes', () => {
  const held = grid(0, [{ label: 'a', avg: [1, 2] }])
  for (const tail of [
    grid(10, [{ label: 'a', avg: [3] }], { step: 20 }),
    grid(15, [{ label: 'a', avg: [3] }]),
    grid(10, [{ label: 'b', avg: [3] }]),
    grid(10, [{ label: 'a', avg: [3] }, { label: 'b', avg: [4] }]),
    grid(10, []),
    grid(10, [{ label: 'a', avg: [3], min: [2] }]),
    grid(10, [{ label: 'a', avg: [3], max: [4] }]),
  ]) assert.equal(mergeTail(held, tail, 0), null)
  const bands = grid(0, [{ label: 'a', avg: [1], min: [0], max: [2] }])
  assert.equal(mergeTail(bands, held, 0), null)
})

test('stacking follows the explicit argument, not the graph type', () => {
  const graph = { type: 'stacked', start: 0, step: 1, series: [{ label: 'a', avg: [1] }, { label: 'b', avg: [2] }] }
  assert.deepEqual(toTimeSeries(graph, false).map(s => s.stack), [false, false])
  assert.deepEqual(toTimeSeries({ ...graph, type: 'line' }, true).map(s => s.stack), [true, true])
})

test('points and stale cutoff are bounded', () => {
  assert.deepEqual([0, 600, 99999].map(samplePoints), [100, 300, 2000])
  assert.equal(isStale(100, 60, 701, true), true)
  assert.equal(isStale(100, 60, 700, true), false)
  assert.equal(isStale(100, 300, 900, true), false)
  assert.equal(isStale(100, 60, 701, false), false)
  assert.equal(isStale(null, 60, 701, true), false)
})
