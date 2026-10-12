import { test } from 'vitest'
import assert from 'node:assert/strict'
import { fetchGraph, parseGraphDescriptor, parseWatchSnapshot, parseGraphChange, requestJson, apiUrl, DEFAULT_API_BASE } from '../src/api.ts'
const payload = { id: 'x/y', title: 'Y', type: 'line', unit: null, start: 10, step: 5, len: 1, series: [{ label: 's', avg: [null] }], last_update: null, notes: [] }

test('graph requests are relative to the default api/ base and encode query parameters', async () => {
  const urls = []
  const fetcher = async (url) => { urls.push(String(url)); return Response.json(payload) }
  assert.equal(DEFAULT_API_BASE, 'api/')
  assert.deepEqual(await fetchGraph('x/y', 10, 20, { points: 100 }, { fetcher }), payload)
  assert.deepEqual(await fetchGraph('x/y', 10, 20, { step: 5, keep: ['a b', 'c'] }, { fetcher }), payload)
  assert.deepEqual(urls, [
    'api/graph?id=x%2Fy&start=10&end=20&points=100',
    'api/graph?id=x%2Fy&start=10&end=20&step=5&keep=a+b&keep=c',
  ])
})
test('a configured base prefixes the graph endpoint with exactly one separator', async () => {
  const urls = []
  const fetcher = async (url) => { urls.push(String(url)); return Response.json(payload) }
  for (const base of ['rrd/api', 'rrd/api/', '']) await fetchGraph('x/y', 10, 20, { points: 1 }, { base, fetcher })
  assert.deepEqual(urls.map(url => url.split('?')[0]), ['rrd/api/graph', 'rrd/api/graph', 'graph'])
  assert.equal(apiUrl('api/', 'watch/events'), 'api/watch/events')
})
test('the request signal reaches the fetcher', async () => {
  const controller = new AbortController()
  let seen
  await fetchGraph('x/y', 10, 20, { points: 1 }, { signal: controller.signal, fetcher: async (_url, init) => { seen = init.signal; return Response.json(payload) } })
  assert.equal(seen, controller.signal)
})

test('valid requests expose server failures, network failures, malformed graph arrays and id mismatches', async () => {
  await assert.rejects(requestJson('api/x', { fetcher: async () => Response.json({ error: 'server explanation' }, { status: 503 }) }), /server explanation/)
  await assert.rejects(requestJson('api/x', { fetcher: async () => new Response('not json', { status: 502 }) }), /HTTP 502: response is not valid JSON/)
  await assert.rejects(fetchGraph('x', 10, 20, { points: 100 }, { fetcher: async () => { throw new Error('offline') } }), /offline/)
  await assert.rejects(fetchGraph('x', 10, 20, { points: 100 }, { fetcher: async () => Response.json({ id: 'x', title: 'X', type: 'line', unit: null, start: 10, step: 5, len: 2, series: [{ label: 'a', avg: [1] }], last_update: null, notes: [] }) }), /length/)
  await assert.rejects(fetchGraph('other', 10, 20, { points: 100 }, { fetcher: async () => Response.json(payload) }), /graph id does not match/)
  for (const label of ['', '\u0000guide']) {
    await assert.rejects(fetchGraph('x/y', 10, 20, { points: 100 }, { fetcher: async () => Response.json({ ...payload, series: [{ label, avg: [null] }] }) }), /series label must be nonempty and not start with NUL/)
  }
})

test('graph responses keep validated drawing keys and the y axis', async () => {
  const styled = {
    ...payload, len: 1, y_axis: { min: 0, interval: 1, minor_interval: 0.5 },
    series: [
      { label: 'a', avg: [1], color: 'red', dash: 'dotted', width: 3, fill: 0.2 },
      { label: 'b', avg: [2], min: [1], max: [2], color: '#000', band: { pattern: 'hatch', opacity: 0.5 }, line: false },
    ],
  }
  const respond = body => fetchGraph('x/y', 10, 20, { points: 100 }, { fetcher: async () => Response.json(body) })
  assert.deepEqual(await respond(styled), styled)
  // Same split rule as time-chart: 2 to 99 steps, float quotients tolerated.
  for (const y_axis of [{ interval: 99, minor_interval: 1 }, { interval: 0.3, minor_interval: 0.1 }]) {
    assert.deepEqual((await respond({ ...payload, y_axis })).y_axis, y_axis)
  }
  const series = extra => ({ ...payload, series: [{ label: 's', avg: [null], ...extra }] })
  for (const [body, message] of [
    [series({ color: 1 }), /color must be a string/],
    [series({ dash: 'wavy' }), /unknown dash/],
    [series({ width: 0 }), /width must be positive/],
    [series({ fill: 2 }), /fill must be in \(0, 1\]/],
    [series({ line: true }), /line must be false/],
    [series({ band: { pattern: 'hatch' } }), /band needs min and max/],
    [series({ min: [null], max: [null], band: { pattern: 'dots' } }), /unknown band pattern/],
    [series({ min: [null], max: [null], band: { pattern: 'solid', opacity: 0 } }), /band opacity must be in \(0, 1\]/],
    [{ ...payload, y_axis: { interval: 'x' } }, /y_axis.interval must be finite/],
    [{ ...payload, y_axis: { step: 1 } }, /unknown y_axis key step/],
    [{ ...payload, y_axis: { interval: 0 } }, /y_axis.interval must be positive/],
    [{ ...payload, y_axis: { minor_interval: 0.5 } }, /y_axis.minor_interval must divide y_axis.interval/],
    ...[1, 0.3, 0.01, -0.5].map(minor_interval =>
      [{ ...payload, y_axis: { interval: 1, minor_interval } }, /y_axis.minor_interval must divide y_axis.interval into 2 to 99 steps/]),
  ]) await assert.rejects(respond(body), message)
})

test('watch snapshots and graph changes validate their object and string fields', () => {
  assert.deepEqual(parseWatchSnapshot({ ids: ['a', 'x/y'] }), { ids: ['a', 'x/y'] })
  assert.deepEqual(parseWatchSnapshot({ ids: [] }), { ids: [] })
  assert.deepEqual(parseGraphChange({ id: 'x/y' }), { id: 'x/y' })
  for (const value of [null, [], 'a', {}, { ids: null }, { ids: [1] }, { ids: [null] }]) {
    assert.throws(() => parseWatchSnapshot(value), /Invalid API response/)
  }
  for (const value of [null, [], 'a', {}, { id: 1 }, { id: null }]) {
    assert.throws(() => parseGraphChange(value), /Invalid API response/)
  }
})

test('graph descriptors keep only graph fields and validate type, stack_toggle and unit', () => {
  const graph = { id: 'm', title: 'M', type: 'stacked', stack_toggle: true, unit: 'bytes' }
  assert.deepEqual(parseGraphDescriptor({ ...graph, kind: 'graph' }), graph)
  assert.deepEqual(parseGraphDescriptor({ ...graph, unit: null }), { ...graph, unit: null })
  assert.throws(() => parseGraphDescriptor({ ...graph, stack_toggle: 'yes' }), /stack_toggle must be a boolean/)
  assert.throws(() => parseGraphDescriptor({ ...graph, stack_toggle: undefined }), /stack_toggle must be a boolean/)
  assert.throws(() => parseGraphDescriptor({ ...graph, type: 'pie' }), /unknown graph type/)
  assert.throws(() => parseGraphDescriptor({ ...graph, unit: 3 }), /unit must be a string/)
  assert.throws(() => parseGraphDescriptor({ ...graph, id: 1 }), /id must be a string/)
})
