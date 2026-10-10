export const PRELOAD_COUNT = 4

export function admitted(order: readonly string[], visible: ReadonlySet<string>, settled: ReadonlySet<string>, preload = PRELOAD_COUNT): Set<string> {
  const result = new Set(order.filter(id => visible.has(id)))
  if (result.size === 0 || [...result].some(id => !settled.has(id))) return result
  let last = -1
  order.forEach((id, index) => { if (result.has(id)) last = index })
  for (const id of order.slice(last + 1, last + 1 + preload)) result.add(id)
  return result
}
