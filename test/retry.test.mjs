import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withRetry } from "../dist/client.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Shaped like the errors @linear/sdk throws for a rate limit. */
function rateLimited({ retryAfter = 0.01 } = {}) {
  return Object.assign(new Error("Rate limit exceeded"), {
    type: "Ratelimited",
    status: 400,
    retryAfter,
    errors: [{ message: "Rate limit exceeded" }],
  });
}

test("retries a rate-limited call and returns the eventual success", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw rateLimited();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("gives up after the attempt cap, with exit code 5", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw rateLimited();
    }),
    (error) => {
      assert.equal(error.code, 5, "rate-limit exhaustion must exit 5");
      assert.match(error.message, /rate limit/i);
      assert.match(error.hint, /5,000 requests per hour/);
      return true;
    },
  );
  assert.equal(calls, 5, "should stop at MAX_ATTEMPTS rather than loop forever");
});

test("does not retry a non-retryable error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error("Bad input"), {
        type: "InvalidInput",
        status: 400,
        errors: [{ message: "Field is invalid" }],
      });
    }),
    (error) => {
      assert.equal(error.code, 6);
      assert.match(error.message, /Field is invalid/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("an auth failure becomes a credential error, not a generic API error", async () => {
  await assert.rejects(
    withRetry(async () => {
      throw Object.assign(new Error("Authentication required"), {
        type: "AuthenticationError",
        status: 401,
      });
    }),
    (error) => {
      assert.equal(error.code, 3);
      assert.match(error.hint, /linear-agent auth/);
      return true;
    },
  );
});

test("a backoff keeps the process alive until the retry completes", () => {
  // Regression: an unref'd backoff timer let Node exit mid-wait, so the retry
  // never ran and the command exited 0 having done nothing. Reproduces only in
  // a bare process, where the timer is the sole thing holding the event loop —
  // under the test runner other handles would mask it.
  const script = `
    import { withRetry } from ${JSON.stringify(join(ROOT, "dist", "client.js"))};
    let calls = 0;
    const value = await withRetry(async () => {
      calls++;
      if (calls < 2) {
        throw Object.assign(new Error("Rate limit exceeded"), {
          type: "Ratelimited", status: 400, retryAfter: 0.01,
        });
      }
      return "retried-and-succeeded";
    });
    console.log(value, calls);
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 0, `exited ${result.status}: ${result.stderr}`);
  assert.match(
    result.stdout,
    /retried-and-succeeded 2/,
    "the process exited before the retry ran",
  );
});
