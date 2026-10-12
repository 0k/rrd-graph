import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { createSnapshotCursorSse, type SnapshotCursorSseChannel } from '@0k/kal-sse-client'
import { apiUrl, DEFAULT_API_BASE, parseGraphChange, parseWatchSnapshot } from '../api.js'
import type { TimeWindow } from '../types.js'

export interface GraphWatchOptions {
  /** URL prefix of the kal-rrd-graph API, default `api/`. */
  apiBase?: string
}

/**
 * One server subscription for the displayed set, not one per moving window.
 * Returns per-graph change counters (pass each as a card's `change`); a
 * change of a live window also advances `now` to the current second.
 */
export function useGraphWatch(ids: Ref<readonly string[]>, window: Ref<TimeWindow>, now: Ref<number>, { apiBase = DEFAULT_API_BASE }: GraphWatchOptions = {}) {
  const changes = ref<Record<string, number>>({})
  const watching = ref(false)
  let expiry: ReturnType<typeof setTimeout> | undefined
  function updateWatching(): void {
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
    watching.value = window.value.live || window.value.end > Date.now() / 1000
    // A fixed future window stops watching when its end becomes historical.
    // This deadline never advances `now` or refreshes graphs.
    if (watching.value && !window.value.live) {
      expiry = setTimeout(updateWatching, Math.min(2147483647, Math.ceil(window.value.end * 1000 - Date.now())))
    }
  }
  watch(() => [window.value.live, window.value.end], updateWatching, { immediate: true })
  const key = computed(() => JSON.stringify(
    watching.value ? [...new Set(ids.value)].sort() : [],
  ))
  let channel: SnapshotCursorSseChannel | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<string>()

  function stop(): void {
    channel?.stop()
    channel = null
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending.clear()
  }

  watch(key, value => {
    stop()
    const displayed = new Set<string>(JSON.parse(value) as string[])
    if (displayed.size === 0) return
    const query = new URLSearchParams()
    for (const id of displayed) query.append('id', id)
    let snapshotSeen = false
    function enqueue(id: string): void {
      if (!displayed.has(id)) return
      pending.add(id)
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (window.value.live) now.value = Math.floor(Date.now() / 1000)
        for (const changed of pending) changes.value[changed] = (changes.value[changed] ?? 0) + 1
        pending.clear()
      }, 250)
    }
    channel = createSnapshotCursorSse<unknown>({
      snapshotPath: `${apiUrl(apiBase, 'watch')}?${query}`,
      streamPath: apiUrl(apiBase, 'watch/events'),
      resolveUrl: path => new URL(path, document.baseURI).href,
      applySnapshot: value => {
        parseWatchSnapshot(value)
        if (snapshotSeen) for (const id of displayed) enqueue(id)
        snapshotSeen = true
      },
      onMessage: event => {
        try {
          enqueue(parseGraphChange(JSON.parse(event.data)).id)
        } catch (cause) {
          console.error('Invalid graph watch event', cause)
        }
      },
      onSnapshotError: cause => console.error('Graph watch snapshot failed', cause),
    })
    void channel.start()
  }, { immediate: true })
  onBeforeUnmount(() => {
    stop()
    if (expiry !== undefined) clearTimeout(expiry)
  })
  return changes
}
