import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Whether anything is listening on a loopback port.
 *
 * Binding is the exact question the callers mean. The earlier `lsof -iTCP:<port>`
 * check asked a broader one — it matches *any* socket on the port, including the
 * test's own client connections lingering in TIME_WAIT — which made it fail
 * occasionally on Linux for a port nothing was listening on. It also passed
 * silently on a host without `lsof`, since no output reads the same as no
 * listener.
 *
 * Node sets SO_REUSEADDR, so a TIME_WAIT socket does not block the bind: this
 * returns false only when a real listener holds the port.
 */
function bindSucceeds(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Poll until the port is free, up to `timeoutMs`. A process that has just been
 * signalled releases its sockets when the kernel reaps it, which is not
 * instantaneous — a single sample after a fixed sleep is a race, and was the
 * one this suite kept losing.
 */
export async function waitForPortFree(port, { host = "127.0.0.1", timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await bindSucceeds(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}
