/**
 * Start the target app, wait until it is actually serving, run a k6 script,
 * then shut the app down — whatever the outcome.
 *
 * Zero dependencies, so the repository still installs nothing.
 *
 * The readiness poll matters: starting k6 immediately after spawning the server
 * produces connection-refused errors on the first iterations, which show up as
 * a failure rate that has nothing to do with the system under test.
 *
 * Usage:  node scripts/with-server.mjs tests/smoke.js [extra k6 args...]
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const [script, ...k6Args] = process.argv.slice(2);

if (!script) {
    process.stderr.write('usage: node scripts/with-server.mjs <k6-script> [k6 args]\n');
    process.exit(2);
}

const PORT = process.env.PORT ?? '3100';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server/app.js'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT },
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
});

async function waitForServer(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) return;
        } catch {
            // Not up yet.
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`target app did not become ready within ${timeoutMs}ms\n${serverOutput}`);
}

function shutdown(code) {
    server.kill('SIGTERM');
    // SIGTERM is handled by the app; SIGKILL is the backstop so a wedged
    // process cannot leave the port bound for the next run.
    setTimeout(() => server.kill('SIGKILL'), 2000).unref();
    process.exit(code);
}

try {
    await waitForServer();
    process.stdout.write(`target app ready at ${BASE_URL}\n\n`);

    const k6 = spawn('k6', ['run', script, ...k6Args], {
        stdio: 'inherit',
        env: { ...process.env, BASE_URL },
    });

    k6.on('error', (error) => {
        process.stderr.write(
            `\nfailed to launch k6: ${error.message}\n` +
                'Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/\n',
        );
        shutdown(127);
    });

    // k6 exits non-zero when a threshold fails, which is exactly the signal CI
    // needs — so it is passed straight through rather than swallowed.
    k6.on('exit', (code) => shutdown(code ?? 1));
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    shutdown(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(130));
}
