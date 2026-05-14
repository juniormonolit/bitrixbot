/** PostgREST обычно ходит GET-ом; огромный `.in(id, [...])` раздувает query string до HeadersOverflowError (~8KB+). */
export const SUPABASE_IN_FILTER_MAX_IDS = 25;

export function chunkIdsForInFilter(ids: readonly string[]): string[][] {
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += SUPABASE_IN_FILTER_MAX_IDS) {
    out.push(ids.slice(i, i + SUPABASE_IN_FILTER_MAX_IDS));
  }
  return out;
}
