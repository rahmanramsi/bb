export const REVOKED_SOCKET_CLOSE_CODE = 1008;
export const REVOKED_SOCKET_CLOSE_REASON = "Unauthorized";
const DEFAULT_REVALIDATE_INTERVAL_MS = 60_000;

interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

export interface AuthenticatedSocketRegistry {
  track(socket: ClosableSocket, isActive: () => Promise<boolean>): void;
  untrack(socket: ClosableSocket): void;
  isRevoked(socket: ClosableSocket): boolean;
  revalidate(): Promise<void>;
  dispose(): void;
}

export function createAuthenticatedSocketRegistry(
  options: { intervalMs?: number } = {},
): AuthenticatedSocketRegistry {
  const sockets = new Map<ClosableSocket, () => Promise<boolean>>();
  const revoked = new WeakSet<ClosableSocket>();
  let sweep: Promise<void> | null = null;
  let sweepAgain = false;

  async function checkSocket(
    socket: ClosableSocket,
    isActive: () => Promise<boolean>,
  ): Promise<void> {
    let active = false;
    try {
      active = await isActive();
    } catch {
      active = false;
    }
    if (active || sockets.get(socket) !== isActive) return;
    sockets.delete(socket);
    revoked.add(socket);
    socket.close(REVOKED_SOCKET_CLOSE_CODE, REVOKED_SOCKET_CLOSE_REASON);
  }

  async function runSweeps(): Promise<void> {
    do {
      sweepAgain = false;
      await Promise.all(
        [...sockets].map(([socket, isActive]) => checkSocket(socket, isActive)),
      );
    } while (sweepAgain);
  }

  function revalidate(): Promise<void> {
    if (sweep !== null) {
      sweepAgain = true;
      return sweep;
    }
    sweep = runSweeps().finally(() => {
      sweep = null;
    });
    return sweep;
  }

  const timer = setInterval(() => {
    void revalidate();
  }, options.intervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS);
  timer.unref();

  return {
    track(socket, isActive) {
      sockets.set(socket, isActive);
    },
    untrack(socket) {
      sockets.delete(socket);
    },
    isRevoked(socket) {
      return revoked.has(socket);
    },
    revalidate,
    dispose() {
      clearInterval(timer);
      sockets.clear();
    },
  };
}
