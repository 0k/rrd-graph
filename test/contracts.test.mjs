import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('API URLs are relative: no absolute /api/ path anywhere in the request code', async () => {
  const sources = await Promise.all(['../src/api.ts', '../src/composables/useGraphWatch.ts', '../src/components/GraphCard.vue'].map(read))
  for (const source of sources) assert.doesNotMatch(source, /['"`]\/api\//)
  assert.match(sources[0], /DEFAULT_API_BASE = 'api\/'/)
})

test('linked charts share one link key', async () => {
  assert.match(await read('../src/components/TimeSeriesChart.vue'), /link: LINK/)
})

test('graph types carry no tree knowledge', async () => {
  const types = await read('../src/types.ts')
  assert.doesNotMatch(types, /\bkind\b|children|GroupNode|TreeNode|TreeConfig|ranges/)
  assert.doesNotMatch(await read('../src/components/GraphCard.vue'), /GraphNode|TreeNode/)
})

test('card CSS is themed by --rrd-graph-* properties, never host variables, and matches CARD_PADDING_X', async () => {
  const [style, card] = await Promise.all([read('../src/style.css'), read('../src/components/GraphCard.vue')])
  assert.doesNotMatch(style, /var\(--(c|sp|fs|radius)-/)
  assert.match(style, /var\(--rrd-graph-/)
  const padding = Number(card.match(/CARD_PADDING_X = (\d+)/)[1])
  assert.match(style, new RegExp(`\\.graph-card \\{ padding: \\d+px ${padding}px; \\}`))
})
