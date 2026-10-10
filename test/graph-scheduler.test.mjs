import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { effectScope, ref } from 'vue'
import { loadTs, moduleUrl } from './load-ts.mjs'

const schedule = moduleUrl(await readFile(new URL('../src/utils/schedule.ts', import.meta.url), 'utf8'))
const { useGraphScheduler } = await loadTs('../src/composables/useGraphScheduler.ts', {
  vue: import.meta.resolve('vue'), '../utils/schedule.js': schedule,
})

// Acceptance ledger: one exact-viewport observer, reactive admission opens only
// after all visible cards settle, removed targets cannot resurrect visibility,
// displayed order changes recompute the ring, and scope disposal disconnects.
test('one observer owns registration, settlement, order changes and scope cleanup', t => {
  const previous = globalThis.IntersectionObserver
  const instances = []
  globalThis.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback; this.options = options; this.targets = new Set()
      instances.push(this)
    }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.disconnected = true; this.targets.clear() }
  }
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    if (previous === undefined) delete globalThis.IntersectionObserver
    else globalThis.IntersectionObserver = previous
  })
  const order = ref(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  const scheduler = scope.run(() => useGraphScheduler(order))
  const a = {}; const b = {}
  scheduler.register('a', a); scheduler.register('b', b)
  assert.equal(instances.length, 1)
  const observer = instances[0]
  assert.deepEqual(observer.options, { root: null, rootMargin: '0px', threshold: 0 })
  const admission = () => order.value.filter(id => scheduler.isAdmitted(id))
  assert.deepEqual(admission(), [])
  observer.callback([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }])
  assert.equal(scheduler.isVisible('a'), true)
  assert.deepEqual(admission(), ['a', 'b'])
  scheduler.setSettled('a', true)
  assert.deepEqual(admission(), ['a', 'b'])
  scheduler.setSettled('b', true)
  assert.deepEqual(admission(), ['a', 'b', 'c', 'd', 'e', 'f'])
  scheduler.setSettled('a', false)
  assert.deepEqual(admission(), ['a', 'b'])
  scheduler.setSettled('a', true)
  order.value = ['g', 'f', 'e', 'd', 'c', 'b', 'a']
  assert.deepEqual(admission(), ['b', 'a'])
  scheduler.unregister('a')
  observer.callback([{ target: a, isIntersecting: true }])
  assert.equal(scheduler.isVisible('a'), false)
  assert.equal(observer.targets.has(a), false)
  observer.callback([{ target: b, isIntersecting: false }])
  assert.deepEqual(admission(), [])
  scope.stop()
  assert.equal(observer.disconnected, true)
  assert.equal(observer.targets.size, 0)
})
