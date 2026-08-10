// Supabase/PostgREST silently caps every query at 1000 rows. Several stat tables
// (season_pitches, season_plate_appearances, season_game_fielders, ...) are already
// past that cap, so any un-paginated read drops rows with no error. Every fetch of
// an unbounded stat table must go through this helper.
//
// Usage:
//   const { data, error } = await fetchAllRows(() => supabase.from('season_pitches').select('*'))
//
// The builder is called once per page so each page gets a fresh query. Rows are
// paged on a unique, stable column (default `id`) — paging on non-unique columns
// like created_at can duplicate or skip rows when values tie across a page break.
// Callers that need a specific row order should sort the returned array themselves.
const PAGE_SIZE = 1000

export async function fetchAllRows(buildQuery, { orderColumn = 'id' } = {}) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery()
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return { data: rows, error: null }
}
