# k6-performance

Performance suite with three profiles — **smoke**, **load** and **stress** —
against a **self-hosted target** that ships with the repository.

Load testing someone else's public API is abuse of their resources, so this one
brings its own: a zero-dependency `node:http` app whose handlers deliberately
have _different_ performance shapes, so the thresholds have something real to
measure.

## Prerequisites

| Requirement        | Notes                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **k6**             | [install guide](https://grafana.com/docs/k6/latest/set-up/install-k6/) — `brew install k6`, or download the binary |
| **Node.js 20.11+** | runs the target app and the wrapper script                                                                         |
| **Nothing else**   | `devDependencies` is empty; no `npm install` needed                                                                |
| **Port 3100 free** | override with `PORT=4100`                                                                                          |

## Running

The wrapper starts the target app, waits until it is **actually serving**, runs
k6, and shuts the app down whatever the outcome:

```bash
npm run test:smoke     # 1 VU, 10 iterations — is it up and correct?
npm run test:load      # ramp to 20 VUs, hold, ramp down — does it meet budget?
npm run test:stress    # ramping arrival rate to 300/s — where does it break?
npm run test:soak      # 5 minutes at 20 VUs — does it leak?
npm run test           # smoke, then load
npm run test:json      # load profile with a JSON result file
```

Two terminals, if you prefer:

```bash
npm run server                    # terminal 1
k6 run tests/load.js              # terminal 2
BASE_URL=http://127.0.0.1:3100 k6 run tests/stress.js
```

**The readiness poll is not decoration.** Launching k6 straight after spawning
the server produces connection-refused errors on the first iterations, which
appear as a failure rate that has nothing to do with the system under test.

## The three profiles

|            | Question                                             | Verdict     | Thresholds                    |
| ---------- | ---------------------------------------------------- | ----------- | ----------------------------- |
| **smoke**  | is it up and correct?                                | pass / fail | tight                         |
| **load**   | does it meet its budget at expected traffic?         | pass / fail | realistic                     |
| **stress** | where does it stop meeting it, and how does it fail? | exploratory | loose, about _degrading well_ |

A **stress test that passes every threshold has not found the limit** and
therefore has not done its job. Its thresholds assert that the service degrades
rather than collapses — slowing down or answering 429 is a service defending
itself; returning 500s or not responding is not.

The stress profile prints a narrative instead of a pass mark:

```
Stress summary
  requests            : 3599
  median latency      : 1ms
  p95 latency         : 94ms
  p99 latency         : 103ms
  unexpected failures : 0.00%
  verdict             : DEGRADED WITHIN BUDGET — slowed and/or rate-limited, but served
```

The median of 1ms with a p95 of 94ms is the rate limiter working: most requests
are rejected instantly at 40/s while 300/s arrive, and the ones that get through
pay the real cost.

## Why thresholds are the whole point

```js
thresholds: {
  http_req_failed:   ['rate<0.02'],
  http_req_duration: ['p(50)<150', 'p(95)<400', 'p(99)<800'],
  'http_req_duration{endpoint:products}': ['p(95)<200'],
}
```

Without thresholds a k6 script prints numbers and **always exits 0** — CI goes
green no matter how bad the result is. With them, a breach exits non-zero:

```bash
$ BASE_URL=http://127.0.0.1:3999 k6 run tests/smoke.js
✗ 'rate<0.01' rate=100.00%
$ echo $?
99
```

That exit code is the difference between a performance **test** and a
performance **report**.

**Percentiles, never averages.** An average of 120ms can hide a p99 of four
seconds, and that p99 is a real user waiting four seconds. Per-endpoint
thresholds exist because a catalogue read and a checkout have genuinely
different budgets — one global number either lets the slow path off or fails the
fast one.

## Findings

### A deliberate 404 breaks `http_req_failed`

The first smoke run reported `http_req_failed: 25%` while **all 90 checks were
green**. k6 derives that metric from `expected_response`, which defaults to
2xx/3xx — so the one intentional 404 in a four-request iteration counted as a
failed request and broke the threshold.

```js
http.get(`${BASE}/products/999999`, {
  responseCallback: http.expectedStatuses(404),
});
```

Declaring the expected status separates _"the request went wrong"_ from _"the
server correctly said no"_. The same applies to the 429s in the load and stress
profiles: a rate limiter answering 429 is working, not failing.

### `p(99)` is not in the default summary statistics

A threshold on `p(99)` works, but reading it back in `handleSummary` returns
`undefined` — the defaults are avg, min, med, max, p(90) and p(95). The stress
report first printed `p99 latency: 0ms` on a run that clearly had latency.

```js
summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
```

### VUs hide the limit; arrival rate finds it

The stress profile uses `ramping-arrival-rate`, not VUs, and that is the
important choice.

With plain VUs, a slowing server automatically receives **fewer** requests —
each virtual user waits longer for its response, so the offered load reduces
itself and the breaking point is never reached. Fixing the _request rate_
instead keeps the pressure constant while the server degrades, which is the
only way to observe what happens at the limit.

### Think time separates load from stress

`sleep(Math.random() + 0.5)` in the load profile is not padding. Without it the
test measures how fast the server can be hammered by 20 tight loops, which is a
stress profile wearing a load profile's name.

## The target application

`server/app.js` — plain `node:http`, no dependencies. Handlers are deliberately
not uniformly fast:

| Route           | Shape                            | Why                                            |
| --------------- | -------------------------------- | ---------------------------------------------- |
| `/health`       | constant, trivial                | baseline                                       |
| `/products`     | fast, cached-like                | the happy path                                 |
| `/products/:id` | small variable cost              | realistic jitter                               |
| `/search`       | **cost grows with query length** | the unindexed-scan shape                       |
| `/checkout`     | slow, rate-limited at 40/s       | the bottleneck                                 |
| `/flaky`        | fails ~10% of the time           | something for an error-rate threshold to catch |

`/search` is the interesting one: its latency scales with the search term, which
is what a search endpoint looks like before anyone measures it. A load test
that only exercises `/products` would never see it.

## What this suite does not do

- **No browser metrics.** k6 measures protocol-level timings. First Contentful
  Paint, Largest Contentful Paint and layout shift need `k6/browser` or
  Lighthouse — different tool, different question.
- **No distributed load.** A single machine saturates before most real systems
  do. Beyond that you need k6 Cloud or multiple runners, and the client becomes
  the bottleneck long before the server.
- **No production runs.** Every profile here targets localhost on purpose.

## Linting and reports

```bash
npm run lint          # ESLint 9, flat config
npm run lint:fix
npm run format        # Prettier, writes
npm run format:check  # Prettier, reports (this is what CI runs)
```

k6 scripts are the awkward case: they are JavaScript, but they do not run on
Node. They run on k6's own **goja** runtime, which supplies `__VU`, `__ITER` and
`open()` as globals and resolves `k6/http` from inside the binary rather than
from `node_modules`. Linting them with Node globals produces a page of false
`no-undef` errors, so the config separates the two environments:

| Files                 | Environment                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `tests/`, `lib/`      | the k6 runtime — k6 globals, no Node globals                        |
| `server/`, `scripts/` | ordinary Node — the local target app and the wrapper that starts it |

`no-undef` is the rule that earns its keep. **k6 has no `setTimeout` and no
`fetch`**; writing either is a runtime error inside a load test, which is the
worst place to find out — the failure arrives as a wall of identical iteration
errors rather than one clear message.

### Reports

`handleSummary` in `lib/` writes the run summary, and the thresholds are the
report that matters: a threshold breach is a non-zero exit code, so the load
test is a pass/fail gate rather than a graph somebody has to interpret. See
**Why thresholds are the whole point** above.

One trap documented there is worth repeating here: `p(99)` is **not** in k6's
default `summaryTrendStats`, so asking for it in a report without adding it to
the config prints `0ms` — a number that looks like an excellent result.

### Pre-push hook

```bash
npm install    # wires the hook up via npm's `prepare` lifecycle script
```

`.husky/pre-push` runs the same checks CI runs, before the push leaves the
machine. If any of them exits non-zero, **the push is aborted and nothing
reaches the remote**:

```
  push blocked — ESLint found problems
  fix:     npm run lint:fix
  bypass:  git push --no-verify
```

Three deliberate choices in it:

**It does not run the suite.** Lint, formatting and types are fast, offline and
deterministic — the whole hook finishes in about four seconds. The tests need a
browser and/or somebody else's demo API, so a hook that ran them would add a
minute to every push and would block whenever that server is asleep. Those
belong in CI, where a retry is free.

**It never fixes anything.** The hook calls the reporting variants, never
`--fix` or `--write`. A hook that rewrites files during `git push` pushes a
version you never reviewed and leaves the corrected files uncommitted in your
working tree. Being told what to run is better than being silently corrected.

**It is a pre-push hook, not pre-commit.** Commits are cheap and often
intermediate; blocking each one trains you to reach for `--no-verify` until the
hook is decoration. One check before the branch leaves the machine catches
exactly what CI would catch, without getting in the way of committing
work-in-progress.

`git push --no-verify` skips it entirely and lets CI be the judge — a legitimate
choice for a branch that is not finished.

### Where this runs in CI

Linting and formatting are their **own job**, not steps inside the test job.
They need no browser, no network and no secrets, and they finish in seconds, so
as a separate job they run concurrently with the suite: a formatting failure
does not wait behind a long test run, and a real test failure is not hidden
behind a formatting failure. Both verdicts arrive on their own.

CI runs the `--check` variants, never the formatter itself. A pipeline reports
on the branch it was asked to verify; it does not rewrite it.
