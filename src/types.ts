export type GraphType = 'line' | 'stacked'

/** What a host knows about one graph before fetching it (`api/tree` graph nodes carry these fields). */
export interface GraphDescriptor {
  id: string
  title: string
  type: GraphType
  /** Show a switch to stack/unstack the series; `type` is the initial layout. */
  stack_toggle: boolean
  unit: string | null
}

export interface GraphSeries {
  label: string
  avg: (number | null)[]
  min?: (number | null)[]
  max?: (number | null)[]
}

/** One `api/graph` response: series on a common time grid (Unix seconds). */
export interface GraphData {
  id: string
  title: string
  unit: string | null
  type: GraphType
  start: number
  step: number
  len: number
  series: GraphSeries[]
  last_update: number | null
  notes: string[]
}

/** Displayed time window in Unix seconds; `live` windows slide with the clock. */
export interface TimeWindow {
  start: number
  end: number
  live: boolean
}

/** `points` for a full window load; `step` (and kept labels) for a tail. */
export type GraphResolution = { points: number } | { step: number; keep?: string[] }
