/// <reference types="node" />
// Stale-while-revalidate for the panel RPCs. Opening AFC should show the last result at once and
// let the slow rebuild (CLI calls, daemon calls, file scans) run off the request path.

export interface StaleCacheOptions {
  /** A value younger than this is returned without starting a rebuild. */
  freshMs: number;
  now?: () => number;
  /** Called when a background rebuild fails; the old value stays. */
  onError?: (error: unknown) => void;
}

export interface StaleCache<T> {
  /**
   * Fresh value: return it. Stale value: return it now and rebuild in the background.
   * No value yet, `force`, or invalidated since the value was built: wait for a rebuild that started
   * after that point. Concurrent callers share one rebuild.
   */
  get(load: () => Promise<T>, options?: { force?: boolean }): Promise<T>;
  /** Start a rebuild without waiting for it (no-op while one is running). */
  warm(load: () => Promise<T>): void;
  /** Something the value shows has changed: the next `get` waits for a rebuild started from now on. */
  invalidate(): void;
  /** When the current value was built, or null before the first build. */
  builtAt(): number | null;
}

interface Built<T> { data: T; at: number; gen: number }
interface Running<T> { promise: Promise<T>; gen: number }

export function createStaleCache<T>({ freshMs, now = () => Date.now(), onError }: StaleCacheOptions): StaleCache<T> {
  // A rebuild is stamped with the generation it started in; invalidate() moves to a new one, so a
  // rebuild that was already running when something changed cannot answer a read made after it.
  let gen = 0;
  let needGen = 0;
  let value: Built<T> | null = null;
  let running: Running<T> | null = null;

  const start = (load: () => Promise<T>): Promise<T> => {
    const startedGen = gen;
    // new Promise runs load() now and turns a synchronous throw into a rejection.
    const promise: Promise<T> = new Promise<T>((resolve) => resolve(load()))
      .then((data) => {
        if (!value || startedGen >= value.gen) value = { data, at: now(), gen: startedGen };
        return data;
      })
      .finally(() => {
        if (running?.promise === promise) running = null;
      });
    running = { promise, gen: startedGen };
    return promise;
  };

  const rebuild = (load: () => Promise<T>, minGen: number): Promise<T> =>
    running && running.gen >= minGen ? running.promise : start(load);

  const background = (load: () => Promise<T>) => {
    rebuild(load, 0).catch((error: unknown) => onError?.(error));
  };

  const invalidate = () => {
    gen += 1;
    needGen = gen;
  };

  return {
    async get(load, options = {}) {
      if (options.force) invalidate();
      if (!value || value.gen < needGen) return rebuild(load, needGen);
      if (now() - value.at >= freshMs) background(load);
      return value.data;
    },
    warm: background,
    invalidate,
    builtAt: () => value?.at ?? null,
  };
}
