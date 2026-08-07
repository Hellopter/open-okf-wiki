/**
 * Bounded concurrency task pool + timeout helpers for session orchestrator.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label?: string;

  constructor(timeoutMs: number, label?: string) {
    super(label ? `Task "${label}" timed out after ${timeoutMs}ms` : `Timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.label = label;
  }
}

/**
 * Race a promise against a wall-clock timeout.
 * Does not cancel the underlying work unless `onTimeout` aborts it.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
  label?: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout?.();
      } catch {
        // ignore onTimeout errors
      }
      reject(new TimeoutError(ms, label));
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface TaskPoolOptions {
  concurrency: number;
}

export interface TaskRunOptions {
  timeoutMs?: number;
  label?: string;
}

export interface TaskPoolStats {
  concurrency: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  disposed: boolean;
}

export interface TaskPool {
  run<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: TaskRunOptions): Promise<T>;
  stats(): TaskPoolStats;
  dispose(): void;
}

interface QueueItem {
  start: () => void;
  reject: (err: Error) => void;
}

/**
 * Simple FIFO concurrency pool. Each task receives an AbortSignal that fires
 * on timeout (when timeoutMs is set) or when the pool is disposed.
 */
export function createTaskPool(options: TaskPoolOptions): TaskPool {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  let active = 0;
  let completed = 0;
  let failed = 0;
  let disposed = false;
  const queue: QueueItem[] = [];
  const controllers = new Set<AbortController>();
  const settleRejectors = new Set<(err: Error) => void>();

  function pump(): void {
    while (!disposed && active < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (item) item.start();
    }
  }

  function run<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: TaskRunOptions): Promise<T> {
    if (disposed) {
      return Promise.reject(new Error("Task pool has been disposed"));
    }

    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        if (disposed) {
          reject(new Error("Task pool has been disposed"));
          return;
        }
        active += 1;
        const controller = new AbortController();
        controllers.add(controller);

        let settled = false;
        const settleReject = (err: Error): void => {
          if (settled) return;
          settled = true;
          settleRejectors.delete(settleReject);
          controllers.delete(controller);
          active = Math.max(0, active - 1);
          failed += 1;
          reject(err);
          pump();
        };
        settleRejectors.add(settleReject);

        const finishOk = (value: T): void => {
          if (settled) return;
          settled = true;
          settleRejectors.delete(settleReject);
          controllers.delete(controller);
          active = Math.max(0, active - 1);
          completed += 1;
          resolve(value);
          pump();
        };

        const finishErr = (err: unknown): void => {
          if (settled) return;
          settled = true;
          settleRejectors.delete(settleReject);
          controllers.delete(controller);
          active = Math.max(0, active - 1);
          failed += 1;
          reject(err);
          pump();
        };

        // If already aborted (e.g. dispose raced), fail fast.
        if (controller.signal.aborted) {
          finishErr(new Error("Task pool has been disposed"));
          return;
        }

        const work = Promise.resolve().then(() => {
          if (controller.signal.aborted) {
            throw new Error("Task pool has been disposed");
          }
          return fn(controller.signal);
        });

        const timed =
          opts?.timeoutMs !== undefined
            ? withTimeout(
                work,
                opts.timeoutMs,
                () => {
                  try {
                    controller.abort();
                  } catch {
                    // ignore
                  }
                },
                opts.label,
              )
            : work;

        timed.then(finishOk, finishErr);
      };

      if (active < concurrency) {
        start();
      } else {
        queue.push({
          start,
          reject: (err) => {
            failed += 1;
            reject(err);
          },
        });
      }
    });
  }

  function stats(): TaskPoolStats {
    return {
      concurrency,
      active,
      queued: queue.length,
      completed,
      failed,
      disposed,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Reject queued work that never started.
    while (queue.length > 0) {
      const item = queue.shift();
      item?.reject(new Error("Task pool has been disposed"));
    }

    // Abort active controllers and force-reject their outer promises so dispose
    // never leaves the event loop waiting on cooperative abort handlers.
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        // ignore
      }
    }
    controllers.clear();

    for (const settleReject of [...settleRejectors]) {
      settleReject(new Error("Task pool has been disposed"));
    }
    settleRejectors.clear();
  }

  return { run, stats, dispose };
}
