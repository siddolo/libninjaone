export interface Page<T, Cursor> {
  items: readonly T[];
  /* Omit or return null to stop. Cursor semantics are endpoint-specific. */
  nextCursor?: Cursor | null;
}

/* Iterate pages without assuming that all NinjaOne endpoints paginate alike. */
export async function* paginate<T, Cursor extends string | number>(
  loadPage: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
  options: { initialCursor?: Cursor; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<T> {
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  let cursor = options.initialCursor;
  const seen = new Set<Cursor>();
  if (cursor !== undefined) seen.add(cursor);
  for (let page = 0; page < maxPages; page++) {
    options.signal?.throwIfAborted();
    const result = await loadPage(cursor);
    options.signal?.throwIfAborted();
    for (const item of result.items) {
      options.signal?.throwIfAborted();
      yield item;
    }
    if (result.nextCursor === undefined || result.nextCursor === null) return;
    if (seen.has(result.nextCursor)) {
      throw new Error('Pagination returned a repeated cursor');
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Pagination exceeded maxPages');
}
