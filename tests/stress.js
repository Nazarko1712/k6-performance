import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

/**
 * Stress profile — push past the expected load to find where it breaks.
 *
 * The distinction from `load.js` is the purpose, not the numbers:
 *
 *   load   — "does it meet its budget at expected traffic?"  pass/fail
 *   stress — "where does it stop meeting it, and how does it  exploratory
 *             fail when it does?"
 *
 * A stress test that passes every threshold has not found the limit and
 * therefore has not done its job. The thresholds here are consequently about
 * DEGRADING WELL rather than staying fast: a service that slows down under
 * overload is behaving; one that starts returning 500s or stops responding is
 * not.
 *
 * Uses `constant-arrival-rate` rather than VUs: it fixes the REQUEST rate
 * instead of the number of users, which is what actually matters when the
 * server slows down. With plain VUs, a slowing server automatically receives
 * fewer requests — the load reduces itself and the limit is never reached.
 */

const errors = new Rate('error_rate');
const checkoutLatency = new Trend('checkout_latency', true);

export const options = {
    /**
     * `p(99)` is NOT in k6's default summary statistics — the defaults are
     * avg, min, med, max, p(90) and p(95). A threshold on p(99) still works,
     * but reading it back in `handleSummary` returns undefined, which is how
     * this report first printed "p99 latency: 0ms" on a run that clearly had
     * latency.
     */
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],

    scenarios: {
        ramping_arrival: {
            executor: 'ramping-arrival-rate',
            startRate: 20,
            timeUnit: '1s',
            preAllocatedVUs: 50,
            maxVUs: 300,
            stages: [
                { duration: '10s', target: 50 },
                { duration: '10s', target: 150 },
                { duration: '10s', target: 300 },
            ],
        },
    },

    thresholds: {
        /**
         * Deliberately loose. The point is to observe the failure mode, not to
         * assert that overload never happens — a threshold of `rate<0.01` here
         * would just fail by design and tell nobody anything.
         *
         * What these DO assert: that the service degrades rather than collapses.
         */
        error_rate: ['rate<0.5'],
        http_req_duration: ['p(99)<5000'],
        http_req_failed: ['rate<0.6'],
    },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';

export default function () {
    const res = http.post(`${BASE}/checkout`, JSON.stringify({ items: [{ id: '1', qty: 1 }] }), {
        headers: { 'Content-Type': 'application/json' },
        responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 429),
    });

    checkoutLatency.add(res.timings.duration);

    // 429 is the system defending itself — correct behaviour under overload,
    // counted separately from a genuine error.
    const degradedProperly = res.status === 201 || res.status === 429;
    errors.add(!degradedProperly);

    check(res, {
        'responded at all': (r) => r.status !== 0,
        'degraded properly (201 or 429)': () => degradedProperly,
        'no server error': (r) => r.status < 500,
    });
}

export function handleSummary(data) {
    const duration = data.metrics.http_req_duration?.values ?? {};
    const requests = data.metrics.http_reqs?.values?.count ?? 0;
    const failed = data.metrics.http_req_failed?.values?.rate ?? 0;
    const serverErrors = data.metrics.error_rate?.values?.rate ?? 0;

    const p95 = duration['p(95)'] ?? 0;
    const p99 = duration['p(99)'] ?? 0;

    /**
     * A stress run's real output is a narrative, not a pass mark.
     *
     * "Degraded" and "collapsed" are different outcomes and only one of them is
     * acceptable: a service that slows down or starts answering 429 is
     * defending itself; one that returns 500s or stops responding is not.
     */
    const verdict =
        serverErrors > 0.5
            ? 'COLLAPSED — too many requests were neither served nor rate-limited'
            : p99 > 5000
              ? 'COLLAPSED — latency past the 5s budget'
              : 'DEGRADED WITHIN BUDGET — slowed and/or rate-limited, but served';

    const report =
        '\nStress summary\n' +
        `  requests            : ${requests}\n` +
        `  median latency      : ${(duration.med ?? 0).toFixed(0)}ms\n` +
        `  p95 latency         : ${p95.toFixed(0)}ms\n` +
        `  p99 latency         : ${p99.toFixed(0)}ms\n` +
        `  max latency         : ${(duration.max ?? 0).toFixed(0)}ms\n` +
        `  unexpected failures : ${(failed * 100).toFixed(2)}%\n` +
        `  not served at all   : ${(serverErrors * 100).toFixed(2)}%\n` +
        `  verdict             : ${verdict}\n`;

    return { stdout: report };
}
