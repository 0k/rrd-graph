<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_API_BASE, fetchGraph } from '../api.js'
import { GRAPH_SCHEDULER, useGraphScheduler } from '../composables/useGraphScheduler.js'
import type { GraphData, GraphDescriptor, TimeWindow } from '../types.js'
import { isStale, mergeTail, samplePoints, tailRange } from '../utils/chart.js'
import { formatDate } from '../utils/format.js'
import TimeSeriesChart from './TimeSeriesChart.vue'

// Horizontal padding of `.graph-card` in style.css.
const CARD_PADDING_X = 12

const props = withDefaults(defineProps<{
  graph: GraphDescriptor
  window: TimeWindow
  /** Host config revision: a change reloads the whole window. */
  revision?: number
  /** Per-graph change counter (see `useGraphWatch`): a change fetches a tail. */
  change?: number
  tall?: boolean
  /** URL prefix of the kal-rrd-graph API; relative so prefixed deployments work. */
  apiBase?: string
}>(), { revision: 0, change: 0, tall: false, apiBase: DEFAULT_API_BASE })
const emit = defineEmits<{ window: [start: number, end: number] }>()
// A page of cards shares one injected scheduler; a card on its own schedules
// itself (it loads once visible).
const scheduler = inject(GRAPH_SCHEDULER, null) ?? useGraphScheduler(computed(() => [props.graph.id]))
const visible = computed(() => scheduler.isVisible(props.graph.id))
const admitted = computed(() => scheduler.isAdmitted(props.graph.id))
const host = ref<HTMLElement | null>(null)
const data = ref<GraphData | null>(null)
const error = ref<string | null>(null)
/** Why the chart rejected the held data; cleared once it draws again. */
const chartError = ref<string | null>(null)
const loading = ref(false)
const tailLoading = ref(false)
const needsLoad = ref(true)
const chartReady = ref(false)
const points = ref(100)
const tailRequests = ref(0)
// Initial layout from the YAML `type`; the header switch (when the graph
// sets `stack-toggle`) changes it for this page only.
const stacked = ref(props.graph.type === 'stacked')
let request: AbortController | null = null
let tailRequest: AbortController | null = null
let pendingTail = false
let observer: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let active = false

function pump(): void {
  if (!active || !admitted.value || request || tailRequest) return
  if (needsLoad.value) void load()
  else if (pendingTail && !error.value) void loadTail()
}

function invalidate(): void {
  request?.abort()
  tailRequest?.abort()
  request = null
  tailRequest = null
  loading.value = false
  tailLoading.value = false
  needsLoad.value = true
  // Held data stays drawn (marked "Refreshing…") until its replacement
  // arrives: dropping it would destroy the chart under a pan or zoom.
  error.value = null
  pump()
}

async function load(): Promise<void> {
  request?.abort()
  tailRequest?.abort()
  tailRequest = null
  tailLoading.value = false
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = null
  try {
    const result = await fetchGraph(props.graph.id, props.window.start, props.window.end, { points: points.value },
      { signal: controller.signal, base: props.apiBase })
    if (!controller.signal.aborted) {
      // Settled again only once the chart has painted the new data.
      chartReady.value = false
      data.value = result
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === controller) {
      request = null
      needsLoad.value = false
      loading.value = false
      pump()
    }
  }
}

async function loadTail(): Promise<void> {
  if (!active) return
  if (!admitted.value) { pendingTail = true; return }
  if (request || !data.value) {
    pendingTail = true
    return
  }
  pendingTail = false
  const held = data.value
  const range = tailRange(held, props.window)
  if (range === null) {
    invalidate()
    return
  }
  tailRequest?.abort()
  const controller = new AbortController()
  tailRequest = controller
  tailLoading.value = true
  tailRequests.value++
  try {
    const keep = held.series.map(series => series.label).filter(label => !/^other \(\d+\)$/.test(label))
    const tail = await fetchGraph(props.graph.id, range.start, range.end,
      { step: range.step, keep }, { signal: controller.signal, base: props.apiBase })
    if (controller.signal.aborted) return
    const merged = mergeTail(held, tail, props.window.start)
    if (merged === null) {
      console.info('Graph tail incompatible with held grid, labels or min/max presence; reloading', props.graph.id)
      invalidate()
    } else {
      data.value = merged
      error.value = null
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (tailRequest === controller) {
      tailRequest = null
      tailLoading.value = false
      pump()
    }
  }
}

function measure(): void {
  if (!host.value) return
  // Plot width: card minus its horizontal padding, the chart's left axis and right legend.
  const width = host.value.clientWidth - 2 * CARD_PADDING_X - 64 - 324
  const next = samplePoints(width)
  if (next === points.value) return
  points.value = next
  if (active) invalidate()
}

onMounted(() => {
  measure()
  active = true
  if (!host.value) throw new Error('GraphCard host element missing')
  scheduler.register(props.graph.id, host.value)
  invalidate()
  observer = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(measure, 200)
  })
  if (host.value) observer.observe(host.value)
})
watch(() => [props.graph.id, props.revision, props.window] as const, ([id, revision, next], [oldId, oldRevision, previous]) => {
  if (!active) return
  if (id !== oldId || revision !== oldRevision) {
    if (id !== oldId) {
      scheduler.unregister(oldId)
      if (host.value) scheduler.register(id, host.value)
      pendingTail = false
      data.value = null
    }
    invalidate()
    return
  }
  if (next.start === previous.start && next.end === previous.end && next.live === previous.live) return
  const span = next.end - next.start
  const slide = next.live && previous.live && span === previous.end - previous.start
    && next.end > previous.end
  if (!slide) invalidate()
})
watch(() => props.change, () => { if (active) void loadTail() })
watch(() => props.graph.type, t => { stacked.value = t === 'stacked' })
watch(admitted, pump)
watch(visible, value => { if (!value) chartReady.value = false }, { flush: 'sync' })
const settled = computed(() => !needsLoad.value && !loading.value && !tailLoading.value
  && Boolean(error.value || chartError.value || (data.value && (data.value.series.length === 0 || chartReady.value))))
watch(settled, value => scheduler.setSettled(props.graph.id, value), { flush: 'sync' })
onBeforeUnmount(() => { active = false; scheduler.unregister(props.graph.id); request?.abort(); tailRequest?.abort(); observer?.disconnect(); if (resizeTimer) clearTimeout(resizeTimer) })
const stale = computed(() => data.value && isStale(data.value.last_update, data.value.step, props.window.end, props.window.live))
</script>

<template>
  <article ref="host" class="graph-card section" :data-graph-id="graph.id" :data-visible="visible" :data-admitted="admitted" :data-loading="loading" :data-last-update="data?.last_update" :data-tail-requests="tailRequests" :data-points="points" :data-window="`${window.start}-${window.end}`" :data-stacked="stacked">
    <header class="section__head">
      <h3>{{ data?.title ?? graph.title }}</h3>
      <span v-if="stale && data?.last_update !== null" class="stale-badge">stale: last data {{ formatDate(data!.last_update!) }}</span>
      <span v-if="loading" class="muted" role="status">{{ data ? 'Refreshing…' : 'Loading…' }}</span>
      <div v-if="graph.stack_toggle" class="stack-toggle" role="group" aria-label="Series layout" data-testid="stack-toggle">
        <button type="button" :aria-pressed="stacked" data-layout="stacked" @click="stacked = true">Stacked</button>
        <button type="button" :aria-pressed="!stacked" data-layout="lines" @click="stacked = false">Lines</button>
      </div>
    </header>
    <div v-if="error || chartError" class="error-banner" role="alert"><span>{{ error ?? chartError }}</span><button @click="load">Retry</button></div>
    <TimeSeriesChart v-if="data && visible" v-show="data.series.length > 0" :data="data" :window="window" :tall="tall" :stacked="stacked" @ready="chartReady = true; chartError = null" @error="message => chartError = message" @vue:unmounted="chartReady = false; chartError = null" @window="(s, e) => emit('window', s, e)" />
    <div v-if="data && data.series.length === 0" class="no-data" data-testid="no-data"><strong>No data</strong><p v-for="note in data.notes" :key="note">{{ note }}</p></div>
    <ul v-else-if="data?.notes.length" class="section__note"><li v-for="note in data.notes" :key="note">{{ note }}</li></ul>
    <div v-if="!(data && visible) && !(data && data.series.length === 0) && !error && !chartError" class="chart-placeholder" :class="{ 'chart-placeholder--tall': tall }" aria-hidden="true"></div>
  </article>
</template>

<!-- The package stylesheet: Vite extracts it to dist/style.css, which hosts
     import as `@0k/rrd-graph/style.css`, after their own styles. -->
<style src="../style.css"></style>
