// Presentation-only view of an order's state.
//
// `orders.status` is coarse — every in-flight order is 'processing', whether it
// was submitted a second ago or has been sitting under manual review at the
// supplier for an hour. Suppliers report that distinction separately, and the
// sync cron stores their raw label in `supplier_status`.
//
// Nothing here is business logic. `status` remains the single source of truth
// for filters, stats and crons; this module only decides what a human sees.

export type OrderDisplayStatus =
    | 'pending'
    | 'processing'
    | 'verifying'
    | 'completed'
    | 'failed'
    | 'refunded'

/**
 * Lowercase a supplier status and flatten `_`/`-` to spaces so "on_hold",
 * "on-hold" and "On Hold" all compare equal.
 *
 * NetPulse is genuinely inconsistent here: its API returns "on_hold" while its
 * own dashboard renders "On Hold — Verifying". Matching literal strings meant
 * the underscore form missed and 12 live orders sat unrecognised. Compare on
 * words, not punctuation.
 *
 * Lives in this module rather than the supplier service so that client bundles
 * importing it never pull the supplier API client in with it.
 */
export function normaliseSupplierStatus(status: string | null | undefined): string {
    return (status || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

// Raw supplier labels that mean "placed, but held for review". Kept broad
// because each supplier words it differently and they are free to change the
// wording without telling us — an unlisted label just falls back to
// 'processing', which is the pre-existing behaviour. Compared post-normalisation,
// so only the word form is listed, never the punctuation variants.
export const VERIFYING_LABELS = [
    'verifying',
    'on hold',
    'onhold',
    'awaiting verification',
    'pending verification',
    'under review',
    // Dakazina's wording. WAITING is one of the five statuses their dashboard
    // fires webhooks on, and it means the order is placed but held before they
    // push it out — the same state the labels above describe.
    'waiting',
] as const

const VERIFYING_LABEL_SET = new Set<string>(VERIFYING_LABELS)

// What an admin writes when they park an order under review by hand. One of the
// labels above, so a manual hold and a supplier-reported one are indistinguishable
// downstream — every reader already understands this value.
export const ADMIN_VERIFYING_LABEL = 'verifying'

/** Whether a raw supplier label means "held for review". */
export function isVerifyingLabel(status: string | null | undefined): boolean {
    return VERIFYING_LABEL_SET.has(normaliseSupplierStatus(status))
}

/**
 * Resolve what an order should be labelled as in the UI.
 *
 * Precedence matters: a refunded order stores status='failed' with
 * payment_status='refunded' (the status CHECK cannot hold 'refunded'), so that
 * derivation has to win over everything else. Verification state is only ever
 * consulted while the order is genuinely still in flight — a stale
 * supplier_status left on a completed order must never re-open it visually.
 */
export function getOrderDisplayStatus(order: {
    status?: string | null
    payment_status?: string | null
    supplier_status?: string | null
}): OrderDisplayStatus {
    if (order?.payment_status === 'refunded') return 'refunded'

    const status = (order?.status || 'pending') as OrderDisplayStatus

    if (status === 'processing') {
        if (isVerifyingLabel(order?.supplier_status)) return 'verifying'
    }

    return status
}

const LABELS: Record<OrderDisplayStatus, string> = {
    pending: 'Pending',
    processing: 'Processing',
    verifying: 'On Hold — Verifying',
    completed: 'Completed',
    failed: 'Failed',
    refunded: 'Refunded',
}

export function getOrderStatusLabel(status: OrderDisplayStatus | string): string {
    return LABELS[status as OrderDisplayStatus]
        ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown')
}

// Amber for verifying: it reads as "needs attention / not done" without the
// alarm of the red failed state, and matches how the supplier's own dashboard
// presents it.
const BADGE_CLASSES: Record<OrderDisplayStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    verifying: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    refunded: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
}

export function getOrderStatusBadgeClass(status: OrderDisplayStatus | string): string {
    return BADGE_CLASSES[status as OrderDisplayStatus] ?? BADGE_CLASSES.pending
}
