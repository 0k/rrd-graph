# @0k/rrd-graph

Vue 3 graph card for rrd-ui time series, extracted from the rrd-ui
frontend, which consumes it.  The package owns one
graph's fetch, validation, tail merging, chart drawing, visible-first
scheduling and change watching.  Hosts own the graph tree, routing,
period selection, configuration status and page layout.

## Rules

- **No tree knowledge.** `GraphDescriptor` is a graph's own fields; no
  `kind`, groups, children, ranges or routes enter this package.
- **Relative API URLs only.** Every request goes through `apiUrl(base, …)`
  with `base` defaulting to `api/`; never an absolute `/api/`.
- A card without an injected `GRAPH_SCHEDULER` schedules itself; a page
  provides one scheduler for all its cards.  Keep both working.
- Scheduler, tail and refresh semantics are specified by
  `test/graph-refresh.test.mjs`, `test/graph-scheduler.test.mjs`,
  `test/schedule.test.mjs` and `test/chart.test.mjs`.  Change the
  specification first, then the code.
- `src/api.ts` stays framework-free: it is also the `@0k/rrd-graph/api`
  entry, importable without Vue.
- `vue` is a peer and, like `@0k/time-chart` and `@0k/kal-sse-client`,
  stays external in the build.
- CSS colours use `--rrd-graph-*` custom properties with light fallbacks,
  never host variables.  `CARD_PADDING_X` in `GraphCard.vue` mirrors the
  `.graph-card` horizontal padding in `src/style.css`.
- Keep `test/acceptance-ledger.org` in sync with requirements and tests.
- Consumers depend on a published release; local path dependencies used
  to test unreleased changes are never committed in consumers.
- `@0k/kal-sse-client` is a vendored tarball (`vendor/`), not published
  on npm: settle how it is shipped before publishing this package.
- `README.md` is generated from `README.org`; never commit it.

## Build / test

```sh
npm install
npm run check    # test, typecheck, build, test:package
```
