// N-at-a-time concurrency limiter for the bulk client paths. A shared cursor
// hands each of `n` workers the next index; results land in input order. A
// worker that throws rejects the whole pool (the `stopOnError` path); the
// collecting paths catch inside the worker and return a tagged result instead.

export const pool = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // oxlint-disable-next-line no-await-in-loop -- each worker drains the shared cursor serially by design.
      results[index] = await worker(items[index] as T, index);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, run));
  return results;
};
