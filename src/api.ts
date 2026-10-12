// Client side of the kal-rrd-graph HTTP contract: validated `api/graph`
// responses, graph watch events, and the JSON primitives hosts reuse to
// validate their own kal-rrd-graph responses.  Framework-free.
import type { GraphData, GraphDescriptor, GraphResolution, GraphSeries, GraphType, GraphYAxis, SeriesStyle } from './types.js'

export type Fetcher = typeof fetch

/** Relative on purpose: hosts are served at `/` and behind reverse-proxy prefixes. */
export const DEFAULT_API_BASE = 'api/'

export interface RequestOptions {
  signal?: AbortSignal
  fetcher?: Fetcher
}

export interface GraphRequestOptions extends RequestOptions {
  /** URL prefix of the kal-rrd-graph API, default `api/`. */
  base?: string
}

/** Join an API base and an endpoint path (`apiUrl('api', 'graph')` → `api/graph`). */
export function apiUrl(base: string, path: string): string {
  return base === '' || base.endsWith('/') ? `${base}${path}` : `${base}/${path}`
}

export function expectObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid API response: expected an object')
  }
  return value as Record<string, unknown>
}

export function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid API response: ${field} must be a string`)
  return value
}

export function expectFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid API response: ${field} must be finite`)
  return value
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid API response: ${field} must be a boolean`)
  return value
}

export function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API response: ${field} must be an array`)
  return value
}

function graphType(value: unknown): GraphType {
  if (value !== 'line' && value !== 'stacked') throw new Error('Invalid API response: unknown graph type')
  return value
}

function unit(value: unknown): string | null {
  return value === null ? null : expectString(value, 'unit')
}

/** Validate the graph fields of a descriptor; other fields (e.g. a tree `kind`) are the host's. */
export function parseGraphDescriptor(value: unknown): GraphDescriptor {
  const v = expectObject(value)
  return {
    id: expectString(v.id, 'id'), title: expectString(v.title, 'title'), type: graphType(v.type),
    stack_toggle: expectBoolean(v.stack_toggle, 'stack_toggle'), unit: unit(v.unit),
  }
}

export function parseWatchSnapshot(value: unknown): { ids: string[] } {
  const v = expectObject(value)
  return { ids: expectArray(v.ids, 'ids').map(id => expectString(id, 'id')) }
}

export function parseGraphChange(value: unknown): { id: string } {
  return { id: expectString(expectObject(value).id, 'id') }
}

function values(value: unknown, len: number, field: string): (number | null)[] {
  const list = expectArray(value, field)
  if (list.length !== len) throw new Error(`Invalid API response: ${field} length must be ${len}`)
  return list.map(item => item === null ? null : expectFinite(item, field))
}

export function parseGraph(value: unknown): GraphData {
  const v = expectObject(value)
  const len = expectFinite(v.len, 'len')
  const step = expectFinite(v.step, 'step')
  if (!Number.isInteger(len) || len < 0 || step <= 0) throw new Error('Invalid API response: invalid time grid')
  const labels = new Set<string>()
  const series = expectArray(v.series, 'series').map(item => {
    const s = expectObject(item)
    const label = expectString(s.label, 'label')
    // time-chart identifies series by label and reserves NUL-prefixed ids.
    if (label === '' || label.startsWith('\u0000')) throw new Error('Invalid API response: series label must be nonempty and not start with NUL')
    if (labels.has(label)) throw new Error(`Invalid API response: duplicate series label ${label}`)
    labels.add(label)
    const result: GraphSeries = { label, avg: values(s.avg, len, 'avg') }
    if (s.min !== undefined) result.min = values(s.min, len, 'min')
    if (s.max !== undefined) result.max = values(s.max, len, 'max')
    return { ...result, ...seriesStyle(s, result) }
  })
  const graph: GraphData = {
    id: expectString(v.id, 'id'), title: expectString(v.title, 'title'), unit: unit(v.unit), type: graphType(v.type),
    start: expectFinite(v.start, 'start'), step, len, series,
    last_update: v.last_update === null ? null : expectFinite(v.last_update, 'last_update'),
    notes: expectArray(v.notes, 'notes').map(item => expectString(item, 'note')),
  }
  if (v.y_axis !== undefined) graph.y_axis = yAxis(v.y_axis)
  return graph
}

const UNIT_INTERVAL = (n: number) => n > 0 && n <= 1

/** Drawing keys present on one series; time-chart re-validates the combination. */
function seriesStyle(s: Record<string, unknown>, data: GraphSeries): SeriesStyle {
  const style: SeriesStyle = {}
  if (s.color !== undefined) style.color = expectString(s.color, 'color')
  if (s.dash !== undefined) {
    if (s.dash !== 'solid' && s.dash !== 'dashed' && s.dash !== 'dotted') throw new Error('Invalid API response: unknown dash')
    style.dash = s.dash
  }
  if (s.width !== undefined) {
    style.width = expectFinite(s.width, 'width')
    if (style.width <= 0) throw new Error('Invalid API response: width must be positive')
  }
  if (s.fill !== undefined) {
    style.fill = expectFinite(s.fill, 'fill')
    if (!UNIT_INTERVAL(style.fill)) throw new Error('Invalid API response: fill must be in (0, 1]')
  }
  if (s.band !== undefined) {
    const band = expectObject(s.band)
    if (!data.min || !data.max) throw new Error('Invalid API response: band needs min and max')
    if (band.pattern !== 'solid' && band.pattern !== 'hatch') throw new Error('Invalid API response: unknown band pattern')
    style.band = { pattern: band.pattern }
    if (band.opacity !== undefined) {
      const opacity = expectFinite(band.opacity, 'band opacity')
      if (!UNIT_INTERVAL(opacity)) throw new Error('Invalid API response: band opacity must be in (0, 1]')
      style.band.opacity = opacity
    }
  }
  if (s.line !== undefined) {
    if (s.line !== false) throw new Error('Invalid API response: line must be false when present')
    style.line = false
  }
  return style
}

const Y_AXIS_KEYS = ['min', 'max', 'interval', 'minor_interval'] as const
const MAX_MINOR_SPLIT = 99

function yAxis(value: unknown): GraphYAxis {
  const v = expectObject(value)
  const axis: GraphYAxis = {}
  for (const key of Object.keys(v)) {
    if (!(Y_AXIS_KEYS as readonly string[]).includes(key)) throw new Error(`Invalid API response: unknown y_axis key ${key}`)
  }
  for (const key of Y_AXIS_KEYS) if (v[key] !== undefined) axis[key] = expectFinite(v[key], `y_axis.${key}`)
  if (axis.interval !== undefined && axis.interval <= 0) throw new Error('Invalid API response: y_axis.interval must be positive')
  if (axis.minor_interval !== undefined) {
    if (axis.interval === undefined) throw new Error('Invalid API response: y_axis.minor_interval must divide y_axis.interval')
    // time-chart's rule: ECharts draws 5 minor ticks instead of 100 or more.
    const count = axis.interval / axis.minor_interval
    if (!(axis.minor_interval > 0) || Math.round(count) < 2 || Math.round(count) > MAX_MINOR_SPLIT || Math.abs(count - Math.round(count)) > Number.EPSILON * Math.max(1, count) * 4) {
      throw new Error(`Invalid API response: y_axis.minor_interval must divide y_axis.interval into 2 to ${MAX_MINOR_SPLIT} steps`)
    }
  }
  return axis
}

/** GET a JSON body; a non-2xx status throws the server's `error` text when it has one. */
export async function requestJson(url: string, { signal, fetcher = fetch }: RequestOptions = {}): Promise<unknown> {
  const response = await fetcher(url, { signal })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}: response is not valid JSON`)
  }
  if (!response.ok) {
    const v = expectObject(body)
    throw new Error(typeof v.error === 'string' ? v.error : `HTTP ${response.status} ${response.statusText}`)
  }
  return body
}

export async function fetchGraph(id: string, start: number, end: number, resolution: GraphResolution, { base = DEFAULT_API_BASE, ...options }: GraphRequestOptions = {}): Promise<GraphData> {
  const query = new URLSearchParams({ id, start: String(start), end: String(end) })
  if ('points' in resolution) query.set('points', String(resolution.points))
  else {
    query.set('step', String(resolution.step))
    for (const label of resolution.keep ?? []) query.append('keep', label)
  }
  const graph = parseGraph(await requestJson(`${apiUrl(base, 'graph')}?${query}`, options))
  if (graph.id !== id) throw new Error('Invalid API response: graph id does not match request')
  return graph
}
