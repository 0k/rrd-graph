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
 * Data time-chart rejects emits `error` instead of `ready`; the chart is
 * created, or its series replaced, by the next data it accepts.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createTimeChart, type TimeChart } from '@0k/time-chart'
import type { GraphData, TimeWindow } from '../types.js'
import { toTimeSeries, toYAxis } from '../utils/chart.js'
import { formatValue } from '../utils/format.js'

const LINK = 'rrd-graph'

const props = defineProps<{ data: GraphData; window: TimeWindow; tall: boolean; stacked: boolean }>()
const emit = defineEmits<{ window: [start: number, end: number]; ready: []; error: [message: string] }>()
const host = ref<HTMLElement | null>(null)
let chart: TimeChart | null = null
let readyFrame: number | null = null

const ms = (w: TimeWindow) => ({ start: w.start * 1000, end: w.end * 1000 })

onMounted(() => draw(props.data, props.stacked))

/** Create the chart, or replace its series; `ready` when painted, else `error`. */
function draw(data: GraphData, stacked: boolean): void {
  const el = host.value
  if (!el) throw new Error('chart host element missing')
  if (readyFrame !== null) cancelAnimationFrame(readyFrame)
  readyFrame = null
  try {
    if (chart) chart.setSeries(toTimeSeries(data, stacked))
    else chart = create(el, data, stacked)
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : String(cause))
    return
  }
  signalReady()
}

function create(el: HTMLElement, data: GraphData, stacked: boolean): TimeChart {
  const unit = data.unit
  const yAxis = toYAxis(data)
  return createTimeChart(el, {
    series: toTimeSeries(data, stacked),
    // The y axis is fixed for the chart's lifetime (charts are recreated
    // whenever their card becomes visible again).
    ...(yAxis ? { yAxis } : {}),
    window: ms(props.window),
    formatValue: v => formatValue(v, unit),
    tooltip: 'axis',
    link: LINK,
    // The legend fits the widest label (ellipsized past time-chart's
    // maxWidth), leaving the rest to the plot.  Through `link`, every
    // mounted chart takes the widest legend among them, so plots line up.
    legend: { width: 'auto' },
    onWindowChange: (start, end) => emit('window', Math.floor(start / 1000), Math.ceil(end / 1000)),
  })
}

/** `ready` once the frame after the latest series change has painted. */
function signalReady(): void {
  readyFrame = requestAnimationFrame(() => { readyFrame = null; emit('ready') })
}

// Re-stacking reuses the data already fetched.
watch(() => [props.data, props.stacked] as const, ([data, stacked]) => draw(data, stacked))
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
