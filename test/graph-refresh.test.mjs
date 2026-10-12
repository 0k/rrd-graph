import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createRenderer, computed, h, nextTick, onMounted, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { GRAPH_SCHEDULER } from '../src/composables/useGraphScheduler.ts'
import { useGraphWatch } from '../src/composables/useGraphWatch.ts'

// Acceptance ledger: these tests execute the production Vue watchers and SSE
// library. A/B isolation, burst deduplication, snapshot healing, subscription
// identity/cleanup, load races, aborts, full-only loading, fallback, the
// configurable relative API base and a standalone card without an injected
// scheduler each have assertions below; api.test and chart.test cover
// validation and merge rules (see acceptance-ledger.org).
// Like time-chart, it validates series on create and setSeries: a series
// labelled "bad" is rejected.
const chartCalls = [], chartOptions = []
vi.doMock('@0k/time-chart', () => {
  function validate(series) { if (series.some(s => s.id === 'bad')) throw new Error('Invalid band bounds: bad') }
  return { createTimeChart(el, option) {
    validate(option.series)
    chartCalls.push('create'); chartOptions.push(option)
    return { destroy() { chartCalls.push('destroy') }, setSeries(series) { validate(series); chartCalls.push('setSeries') }, setWindow() {}, getWindow() { return { start: 0, end: 1000000 } } }
  } }
})
const { default: TimeSeriesChart } = await import('../src/components/TimeSeriesChart.vue')
// Load the real chart first; only GraphCard receives the component stub.
// Same contract as the real chart: `ready` after mount and after each new
// `data`, or `error` when the chart rejects it (a series labelled
// "rejected" here); `globalThis.chartLife` records mounts and unmounts.
vi.doMock('../src/components/TimeSeriesChart.vue', () => ({
  default: { props: ['data'], setup(props, { emit }) {
    const draw = () => props.data.series.some(s => s.label === 'rejected') ? emit('error', 'chart rejected the data') : emit('ready')
    onMounted(() => { globalThis.chartLife?.push('mount'); draw() })
    watch(() => props.data, draw)
    onBeforeUnmount(() => globalThis.chartLife?.push('unmount'))
    return () => null } },
}))
const { default: GraphCard } = await import('../src/components/GraphCard.vue')

function node(type = 'root') { return { type, children: [], props: {}, parent: null, clientWidth: 612 } }
const renderer = createRenderer({
  createElement: node, createText: () => node('text'), createComment: () => node('comment'),
  setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text },
  patchProp: (el, key, previous, next) => { el.props[key] = next },
  insert(el, parent, anchor) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    el.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(el)
    else parent.children.splice(index, 0, el)
  },
  remove(el) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    el.parent = null
  },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
})

async function settle() {
  for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() }
}

test('chart ready waits for the frame after mount and after each new data, and teardown cancels it', async t => {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  const frames = new Map()
  let nextFrame = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  const apps = []
  t.onTestFinished(() => {
    for (const app of apps) app.unmount()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  chartCalls.length = 0
  let ready = 0
  const data = ref({ start: 0, step: 100, len: 1, series: [{ label: 's', avg: [1] }], unit: null })
  const mount = () => {
    const app = renderer.createApp({ render: () => h(TimeSeriesChart, {
      data: data.value,
      window: { start: 0, end: 1000, live: true }, tall: false, stacked: false,
      onReady: () => ready++,
    }) })
    apps.push(app)
    app.mount(node())
    return app
  }
  const first = mount()
  assert.deepEqual(chartCalls, ['create'])
  assert.equal(ready, 0)
  const callback = frames.get(nextFrame)
  frames.delete(nextFrame)
  callback()
  assert.equal(ready, 1)
  assert.equal(frames.size, 0)
  data.value = { ...data.value, series: [{ label: 's', avg: [2] }] }
  await nextTick()
  assert.equal(ready, 1)
  assert.equal(frames.size, 1)
  frames.get(nextFrame)(); frames.delete(nextFrame)
  assert.equal(ready, 2)
  first.unmount(); apps.pop()
  const second = mount()
  second.unmount(); apps.pop()
  assert.equal(frames.size, 0)
  assert.equal(ready, 2)
  assert.deepEqual(chartCalls, ['create', 'setSeries', 'destroy', 'create', 'destroy'])
})

test('data the chart rejects emits error instead of ready, and later valid data draws', async t => {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  const frames = new Map()
  let nextFrame = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  chartCalls.length = 0
  const events = []
  const series = label => ({ start: 0, step: 100, len: 1, series: [{ label, avg: [1] }], unit: null })
  const data = ref(series('bad'))
  const app = renderer.createApp({ render: () => h(TimeSeriesChart, {
    data: data.value, window: { start: 0, end: 1000, live: true }, tall: false, stacked: false,
    onReady: () => events.push('ready'), onError: message => events.push(`error: ${message}`),
  }) })
  app.mount(node())
  t.onTestFinished(() => {
    app.unmount()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  const paint = () => { for (const [id, callback] of frames) { frames.delete(id); callback() } }
  assert.deepEqual(events, ['error: Invalid band bounds: bad'])
  assert.deepEqual(chartCalls, [])
  assert.equal(frames.size, 0)
  data.value = series('good'); await nextTick(); paint()
  assert.deepEqual(chartCalls, ['create'])
  assert.deepEqual(events.slice(1), ['ready'])
  data.value = series('bad'); await nextTick(); paint()
  assert.deepEqual(events.slice(2), ['error: Invalid band bounds: bad'])
  data.value = series('good'); await nextTick(); paint()
  assert.deepEqual(chartCalls, ['create', 'setSeries'])
  assert.deepEqual(events.slice(3), ['ready'])
})

test('linked charts fit their legends to their labels and align their plots', t => {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} })
  chartOptions.length = 0
  const app = renderer.createApp({ render: () => h(TimeSeriesChart, {
    data: { start: 0, step: 100, len: 1, series: [{ label: 's', avg: [1] }], unit: null },
    window: { start: 0, end: 1000, live: true }, tall: false, stacked: false,
  }) })
  app.mount(node())
  t.onTestFinished(() => {
    app.unmount()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  // time-chart sizes 'auto' legends to the widest label and gives every
  // chart of one link key the widest column of the group.
  assert.equal(chartOptions[0].link, 'rrd-graph')
  assert.deepEqual(chartOptions[0].legend, { width: 'auto' })
})

// `base` is passed to the card and the watch as `apiBase`; `path` is where the
// requests must land.  Omitting `base` exercises the default (`api/`).
function setup(t, { ids = ['a', 'b'], defer = false, snapshotFailure = false, admit = true, window = { start: 0, end: 1000, live: true }, base, path = '/prefix/api/', inject = true, graph = id => ({ kind: 'graph', type: 'line', unit: null, stack_toggle: true, id, title: id }) } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1000000 })
  const streams = []
  const requests = []
  const snapshots = []
  const observers = []
  const intersections = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const query = new URL(url, 'http://localhost/prefix/')
    if (query.pathname === `${path}watch`) {
      snapshots.push(query)
      if (snapshotFailure) {
        snapshotFailure = false
        return Response.json({ error: 'Snapshot unavailable' }, { status: 503 })
      }
      return Response.json({ ids: query.searchParams.getAll('id').sort() }, {
        headers: { 'x-sub-id': 'test-sub', 'x-snapshot-index': String(snapshots.length) },
      })
    }
    assert.equal(query.pathname, `${path}graph`)
    const record = { query, signal: options.signal }
    requests.push(record)
    const start = Math.floor(Number(query.searchParams.get('start')) / 100) * 100
    const end = Math.floor(Number(query.searchParams.get('end')) / 100) * 100
    const data = {
      id: query.searchParams.get('id'), title: 'Graph', type: 'line', unit: null,
      start, step: 100, len: (end - start) / 100 + 1,
      series: [{ label: 's', avg: Array((end - start) / 100 + 1).fill(1) }],
      last_update: end, notes: [],
    }
    record.data = data
    if (defer) return new Promise(resolve => { record.resolve = (value = data) => resolve(Response.json(value)) })
    return Response.json(data)
  })
  const globals = { EventSource: globalThis.EventSource, ResizeObserver: globalThis.ResizeObserver, IntersectionObserver: globalThis.IntersectionObserver, document: globalThis.document }
  globalThis.document = { baseURI: 'http://localhost/prefix/' }
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; streams.push(this) }
    close() { this.closed = true }
    addEventListener() {}
  }
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); intersections.push(this) }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.disconnected = true; this.targets.clear() }
  }
  const displayed = ref(ids)
  const now = ref(1000)
  const fixed = ref(window.live ? null : window)
  const span = ref(window.end - window.start)
  const revision = ref(0)
  const graphIds = ref({})
  const timeWindow = computed(() => fixed.value ?? { start: now.value - span.value, end: now.value, live: true })
  let changes
  const root = node()
  const admission = ref(admit)
  const visibility = ref(true)
  const registered = new Map()
  const settled = new Map()
  const scheduler = {
    register: (id, el) => registered.set(id, el),
    unregister: id => { registered.delete(id); settled.delete(id) },
    setSettled: (id, value) => settled.set(id, value),
    isVisible: () => visibility.value,
    isAdmitted: () => admission.value,
  }
  const app = renderer.createApp({
    setup() {
      changes = useGraphWatch(displayed, timeWindow, now, ...(base === undefined ? [] : [{ apiBase: base }]))
      return () => h('main', displayed.value.map(id => h(GraphCard, {
        key: id, graph: graph(graphIds.value[id] ?? id),
        revision: revision.value, change: changes.value[id] ?? 0, window: timeWindow.value, tall: false,
        ...(base === undefined ? {} : { apiBase: base }),
      })))
    },
  })
  if (inject) app.provide(GRAPH_SCHEDULER, scheduler)
  app.mount(root)
  let mounted = true
  function unmount() { if (mounted) { app.unmount(); mounted = false } }
  t.onTestFinished(() => { unmount(); for (const [key, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  } vi.restoreAllMocks(); vi.useRealTimers() })
  function card(id) {
    return root.children[0].children.find(el => el.props['data-graph-id'] === id)
  }
  function event(id) { streams.at(-1).onmessage({ data: JSON.stringify({ id }) }) }
  async function flush() { vi.advanceTimersByTime(250); await settle() }
  return { requests, snapshots, streams, observers, intersections, displayed, now, fixed, span, revision, graphIds, timeWindow, card, event, flush, unmount, admission, visibility, registered, settled, get changes() { return changes.value } }
}

// Admission acceptance ledger: no work before admission; exactly one load on
// admission; invalidation cancels the old window; hidden change events defer
// one tail; hidden charts lose readiness while held data survives re-entry.
test('not admitted sends no fetch; later admission sends exactly one', async t => {
  const s = setup(t, { ids: ['a'], admit: false })
  await settle()
  assert.equal(s.requests.length, 0)
  assert.equal(s.card('a').props['data-loading'], false)
  assert.equal(s.card('a').props['data-admitted'], false)
  assert.equal(toRaw(s.registered.get('a')), s.card('a'))
  s.admission.value = true
  await settle()
  assert.equal(s.requests.length, 1)
  assert.equal(s.settled.get('a'), true)
  s.unmount()
  assert.equal(s.registered.size, 0)
})

test('window invalidation while not admitted aborts and defers the new window', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.admission.value = false
  await settle()
  s.fixed.value = { start: 200, end: 800, live: false }
  await settle()
  assert.equal(s.requests[0].signal.aborted, true)
  assert.equal(s.requests.length, 1)
  assert.equal(s.card('a').props['data-loading'], false)
  s.requests[0].resolve()
  await settle()
  s.admission.value = true
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.search, '?id=a&start=200&end=800&points=100')
  s.requests[1].resolve()
  await settle()
})

test('non-admitted change defers exactly one tail until admission', async t => {
  const s = setup(t, { ids: ['a'] })
  await settle()
  s.admission.value = false
  await settle()
  s.event('a'); s.event('a'); await s.flush()
  assert.equal(s.requests.length, 1)
  s.admission.value = true
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.search, '?id=a&start=800&end=1000&step=100&keep=s')
})

test('visibility releases chart readiness, not held data; re-entry never refetches', async t => {
  const s = setup(t, { ids: ['a'] })
  await settle()
  assert.equal(s.settled.get('a'), true)
  s.visibility.value = false
  await settle()
  assert.equal(s.settled.get('a'), false)
  assert.equal(s.card('a').props['data-visible'], false)
  assert.equal(s.card('a').props['data-last-update'], 1000)
  s.visibility.value = true
  await settle()
  assert.equal(s.settled.get('a'), true)
  assert.equal(s.requests.length, 1)
})

test('a visible card keeps its chart and held data while a new window loads, and settles on the new data', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  globalThis.chartLife = []
  t.onTestFinished(() => { delete globalThis.chartLife })
  await settle()
  s.requests[0].resolve()
  await settle()
  assert.deepEqual(globalThis.chartLife, ['mount'])
  assert.equal(s.settled.get('a'), true)
  s.fixed.value = { start: 200, end: 800, live: false }
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.card('a').props['data-loading'], true)
  assert.equal(s.card('a').props['data-last-update'], 1000)
  assert.equal(s.settled.get('a'), false)
  s.requests[1].resolve()
  await settle()
  assert.equal(s.card('a').props['data-last-update'], 800)
  assert.equal(s.settled.get('a'), true)
  assert.deepEqual(globalThis.chartLife, ['mount'])
})

test('revision, points and graph identity invalidate hidden requests without eager work', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.admission.value = false
  s.revision.value++
  await settle()
  assert.equal(s.requests[0].signal.aborted, true)
  s.card('a').clientWidth = 1012
  s.observers[0].callback()
  vi.advanceTimersByTime(200)
  await settle()
  s.graphIds.value = { a: 'renamed' }
  await settle()
  assert.equal(s.registered.has('a'), false)
  assert.equal(s.registered.has('renamed'), true)
  assert.equal(s.requests.length, 1)
  s.admission.value = true
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.search, '?id=renamed&start=0&end=1000&points=300')
  s.requests[1].resolve()
  await settle()
})

test('data-only preload holds data without chart readiness; no-data and errors settle', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  s.visibility.value = false
  await settle()
  s.requests[0].resolve()
  await settle()
  assert.equal(s.settled.get('a') ?? false, false)
  assert.equal(s.requests.length, 1)
  s.revision.value++
  await settle()
  s.requests[1].resolve({ ...s.requests[1].data, series: [] })
  await settle()
  assert.equal(s.settled.get('a'), true)
  s.revision.value++
  await settle()
  s.requests[2].resolve({ ...s.requests[2].data, series: [{ label: 's', avg: [] }] })
  await settle()
  assert.equal(s.settled.get('a'), true)
  assert.equal(s.card('a').props['data-loading'], false)
  assert.ok(s.card('a').children.find(el => el.props.role === 'alert'))
})

test('graph A burst slides every live window, but only A sends exactly one step request', async t => {
  const s = setup(t)
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.snapshots[0].href, 'http://localhost/prefix/api/watch?id=a&id=b')
  vi.advanceTimersByTime(10000)
  s.event('a'); s.event('a'); s.event('other-client')
  assert.equal(s.requests.length, 2)
  await s.flush()
  assert.deepEqual(s.changes, { a: 1 })
  assert.equal(s.requests.length, 3)
  assert.equal(s.requests[2].query.search, '?id=a&start=800&end=1010&step=100&keep=s')
  for (const id of ['a', 'b']) {
    assert.equal(s.card(id).props['data-window'], '10-1010')
    assert.equal(s.card(id).props['data-loading'], false)
  }
  assert.equal(s.card('a').props['data-tail-requests'], 1)
  assert.equal(s.card('b').props['data-tail-requests'], 0)
  assert.equal(s.snapshots.length, 1)
  assert.equal(s.streams.length, 1)
})

test('first snapshot only records; reconnect snapshot heals every displayed graph with tails', async t => {
  const s = setup(t)
  await settle()
  assert.deepEqual(s.changes, {})
  s.streams[0].onerror()
  await settle()
  assert.equal(s.streams[0].closed, true)
  assert.equal(s.snapshots[1].search, '?id=a&id=b&sub=test-sub')
  await s.flush()
  assert.deepEqual(s.changes, { a: 1, b: 1 })
  assert.equal(s.requests.length, 4)
  assert.ok(s.requests.slice(2).every(r => r.query.searchParams.get('step') === '100'))
})

test('subscription identity depends only on the displayed set and watching; cleanup cancels queued events', async t => {
  const s = setup(t)
  await settle()
  s.displayed.value = ['b', 'a', 'a']
  // Restore unique ids before rendering duplicate keyed cards; subscription key
  // still sees the same set throughout the batched update.
  s.displayed.value = ['b', 'a']
  s.now.value += 1
  await settle()
  assert.equal(s.snapshots.length, 1)
  s.event('a')
  s.displayed.value = ['b']
  await settle()
  await s.flush()
  assert.equal(s.streams[0].closed, true)
  assert.deepEqual(s.changes, {})
  assert.equal(s.snapshots[1].search, '?id=b')
  s.fixed.value = { start: 0, end: 500, live: false }
  await settle()
  assert.equal(s.streams.at(-1).closed, true)
  s.fixed.value = { start: 0, end: 2000, live: false }
  await settle()
  assert.equal(s.snapshots.length, 3)
  s.event('b')
  s.unmount()
  await s.flush()
  assert.equal(s.streams.at(-1).closed, true)
  assert.deepEqual(s.changes, {})
  assert.ok(s.observers.every(o => o.disconnected))
})

test('a change during a full load is remembered and tails the newly loaded data exactly once', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.event('a')
  await s.flush()
  assert.equal(s.requests.length, 1)
  assert.equal(s.card('a').props['data-loading'], true)
  s.requests[0].resolve()
  await settle()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.searchParams.get('step'), '100')
  assert.equal(s.card('a').props['data-loading'], false)
  s.requests[1].resolve()
  await settle()
})

test('new tail aborts old tail; full load aborts tail; unmount aborts full without stale completion', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.requests[0].resolve()
  await settle()
  s.event('a'); await s.flush()
  s.event('a'); await s.flush()
  assert.equal(s.requests[1].signal.aborted, true)
  assert.equal(s.requests[2].signal.aborted, false)
  s.requests[1].resolve({ ...s.requests[1].data, title: 'Obsolete' })
  await settle()
  assert.equal(s.card('a').children[0].children[0].text, 'Graph')
  s.revision.value++
  await settle()
  assert.equal(s.requests[2].signal.aborted, true)
  assert.equal(s.requests[3].query.searchParams.get('points'), '100')
  s.unmount()
  assert.equal(s.requests[3].signal.aborted, true)
  s.requests[2].resolve(); s.requests[3].resolve()
  await settle()
  assert.equal(s.requests.length, 4)
})

test('zoom, past pan, resize and revision require full loads; even a long live slide fetches nothing', async t => {
  const s = setup(t, { ids: ['a'] })
  await settle()
  s.span.value = 600
  await settle()
  s.fixed.value = { start: 300, end: 900, live: false }
  await settle()
  s.fixed.value = { start: 200, end: 800, live: false }
  await settle()
  s.card('a').clientWidth = 1012
  s.observers[0].callback()
  vi.advanceTimersByTime(200)
  await settle()
  s.revision.value++
  await settle()
  s.fixed.value = null
  await settle()
  s.now.value = 5000
  await settle()
  assert.equal(s.requests.length, 7)
  assert.ok(s.requests.every(r => r.query.searchParams.has('points') && !r.query.searchParams.has('step')))
  assert.equal(s.requests[4].query.searchParams.get('points'), '300')
})

test('incompatible tail logs its fallback and performs a full reload', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  const messages = []
  vi.spyOn(console, 'info').mockImplementation((...args) => messages.push(args))
  await settle()
  s.requests[0].resolve(); await settle()
  s.event('a'); await s.flush()
  s.requests[1].resolve({ ...s.requests[1].data, step: 200 })
  await settle()
  assert.equal(s.requests.length, 3)
  assert.equal(s.requests[2].query.searchParams.get('points'), '100')
  assert.equal(messages.length, 1)
  assert.match(messages[0][0], /incompatible.*grid, labels or min\/max/)
  s.requests[2].resolve(); await settle()
})

test('a chart error shows in the error banner and settles the card; Retry draws valid data', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.requests[0].resolve({ ...s.requests[0].data, series: [{ label: 'rejected', avg: s.requests[0].data.series[0].avg }] })
  await settle()
  const banner = s.card('a').children.find(el => el.props.role === 'alert')
  assert.equal(banner.children[0].text, 'chart rejected the data')
  assert.equal(s.settled.get('a'), true)
  banner.children[1].props.onClick()
  await settle()
  assert.equal(s.settled.get('a'), false)
  s.requests[1].resolve(); await settle()
  assert.equal(s.card('a').children.find(el => el.props.role === 'alert'), undefined)
  assert.equal(s.settled.get('a'), true)
})

test('tail errors keep the card out of full-loading state and expose Retry', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.requests[0].resolve(); await settle()
  s.event('a'); await s.flush()
  assert.equal(s.card('a').props['data-loading'], false)
  s.requests[1].resolve({ ...s.requests[1].data, series: [{ label: 's', avg: [] }] })
  await settle()
  assert.equal(s.card('a').props['data-loading'], false)
  const banner = s.card('a').children.find(el => el.props.role === 'alert')
  assert.match(banner.children[0].text, /length/)
  banner.children[1].props.onClick()
  await settle()
  assert.equal(s.requests[2].query.searchParams.get('points'), '100')
  s.requests[2].resolve(); await settle()
})

test('empty displayed set and historical window have no channel; fixed future deadline stops watching', async t => {
  const s = setup(t, { ids: [] })
  await settle()
  assert.equal(s.snapshots.length, 0)
  s.fixed.value = { start: 0, end: 900, live: false }
  s.displayed.value = ['a']
  await settle()
  assert.equal(s.snapshots.length, 0)
  s.fixed.value = { start: 0, end: 1001, live: false }
  await settle()
  assert.equal(s.snapshots.length, 1)
  const count = s.requests.length
  vi.advanceTimersByTime(1000)
  await settle()
  assert.equal(s.streams[0].closed, true)
  assert.equal(s.requests.length, count)
  assert.equal(s.now.value, 1000)
})

test('changes to a fixed future window fetch tails without advancing its bounds', async t => {
  const s = setup(t, { ids: ['a'], window: { start: 0, end: 1100, live: false } })
  await settle()
  s.event('a'); await s.flush()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.search, '?id=a&start=900&end=1100&step=100&keep=s')
  assert.equal(s.card('a').props['data-window'], '0-1100')
  assert.equal(s.now.value, 1000)
})

test('pure live slide sends no request; tail with a huge held-data gap falls back to a full load', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  // The grid reaches the viewport end but its last update is much older.
  s.requests[0].resolve({ ...s.requests[0].data, last_update: 600 })
  await settle()
  s.now.value = 1001
  await settle()
  assert.equal(s.requests.length, 1)
  // Slides alone never fetch, regardless of the data's age.
  s.now.value = 1099
  await settle()
  assert.equal(s.requests.length, 1)
  vi.advanceTimersByTime(101000)
  s.event('a'); await s.flush()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.searchParams.get('points'), '100')
  s.requests[1].resolve(); await settle()
  assert.equal(s.requests.length, 2)
})

test('stale null-padded top graph catches up from last_update and keeps its full-window winners', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  const labels = ['alpha beta', 'gamma', 'other (1)']
  s.requests[0].resolve({
    ...s.requests[0].data, last_update: 637,
    series: labels.map(label => ({ label, avg: [1, 1, 1, 1, 1, 1, null, null, null, null, null] })),
  })
  await settle()
  vi.advanceTimersByTime(10000)
  s.event('a'); await s.flush()
  assert.equal(s.requests.length, 2)
  const query = s.requests[1].query.searchParams
  assert.equal(query.get('start'), '500')
  assert.equal(query.get('end'), '1010')
  assert.equal(query.get('step'), '100')
  assert.equal(query.has('points'), false)
  assert.deepEqual(query.getAll('keep'), ['alpha beta', 'gamma'])
  s.requests[1].resolve({
    ...s.requests[1].data, last_update: 1010,
    series: labels.map(label => ({ label, avg: Array(s.requests[1].data.len).fill(2) })),
  })
  await settle()
  assert.equal(s.card('a').props['data-last-update'], 1010)
  assert.equal(s.requests.length, 2)
})

test('no held update requires exactly one full load when files appear', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.requests[0].resolve({ ...s.requests[0].data, last_update: null, series: [] })
  await settle()
  s.event('a'); await s.flush()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.searchParams.get('points'), '100')
  assert.equal(s.requests[1].query.searchParams.has('step'), false)
  s.requests[1].resolve(); await settle()
  assert.equal(s.requests.length, 2)
})

test('snapshot errors are reported and retried; malformed messages do not refresh any graph', async t => {
  const errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
  const s = setup(t, { snapshotFailure: true })
  await settle()
  assert.equal(errors.length, 1)
  assert.match(errors[0][0], /Graph watch snapshot failed/)
  assert.match(errors[0][1].message, /HTTP 503/)
  await s.flush()
  assert.equal(s.snapshots.length, 2)
  assert.equal(s.streams.length, 1)
  assert.deepEqual(s.changes, {})
  s.streams[0].onmessage({ data: JSON.stringify({ id: 123 }) })
  await s.flush()
  assert.equal(errors.length, 2)
  assert.match(errors[1][0], /Invalid graph watch event/)
  assert.deepEqual(s.changes, {})
  assert.equal(s.requests.length, 2)
})

test('pending changes survive a superseding revision load; aborted full cannot replace new data', async t => {
  const s = setup(t, { ids: ['a'], defer: true })
  await settle()
  s.event('a'); await s.flush()
  s.revision.value++
  await settle()
  assert.equal(s.requests[0].signal.aborted, true)
  s.requests[0].resolve({ ...s.requests[0].data, title: 'Aborted full' })
  await settle()
  assert.equal(s.card('a').children[0].children[0].text, 'a')
  s.requests[1].resolve({ ...s.requests[1].data, title: 'New full' })
  await settle()
  assert.equal(s.card('a').children[0].children[0].text, 'New full')
  assert.equal(s.requests.length, 3)
  assert.equal(s.requests[2].query.searchParams.get('step'), '100')
  s.requests[2].resolve(); await settle()
})

test('a configured API base routes graph, watch snapshot and stream requests under it', async t => {
  const s = setup(t, { ids: ['a'], base: 'proxy/rrd/api', path: '/prefix/proxy/rrd/api/' })
  await settle()
  assert.equal(s.requests.length, 1)
  assert.equal(s.snapshots[0].href, 'http://localhost/prefix/proxy/rrd/api/watch?id=a')
  assert.equal(s.streams[0].url, 'http://localhost/prefix/proxy/rrd/api/watch/events?sub=test-sub')
  s.event('a'); await s.flush()
  assert.equal(s.requests.length, 2)
  assert.equal(s.requests[1].query.pathname, '/prefix/proxy/rrd/api/graph')
})

test('standalone card: no injected scheduler, no tree fields, loads once visible and disconnects on unmount', async t => {
  const s = setup(t, { ids: ['a'], inject: false, graph: id => ({ id, title: id, type: 'line', unit: null, stack_toggle: false }) })
  await settle()
  assert.equal(s.intersections.length, 1)
  const [observer] = s.intersections
  assert.equal(s.requests.length, 0)
  assert.equal(s.card('a').props['data-visible'], false)
  assert.equal(toRaw([...observer.targets][0]), s.card('a'))
  observer.callback([{ target: [...observer.targets][0], isIntersecting: true }])
  await settle()
  assert.equal(s.requests.length, 1)
  assert.equal(s.requests[0].query.search, '?id=a&start=0&end=1000&points=100')
  assert.equal(s.card('a').props['data-visible'], true)
  s.unmount()
  assert.equal(observer.disconnected, true)
})
