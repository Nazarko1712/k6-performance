/**
 * Target application for the load tests.
 *
 * Load testing somebody else's public API is abuse of their resources, so this
 * suite ships its own target. Zero dependencies — plain `node:http` — so the
 * whole repository runs with `node server/app.js` and nothing installed.
 *
 * The handlers are deliberately NOT uniformly fast. Each one models a shape
 * that shows up in real systems, so the thresholds in the tests have something
 * meaningful to measure:
 *
 *   /health          constant, trivial          — baseline
 *   /products        fast, cached-like          — the happy path
 *   /products/:id    small variable cost        — realistic jitter
 *   /search          cost grows with the query  — the N+1 shape
 *   /checkout        slow, stateful, rate-limited — the bottleneck
 *   /flaky           fails ~10% of the time     — error-rate thresholds
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '127.0.0.1';

const PRODUCTS = Array.from({ length: 200 }, (_, i) => ({
    id: String(i + 1),
    name: `Product ${i + 1}`,
    price: Math.round((5 + (i % 50) * 1.37) * 100) / 100,
    in_stock: i % 7 !== 0,
}));

/** Crude in-memory rate limiter, per second, to give /checkout a ceiling. */
const checkoutWindow = { second: 0, count: 0 };
const CHECKOUT_LIMIT = Number(process.env.CHECKOUT_LIMIT ?? 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
    });
    res.end(payload);
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (path === '/health') {
        return json(res, 200, { status: 'ok' });
    }

    if (path === '/products' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1);
        const perPage = 20;
        const start = (page - 1) * perPage;
        // A few ms of work so the baseline is not artificially zero.
        await sleep(2 + Math.random() * 4);
        return json(res, 200, {
            page,
            per_page: perPage,
            total: PRODUCTS.length,
            data: PRODUCTS.slice(start, start + perPage),
        });
    }

    const productMatch = path.match(/^\/products\/(\w+)$/);
    if (productMatch && req.method === 'GET') {
        const product = PRODUCTS.find((p) => p.id === productMatch[1]);
        await sleep(3 + Math.random() * 10);
        if (!product) return json(res, 404, { message: 'not found' });
        return json(res, 200, product);
    }

    if (path === '/search' && req.method === 'GET') {
        const query = (url.searchParams.get('q') ?? '').toLowerCase();
        // Cost deliberately grows with the term length: the shape of an
        // unindexed LIKE scan, which is what a search endpoint usually is
        // before anyone measures it.
        await sleep(5 + query.length * 3);
        const matches = PRODUCTS.filter((p) => p.name.toLowerCase().includes(query));
        return json(res, 200, { query, total: matches.length, data: matches.slice(0, 20) });
    }

    if (path === '/checkout' && req.method === 'POST') {
        const now = Math.floor(Date.now() / 1000);
        if (checkoutWindow.second !== now) {
            checkoutWindow.second = now;
            checkoutWindow.count = 0;
        }
        checkoutWindow.count += 1;

        if (checkoutWindow.count > CHECKOUT_LIMIT) {
            return json(res, 429, { message: 'rate limit exceeded' }, { 'Retry-After': '1' });
        }

        await sleep(40 + Math.random() * 60);
        return json(res, 201, { orderId: `ord-${now}-${checkoutWindow.count}` });
    }

    if (path === '/flaky') {
        await sleep(5);
        // ~10% failure rate, so an error-rate threshold has something to catch.
        if (Math.random() < 0.1) {
            return json(res, 503, { message: 'temporarily unavailable' });
        }
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { message: 'no such route' });
});

server.listen(PORT, HOST, () => {
    process.stdout.write(`target app listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
