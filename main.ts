// main.ts — the entrypoint: bind an ephemeral port, register it with the
// trial environment, and stay up until the environment says the suite is
// done. Nothing here touches the wall clock for a response; the forge's
// timestamps come from the logical clock in store.ts.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set; there is no environment to register with.');
  process.exit(1);
}

const store = new Store();
const server = createApp(store);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

async function register(port: number): Promise<void> {
  let delay = 250;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await postJson('/register', { port })) return;
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
  console.error('could not register with the environment; continuing to serve anyway');
}

async function waitDone(): Promise<void> {
  let delay = 500;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // The environment may not be up yet; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  void register(port).then(() => waitDone()).then(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
});
