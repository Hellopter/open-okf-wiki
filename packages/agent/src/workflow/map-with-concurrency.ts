/**
 * Bounded-parallel map preserving item order.
 *
 * On signal.aborted, stop scheduling new work; in-flight work continues.
 * results[i] is assigned only when fn(items[i]) runs — aborted slots stay
 * empty (undefined at runtime). No Pi imports.
 */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
