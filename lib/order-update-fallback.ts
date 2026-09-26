// Degrade an order's post-fulfillment write instead of losing it.
//
// The supplier has already been called and paid by the time these updates run.
// If the write fails outright the order stays 'pending', so the refulfill cron
// picks it up and BUYS THE BUNDLE AGAIN — the customer gets two, we pay twice,
// and nothing in the admin UI shows why.
//
// The realistic cause is a DB that is behind the code: a supplier's migration
// adds `<supplier>_reference` and widens the orders_fulfillment_method_check
// constraint, and until it is applied every write naming those fails. That has
// bitten this codebase before — commit 99d74f7 shipped a fallback for the
// constraint half, but only in the dispatcher, and only for the constraint.
// A missing COLUMN raises a different error (42703 / PostgREST PGRST204) which
// that branch never caught, and shop-order-processor had no fallback at all.
//
// So: shed the optional columns one at a time and keep retrying, because the
// status transition is the part that must survive. Losing the supplier
// reference costs us reconciliation for one order, which an admin can repair.
// Losing the transition costs a duplicate bundle.

type UpdateResult = {
    ok: boolean
    /** Optional columns that had to be dropped for the write to land. */
    dropped: string[]
    error?: string
}

/**
 * Apply `payload`, shedding `optionalKeys` in order until the write succeeds.
 *
 * `optionalKeys` should be ordered most-suspect first — normally the supplier
 * reference column (added by the newest migration), then `fulfillment_method`
 * (guarded by a CHECK constraint that the same migration widens). Anything not
 * listed is treated as load-bearing and never dropped.
 */
export async function updateOrderWithColumnFallback(
    db: any,
    table: string,
    match: { column: string; value: string },
    payload: Record<string, any>,
    optionalKeys: string[],
    logPrefix: string
): Promise<UpdateResult> {
    const dropped: string[] = []
    let lastError = ''

    // Attempt 0 is the full payload; each later attempt sheds one more optional key.
    for (let shed = 0; shed <= optionalKeys.length; shed++) {
        const attempt = { ...payload }
        for (const key of optionalKeys.slice(0, shed)) delete attempt[key]

        const { error } = await db.from(table).update(attempt).eq(match.column, match.value)

        if (!error) {
            if (shed > 0) {
                console.warn(
                    `${logPrefix} ${table} ${match.value}: wrote WITHOUT [${dropped.join(', ')}] — ` +
                    `the DB is missing those columns or the CHECK constraint that allows this value. ` +
                    `Run the supplier's migration. Last DB error: ${lastError}`
                )
            }
            return { ok: true, dropped }
        }

        lastError = error.message || String(error)

        // Nothing left to shed — the failure is not about the optional columns.
        if (shed === optionalKeys.length) break

        dropped.push(optionalKeys[shed])
        console.error(
            `${logPrefix} ${table} ${match.value}: update failed (${lastError}). ` +
            `Retrying without '${optionalKeys[shed]}'.`
        )
    }

    // Every variant failed, including the bare status transition. The order is
    // still 'pending' while the supplier has been paid, so say so loudly.
    console.error(
        `${logPrefix} CRITICAL: could not record fulfillment for ${table} ${match.value}. ` +
        `The supplier was already called. This order may be re-fulfilled and charged twice. ` +
        `Last DB error: ${lastError}`
    )
    return { ok: false, dropped, error: lastError }
}
