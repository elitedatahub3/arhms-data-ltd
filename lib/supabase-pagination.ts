/**
 * PostgREST caps every unbounded select at the project's `db.max_rows` (1000 for us) and
 * does it silently — the query succeeds and simply returns the first page. Anything that
 * needs EVERY matching row (broadcast recipient lists, exports, counts shown in the UI)
 * has to walk the pages itself, or it quietly works off the first 1000 rows.
 */
const PAGE_SIZE = 1000

// Safety stop so a query that keeps returning full pages can't spin forever.
const MAX_PAGES = 100

/**
 * Run `buildQuery` once per page and concatenate the results.
 *
 * `buildQuery` must return a FRESH Supabase query builder on every call — a builder can
 * only be awaited once. Give the query a unique tiebreaker in its `order(...)` (e.g. `id`)
 * so rows can't shift between pages and get duplicated or skipped.
 */
export async function fetchAllRows<T = any>(
    buildQuery: () => any
): Promise<{ data: T[]; error: any }> {
    const rows: T[] = []

    for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE_SIZE
        const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1)

        if (error) return { data: rows, error }

        const batch = (data || []) as T[]
        rows.push(...batch)

        if (batch.length < PAGE_SIZE) break
    }

    return { data: rows, error: null }
}
