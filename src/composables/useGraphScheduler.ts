// Visible cards alone fetch and draw until every one has settled after paint.
// Then admit data-only prefetch for the next four below the last visible card.
// One page observer owns visibility; cards retain their own data and requests.
import { computed, onScopeDispose, reactive, type InjectionKey, type Ref } from 'vue'
import { admitted } from '../utils/schedule.js'

export interface GraphScheduler {
  register(id: string, el: HTMLElement): void
  unregister(id: string): void
  setSettled(id: string, settled: boolean): void
  isVisible(id: string): boolean
  isAdmitted(id: string): boolean
}

export const GRAPH_SCHEDULER: InjectionKey<GraphScheduler> = Symbol('graph scheduler')

export function useGraphScheduler(order: Ref<readonly string[]>): GraphScheduler {
  const visible = reactive(new Set<string>())
  const settled = reactive(new Set<string>())
  const elements = new Map<string, HTMLElement>()
  const ids = new Map<Element, string>()
  const admission = computed(() => admitted(order.value, visible, settled))
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = ids.get(entry.target)
      if (id === undefined) continue
      if (entry.isIntersecting) visible.add(id)
      else visible.delete(id)
    }
  }, { root: null, rootMargin: '0px', threshold: 0 })

  function unregister(id: string): void {
    const el = elements.get(id)
    if (el) { observer.unobserve(el); ids.delete(el); elements.delete(id) }
    visible.delete(id)
    settled.delete(id)
  }
  onScopeDispose(() => { observer.disconnect(); elements.clear(); ids.clear(); visible.clear(); settled.clear() })
  return {
    register(id, el) {
      unregister(id)
      elements.set(id, el)
      ids.set(el, id)
      observer.observe(el)
    },
    unregister,
    setSettled(id, value) { if (value) settled.add(id); else settled.delete(id) },
    isVisible: id => visible.has(id),
    isAdmitted: id => admission.value.has(id),
  }
}
