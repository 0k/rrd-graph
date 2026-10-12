// Built-artifact contract; run after `npm run build` (npm run test:package).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const pkg = JSON.parse(await read('../package.json'))

function exportedNames(source) {
  return [...source.matchAll(/export\s*\{([^}]*)\}/g)]
    .flatMap(match => match[1].split(',').map(item => item.trim().split(/\s+as\s+/).at(-1)).filter(Boolean))
}

test('every package.json export target exists', async () => {
  for (const target of Object.values(pkg.exports).flatMap(entry => typeof entry === 'string' ? [entry] : Object.values(entry))) {
    await access(new URL(`../${target}`, import.meta.url))
  }
  assert.equal(pkg.peerDependencies.vue, '^3.5.12')
})

test('built entries export the public API', async () => {
  const names = exportedNames(await read('../dist/index.js'))
  for (const name of ['GraphCard', 'TimeSeriesChart', 'GRAPH_SCHEDULER', 'useGraphScheduler', 'useGraphWatch',
    'fetchGraph', 'parseGraph', 'parseGraphDescriptor', 'parseWatchSnapshot', 'parseGraphChange', 'requestJson', 'apiUrl',
    'DEFAULT_API_BASE', 'expectObject', 'expectString', 'expectFinite', 'expectBoolean', 'expectArray',
    'admitted', 'PRELOAD_COUNT', 'isStale', 'mergeTail', 'samplePoints', 'tailRange', 'toTimeSeries', 'toYAxis', 'formatDate', 'formatValue']) {
    assert.ok(names.includes(name), `dist/index.js does not export ${name}`)
  }
})

test('dist imports its runtime dependencies instead of bundling them', async () => {
  const index = await read('../dist/index.js')
  for (const dependency of ['vue', '@0k/time-chart', '@0k/kal-sse-client']) {
    assert.match(index, new RegExp(`from ["']${dependency.replace('/', '\\/')}["']`), `${dependency} must stay external`)
  }
  assert.doesNotMatch(index, /function createRenderer\(|echarts\.init/)
})

test('api entry is framework-free and runs in Node', async () => {
  const api = await read('../dist/api.js')
  assert.doesNotMatch(api, /from ["'](vue|@0k\/)/)
  const module = await import('../dist/api.js')
  assert.equal(module.DEFAULT_API_BASE, 'api/')
  assert.deepEqual(module.parseGraphChange({ id: 'a' }), { id: 'a' })
})

test('the package entries load through their exports from import and require', async () => {
  const api = await import('@0k/rrd-graph/api')
  assert.equal(api.DEFAULT_API_BASE, 'api/')
  // Node 22.12+ loads ESM from require(); the `default` condition allows it.
  assert.equal(createRequire(import.meta.url)('@0k/rrd-graph/api').DEFAULT_API_BASE, 'api/')
})

test('declarations resolve under node16 rules: .js specifiers, no stylesheet import', async () => {
  const files = (await readdir(new URL('../dist/', import.meta.url), { recursive: true })).filter(file => file.endsWith('.d.ts'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = await read(`../dist/${file}`)
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*['"](\.[^'"]*)['"]/g)) {
      assert.match(specifier, /\.(js|vue)$/, `${file} imports ${specifier} without an extension`)
    }
    assert.doesNotMatch(source, /\.css['"]/, `${file} imports a stylesheet`)
  }
})

test('declarations cover entries and components', async () => {
  const index = await read('../dist/index.d.ts')
  assert.match(index, /GraphCard/)
  assert.match(await read('../dist/api.d.ts'), /fetchGraph/)
  assert.match(await read('../dist/components/GraphCard.vue.d.ts'), /apiBase/)
})

test('style.css carries the card layout', async () => {
  const style = await read('../dist/style.css')
  assert.match(style, /\.graph-card\s*\{/)
  assert.match(style, /\.chart-host\s*\{/)
})
