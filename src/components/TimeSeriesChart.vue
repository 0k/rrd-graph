<script setup lang="ts">
/**
 * One graph drawn with `@0k/time-chart`.
 *
 * Charts exist only for visible cards and share the `LINK` key, so linked
 * pan/zoom redraws only visible charts. A user pan/zoom reports `window`
 * (seconds); the host applies it and admitted cards refetch data at the
 * matching resolution, returning here as new `data`/`window`.
 * A live clock slide only pans held data via setWindow; graph-change events
 * fetch tails for the changed cards, not full windows for the whole page.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createTimeChart, type TimeChart } from '@0k/time-chart'
import type { GraphData, TimeWindow } from '../types.js'
import { toTimeSeries } from '../utils/chart.js'
import { formatValue } from '../utils/format.js'

const LINK = 'rrd-graph'

const props = defineProps<{ data: GraphData; window: TimeWindow; tall: boolean; stacked: boolean }>()
const emit = defineEmits<{ window: [start: number, end: number]; ready: [] }>()
const host = ref<HTMLElement | null>(null)
let chart: TimeChart | null = null
let readyFrame: number | null = null

const ms = (w: TimeWindow) => ({ start: w.start * 1000, end: w.end * 1000 })

onMounted(() => {
  if (!host.value) throw new Error('chart host element missing')
  const unit = props.data.unit
  chart = createTimeChart(host.value, {
    series: toTimeSeries(props.data, props.stacked),
    window: ms(props.window),
    formatValue: v => formatValue(v, unit),
    tooltip: 'axis',
    link: LINK,
    // Same legend width everywhere so linked charts' plots line up.
    legend: { width: 300 },
    onWindowChange: (start, end) => emit('window', Math.floor(start / 1000), Math.ceil(end / 1000)),
  })
  signalReady()
})

/** `ready` once the frame after the latest series change has painted. */
function signalReady(): void {
  if (readyFrame !== null) cancelAnimationFrame(readyFrame)
  readyFrame = requestAnimationFrame(() => { readyFrame = null; emit('ready') })
}

// Re-stacking reuses the data already fetched.
watch(() => [props.data, props.stacked] as const, ([data, stacked]) => {
  if (!chart) return
  chart.setSeries(toTimeSeries(data, stacked))
  signalReady()
})
watch(() => [props.window.start, props.window.end], () => {
  if (!chart) return
  const next = ms(props.window)
  const current = chart.getWindow()
  // The window may come from this very chart's zoom: do not re-apply it.
  if (Math.abs(current.start - next.start) >= 1000 || Math.abs(current.end - next.end) >= 1000) {
    chart.setWindow(next.start, next.end)
  }
})
onBeforeUnmount(() => { if (readyFrame !== null) cancelAnimationFrame(readyFrame); chart?.destroy(); chart = null })
</script>

<template>
  <div ref="host" class="chart-host" :class="{ 'chart-host--tall': tall }" data-testid="chart"></div>
</template>
