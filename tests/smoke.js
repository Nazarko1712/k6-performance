import http from 'k6/http';
import { check, group } from 'k6';
import { Rate } from 'k6/metrics';

/**
 * Smoke test — minimal load, maximum assertions.
 *
 * The first thing to run and the first thing to run in CI. One virtual user,
 * a handful of iterations: it answers "is the system up and behaving" before
 * anyone spends ten minutes on a load profile. A failing smoke makes every
 * subsequent performance number meaningless.
 *
 * Note what it asserts: correctness, not speed. A load test that only measures
 * latency will happily report excellent p95 for a service returning 500s.
 */

const errorRate = new Rate('business_errors');

export const options = {
    vus: 1,
    iterations: 10,

    /**
     * Thresholds are what make a k6 run a TEST rather than a report. Without
     * them the script prints numbers and always exits 0 — so CI goes green no
     * matter how bad the result is.
     */
    thresholds: {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<500'],
        business_errors: ['rate<0.01'],
        checks: ['rate>0.99'],
    },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';

export default function () {
    group('health', () => {
        const res = http.get(`${BASE}/health`);
        const ok = check(res, {
            'health returns 200': (r) => r.status === 200,
            'health reports ok': (r) => r.json('status') === 'ok',
        });
        errorRate.add(!ok);
    });

    group('catalogue', () => {
        const res = http.get(`${BASE}/products`);
        const ok = check(res, {
            'products returns 200': (r) => r.status === 200,
            'products returns a page': (r) => Array.isArray(r.json('data')),
            'page is not empty': (r) => r.json('data').length > 0,
            // Shape assertions belong here too: a load test against a broken
            // contract measures the speed of the wrong thing.
            'product has a price': (r) => typeof r.json('data.0.price') === 'number',
        });
        errorRate.add(!ok);
    });

    group('product detail', () => {
        const res = http.get(`${BASE}/products/1`);
        const ok = check(res, {
            'detail returns 200': (r) => r.status === 200,
            'detail matches the requested id': (r) => r.json('id') === '1',
        });
        errorRate.add(!ok);
    });

    group('missing product', () => {
        /**
         * `responseCallback` is essential here, and its absence is a trap.
         *
         * k6 derives `http_req_failed` from `expected_response`, which defaults
         * to 2xx/3xx. A deliberate negative test therefore counts as a FAILED
         * REQUEST: this one 404 out of four calls pushed `http_req_failed` to
         * 25% and broke the threshold while all 90 checks were green.
         *
         * Declaring 404 as expected for this call separates "the request went
         * wrong" from "the server correctly said no".
         */
        const res = http.get(`${BASE}/products/999999`, {
            responseCallback: http.expectedStatuses(404),
        });
        const ok = check(res, {
            'missing product returns 404': (r) => r.status === 404,
        });
        errorRate.add(!ok);
    });
}
