interface AttemptWindow {
  count: number;
  resetAtMs: number;
}

interface WindowPolicy {
  maxAttempts: number;
  windowMs: number;
}

export interface AuthAttemptLimiterPolicy {
  account: WindowPolicy;
  global: WindowPolicy;
}

export const DEFAULT_AUTH_ATTEMPT_LIMITS: AuthAttemptLimiterPolicy = {
  account: { maxAttempts: 10, windowMs: 15 * 60_000 },
  global: { maxAttempts: 60, windowMs: 60_000 },
};

const MAX_TRACKED_ACCOUNTS = 10_000;

export interface AuthAttemptLimiter {
  acquire(accountKey: string | null): number | null;
  recordFailure(accountKey: string): void;
  reset(accountKey: string): void;
}

export function createAuthAttemptLimiter(
  policy: AuthAttemptLimiterPolicy = DEFAULT_AUTH_ATTEMPT_LIMITS,
  now: () => number = Date.now,
): AuthAttemptLimiter {
  const failures = new Map<string, AttemptWindow>();
  let global: AttemptWindow = { count: 0, resetAtMs: 0 };

  function activeWindow(
    window: AttemptWindow | undefined,
    nowMs: number,
  ): AttemptWindow | null {
    return window !== undefined && window.resetAtMs > nowMs ? window : null;
  }

  function prune(nowMs: number): void {
    if (failures.size < MAX_TRACKED_ACCOUNTS) return;
    for (const [key, window] of failures) {
      if (window.resetAtMs <= nowMs) failures.delete(key);
    }
    while (failures.size >= MAX_TRACKED_ACCOUNTS) {
      const oldest = failures.keys().next();
      if (oldest.done) break;
      failures.delete(oldest.value);
    }
  }

  return {
    acquire(accountKey) {
      const nowMs = now();
      if (accountKey !== null) {
        const account = activeWindow(failures.get(accountKey), nowMs);
        if (account !== null && account.count >= policy.account.maxAttempts) {
          return account.resetAtMs - nowMs;
        }
      }
      if (global.resetAtMs <= nowMs) {
        global = { count: 0, resetAtMs: nowMs + policy.global.windowMs };
      }
      if (global.count >= policy.global.maxAttempts) {
        return global.resetAtMs - nowMs;
      }
      global.count += 1;
      return null;
    },
    recordFailure(accountKey) {
      const nowMs = now();
      const account = activeWindow(failures.get(accountKey), nowMs);
      if (account !== null) {
        account.count += 1;
        return;
      }
      prune(nowMs);
      failures.set(accountKey, {
        count: 1,
        resetAtMs: nowMs + policy.account.windowMs,
      });
    },
    reset(accountKey) {
      failures.delete(accountKey);
    },
  };
}
