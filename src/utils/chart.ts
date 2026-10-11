import type { TimeChartOptions, TimeSeries } from '@0k/time-chart'
import type { GraphData, GraphSeries, TimeWindow } from '../types.js'

/** Fetch from the real data end, not the grid's null-padded window end. */
export function tailRange(held: Pick<GraphData, 'last_update' | 'step'>, window: TimeWindow): { start: number; end: number; step: number } | null {
  if (held.last_update === null || window.end - held.last_update > (window.end - window.start) / 2) return null
  const step = held.step
  // Point T summarises (T-step, T]; g0=floor(start/step)*step and the first
  // point is g0+step. Reread the possibly partial update bucket and one before.
  return { start: Math.max(window.start, Math.ceil(held.last_update / step) * step - 2 * step), end: window.end, step }
}

/** A tail owns every bucket it covers, including gaps and incomplete buckets. */
export function mergeTail(held: GraphData, tail: GraphData, windowStart: number): GraphData | null {
  if (tail.step !== held.step || (tail.start - held.start) % held.step !== 0) return null
  const byLabel = new Map(tail.series.map(series => [series.label, series]))
  if (byLabel.size !== held.series.length) return null
  for (const series of held.series) {
    const next = byLabel.get(series.label)
    if (!next || (series.min === undefined) !== (next.min === undefined)
      || (series.max === undefined) !== (next.max === undefined)) return null
  }
  const step = held.step
  const first = Math.max(0, Math.ceil((windowStart - step - held.start) / step))
  const start = held.start + first * step
  const end = Math.max(held.start + held.len * step, tail.start + tail.len * step)
  const len = Math.max(0, (end - start) / step)
  const series = held.series.map(previous => {
    const next = byLabel.get(previous.label)!
    const merge = (oldValues: (number | null)[], newValues: (number | null)[]) =>
      Array.from({ length: len }, (_, i) => {
        const time = start + i * step
        const tailIndex = (time - tail.start) / step
        if (tailIndex >= 0 && tailIndex < tail.len) return newValues[tailIndex]!
        return oldValues[(time - held.start) / step] ?? null
      })
    // Drawing keys come from the newest response, like the graph metadata.
    const { label: _label, avg: _avg, min: _min, max: _max, ...style } = next
    const result: GraphSeries = { label: previous.label, avg: merge(previous.avg, next.avg) }
    if (previous.min && next.min) result.min = merge(previous.min, next.min)
    if (previous.max && next.max) result.max = merge(previous.max, next.max)
    return { ...result, ...style }
  })
  return { ...tail, start, step, len, series }
}

/** Convert one `api/graph` response to `@0k/time-chart` series (ms), stacked or not. */
export function toTimeSeries(graph: Pick<GraphData, 'start' | 'step' | 'series'>, stacked: boolean): TimeSeries[] {
  return graph.series.map(s => {
    const series: TimeSeries = {
      id: s.label,
      label: s.label,
      points: s.avg.map((v, i) => [(graph.start + i * graph.step) * 1000, v]),
      stack: stacked,
    }
    if (s.min && s.max) {
      series.min = s.min
      series.max = s.max
    }
    if (s.color !== undefined) series.color = s.color
    if (s.dash !== undefined) series.dash = s.dash
    if (s.width !== undefined) series.width = s.width
    if (s.fill !== undefined) series.fill = s.fill
    if (s.band !== undefined) series.band = { ...s.band }
    if (s.line !== undefined) series.line = s.line
    return series
  })
}

/** The graph's `y_axis` as `@0k/time-chart` `yAxis` options, or undefined. */
export function toYAxis(graph: Pick<GraphData, 'y_axis'>): TimeChartOptions['yAxis'] {
  const axis = graph.y_axis
  if (!axis) return undefined
  const options: NonNullable<TimeChartOptions['yAxis']> = {}
  if (axis.min !== undefined) options.min = axis.min
  if (axis.max !== undefined) options.max = axis.max
  if (axis.interval !== undefined) options.interval = axis.interval
  if (axis.minor_interval !== undefined) options.minorInterval = axis.minor_interval
  return options
}

export function samplePoints(width: number): number {
  return Math.max(100, Math.min(2000, Math.round(width / 2)))
}

export function isStale(last: number | null, step: number, end: number, live: boolean): boolean {
  return live && last !== null && end - last > Math.max(600, 3 * step)
}
