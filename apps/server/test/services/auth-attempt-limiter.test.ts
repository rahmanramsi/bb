import { describe, expect, it } from "vitest";
import { createAuthAttemptLimiter } from "../../src/services/auth-attempt-limiter.js";

describe("auth attempt limiter", () => {
  it("blocks an account after repeated failures until its window ends and resets on success", () => {
    let now = 0;
    const limiter = createAuthAttemptLimiter(
      {
        account: { maxAttempts: 2, windowMs: 1000 },
        global: { maxAttempts: 100, windowMs: 1000 },
      },
      () => now,
    );
    expect(limiter.acquire("a")).toBeNull();
    limiter.recordFailure("a");
    expect(limiter.acquire("a")).toBeNull();
    limiter.recordFailure("a");
    now = 400;
    expect(limiter.acquire("a")).toBe(600);
    expect(limiter.acquire("b")).toBeNull();
    now = 1000;
    expect(limiter.acquire("a")).toBeNull();
    limiter.recordFailure("a");
    limiter.reset("a");
    limiter.recordFailure("a");
    expect(limiter.acquire("a")).toBeNull();
  });

  it("caps total attempts across accounts per window", () => {
    let now = 0;
    const limiter = createAuthAttemptLimiter(
      {
        account: { maxAttempts: 100, windowMs: 1000 },
        global: { maxAttempts: 3, windowMs: 1000 },
      },
      () => now,
    );
    expect(limiter.acquire("a")).toBeNull();
    expect(limiter.acquire("b")).toBeNull();
    expect(limiter.acquire("c")).toBeNull();
    now = 250;
    expect(limiter.acquire("d")).toBe(750);
    now = 1000;
    expect(limiter.acquire("d")).toBeNull();
  });
});
