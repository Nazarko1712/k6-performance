import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

/**
 * Load profile — expected traffic, ramped rather than switched on.
 *
 * `stages` ramp virtual users up, hold, and ramp down. The ramp matters: going
 * from 0 to 50 VUs instantly measures cold-start and connection-pool warm-up,
 * not steady-state behaviour, and produces a p99 that describes a moment nobody
 * will experience.
 *
 * The hold is where the number you actually report comes from.
 */

const searchLatency = new Trend('search_latency', true);
const checkoutLatency = new Trend('checkout_latency', true);
const rateLimited = new Counter('rate_limited_responses');

export const options = {
    stages: [
        { duration: '10s', target: 20 }, // ramp up
        { duration: '20s', target: 20 }, // hold — the measurement window
        { duration: '5s', target: 0 }, // ramp down
    ],

    thresholds: {
        http_req_failed: ['rate<0.02'],

        /**
         * Percentiles, never averages. An average of 120ms can hide a p99 of
         * four seconds, and the p99 is a real user waiting four seconds.
         *
         * Separate thresholds per endpoint because a catalogue read and a
         * checkout have genuinely different budgets — one global number either
         * lets the slow path off or fails the fast one.
         */
        http_req_duration: ['p(50)<150', 'p(95)<400', 'p(99)<800'],
        search_latency: ['p(95)<300'],
        checkout_latency: ['p(95)<500'],
        checks: ['rate>0.98'],

        // Tagged sub-threshold: the catalogue is cached-like and should stay
        // fast even while checkout is saturating.
        'http_req_duration{endpoint:products}': ['p(95)<200'],
    },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';

const SEARCH_TERMS = ['pro', 'product 1', 'product 12', 'duct', 'x'];

export default function () {
    group('browse the catalogue', () => {
        const page = Math.ceil(Math.random() * 10);
        const res = http.get(`${BASE}/products?page=${page}`, {
            // Tags are what make per-endpoint thresholds and per-endpoint
            // breakdowns possible; without them every request is one bucket.
            tags: { endpoint: 'products' },
        });

        check(res, {
            'catalogue 200': (r) => r.status === 200,
            'catalogue has data': (r) => r.json('data').length > 0,
        });
    });

    group('search', () => {
        const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
        const res = http.get(`${BASE}/search?q=${encodeURIComponent(term)}`, {
            tags: { endpoint: 'search' },
        });

        searchLatency.add(res.timings.duration);
        check(res, { 'search 200': (r) => r.status === 200 });
    });

    group('checkout', () => {
        const res = http.post(
            `${BASE}/checkout`,
            JSON.stringify({ items: [{ id: '1', qty: 1 }] }),
            {
                headers: { 'Content-Type': 'application/json' },
                tags: { endpoint: 'checkout' },
                // 429 is a correct answer from a rate limiter, not a failure.
                responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 429),
            },
        );

        checkoutLatency.add(res.timings.duration);

        if (res.status === 429) {
            rateLimited.add(1);
        } else {
            check(res, {
                'checkout 201': (r) => r.status === 201,
                'checkout returns an order id': (r) => Boolean(r.json('orderId')),
            });
        }
    });

    // Think time: real users pause. Without it the test measures how fast the
    // server can be hammered, which is a stress profile, not a load profile.
    sleep(Math.random() * 1 + 0.5);
}
