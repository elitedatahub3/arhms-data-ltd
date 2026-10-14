/**
 * Why a supplier's fulfillOrder() did not succeed — the one fact the fallback
 * router (lib/supplier-router.ts) needs before it may send an order elsewhere.
 *
 * 'refused'  the order definitely did NOT enter the supplier: we never sent the
 *            request (circuit open, no API key, size not on their price list), or
 *            they answered with an explicit rejection (no balance, out of stock,
 *            invalid number, 429 before creating anything). Safe to try another.
 *
 * 'unknown'  we cannot tell — a timeout, a dropped connection, a 5xx, a body we
 *            could not parse. The supplier may have accepted it and be delivering
 *            right now, so trying another supplier risks sending the bundle twice
 *            and paying twice. The order stays with this supplier.
 *
 * A failure that carries no failureKind is treated as 'unknown'. Tagging is opt-in
 * per return path, so a path nobody classified can never cause a double delivery.
 */
export type SupplierFailureKind = 'refused' | 'unknown'

export function isDefiniteRefusal(result: { success: boolean; failureKind?: SupplierFailureKind }): boolean {
    return !result.success && result.failureKind === 'refused'
}
