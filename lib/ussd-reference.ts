/**
 * Resolving a paid USSD order back to the session that created it.
 *
 * This used to mirror every order into Redis, keyed by reference, so the webhook
 * could map a payment back to a session. That mirror is gone, and the reason is
 * worth recording: Upstash hit its request ceiling ("max requests limit exceeded,
 * Limit: 500000"), every write started returning HTTP 400, and because the confirm
 * step refuses to charge when it cannot record the order, USSD stopped selling
 * entirely. A quota on a cache took down a payment path.
 *
 * It turns out we never needed it. Paystack echoes `metadata` back on
 * charge.success, and the charge already carries session_id and order_type — so the
 * webhook is told which session it is settling by the gateway itself. The session
 * row in Postgres, which has to exist for fulfilment anyway, is the only store
 * involved now.
 *
 * The cron sweep is the one caller without metadata: it starts from a reference in
 * hubtel_payment_logs. For that, the confirm step writes the reference into the
 * session payload, and resolveByReference() looks it up there.
 *
 * There is deliberately no wallet_payments row anywhere in this flow. That table
 * requires user_id and wallet_id NOT NULL, and a USSD caller has neither.
 */

export interface ResolvedUssdOrder {
    sessionId: string
    orderType: 'data' | 'rc'
}

function normaliseOrderType(value: unknown): 'data' | 'rc' {
    return String(value ?? '') === 'data' ? 'data' : 'rc'
}

/**
 * Confirms the session row a webhook was pointed at actually exists.
 *
 * Both fulfillers open by selecting the session and give up when it is missing, so
 * checking here turns "silently fulfilled nothing" into a caller that knows it must
 * not report success.
 *
 * Prefers the order type recorded on the live row over the one Paystack echoed: the
 * row is ours and current, the metadata is a copy taken at charge time.
 */
export async function ensureUssdSession(
    supabaseAdmin: any,
    params: { sessionId?: string | null; orderType?: unknown; reference?: string | null }
): Promise<ResolvedUssdOrder | null> {
    const sessionId = params.sessionId ? String(params.sessionId) : null

    if (sessionId) {
        const { data } = await supabaseAdmin
            .from('hubtel_sessions')
            .select('session_id, data')
            .eq('session_id', sessionId)
            .maybeSingle()

        if (data?.session_id) {
            return {
                sessionId,
                orderType: normaliseOrderType((data as any)?.data?.orderType ?? params.orderType),
            }
        }
        console.warn('[UssdRef] Session named in metadata is gone:', sessionId)
    }

    // No usable session id — fall back to the reference recorded on the row.
    if (params.reference) {
        return resolveByReference(supabaseAdmin, params.reference)
    }

    console.error('[UssdRef] Cannot resolve a USSD order: no session id and no reference')
    return null
}

/**
 * Finds the session by the Paystack reference stored in its payload.
 *
 * The entry point for the reconciliation sweep, which only ever knows a reference.
 * Backed by the expression index in 20260826000001_ussd_session_reference_idx.sql —
 * without it this is a full scan of a table every USSD keypress writes to.
 */
export async function resolveByReference(
    supabaseAdmin: any,
    reference: string
): Promise<ResolvedUssdOrder | null> {
    const { data, error } = await supabaseAdmin
        .from('hubtel_sessions')
        .select('session_id, data')
        .eq('data->>paystackReference', reference)
        .maybeSingle()

    if (error) {
        console.error('[UssdRef] Reference lookup failed:', error.message)
        return null
    }
    if (!data?.session_id) {
        console.error('[UssdRef] No session carries reference:', reference)
        return null
    }

    return {
        sessionId: String(data.session_id),
        orderType: normaliseOrderType((data as any)?.data?.orderType),
    }
}

/**
 * Builds the reference a USSD charge is booked under.
 *
 * The `USSD-` prefix is the routing contract: the Paystack webhook, the
 * reconciliation cron and flowFromReference() all switch on it. It must not collide
 * with the existing prefixes (SHOP-, RC-, DATA-, ...) — note that `USSD-RC-` does
 * NOT match `startsWith('RC-')`, which is what keeps voucher routing intact.
 */
export function buildUssdReference(orderType: 'data' | 'rc'): string {
    const kind = orderType === 'data' ? 'DATA' : 'RC'
    const stamp = Date.now().toString(36).toUpperCase()
    // crypto.randomUUID is available on the edge runtime; the slice keeps the
    // reference comfortably inside Paystack's length limit.
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
    return `USSD-${kind}-${stamp}-${nonce}`
}
