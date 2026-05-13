/**
 * PostgREST (Supabase) often caps rows per request (e.g. 50 or 1000).
 * Never treat "chunk smaller than requested page" as end-of-data unless chunk is empty
 * after advancing `from` by the actual chunk length.
 */
export async function fetchAllByRange<T>(options: {
  pageSize: number;
  fetchPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}): Promise<T[]> {
  const { pageSize, fetchPage } = options;
  const out: T[] = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    if (chunk.length === 0) break;
    out.push(...chunk);
    from += chunk.length;
  }
  return out;
}
