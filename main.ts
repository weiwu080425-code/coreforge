// The forge's entry point: the trial lifecycle around app.ts's server.
//
// The harness starts this process beside the contest environment and
// talks to it over HTTP, so the process is a server, not a script:
//
//   1. Read the environment's origin from MAKEFUN_ENV_URL. Without it
//      there is nothing to serve, so exit 1 at once.
//   2. Bind an ephemeral port (listen on 0) — never a fixed one, and
//      never 8080, which belongs to the environment.
//   3. Tell the environment where to find the forge:
//      POST {"port": N} to $MAKEFUN_ENV_URL/register. The first
//      registration wins; a 409 means one already did, which is not
//      this process's problem. Transient failures retry with a
//      growing wait, because the environment may still be starting.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers
//      {"done": true}. The answer comes back immediately either way,
//      so poll with the same growing wait and never exit early: the
//      environment writes its export only after the forge is done.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; nowhere to register\n');
  process.exit(1);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff between retries of one step: 200ms doubling to a 2s cap. */
function backoff(attempt: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(attempt, 6));
}

/** One HTTP call to the environment with a hard 30s ceiling. */
async function envCall(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${envUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envCall('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await wait(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envCall('/done');
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet is just another "not done".
    }
    await wait(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] the server did not bind a TCP port\n');
  process.exit(1);
}
process.stdout.write(`[forge] listening on port ${address.port}\n`);
await register(address.port);
process.stdout.write('[forge] registered; serving until the environment is done\n');
await waitUntilDone();
server.close();
process.stdout.write('[forge] done\n');
process.exit(0);
