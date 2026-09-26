/**
 * The one place that knows what to do with a payment for a retired product.
 *
 * Classifieds listing boosts were paid for through the same gateways as everything else,
 * as wallet_payments rows whose reference starts with `BOOST-`, and every payment
 * handler routed them to lib/classifieds-payments. That product, and the module, are gone.
 *
 * Simply deleting those branches would not be safe. Each handler ends in a catch-all that
 * treats an unrecognised reference as a WALLET TOP-UP, so a BOOST- payment confirmed after
 * the removal would have fallen through and quietly credited the payer's wallet — an
 * accident, not a policy, and not a refund anyone decided to give. Each handler therefore
 * keeps an explicit branch that lands here instead.
 *
 * What happens to such a payment is deliberately nothing but noise: nothing is credited,
 * nothing is activated, and the log line says a refund is owed. That is the right shape
 * because the situation should not arise — boost initiation was removed in the same change,
 * no boost was running, and the three unsettled boost payments on record were abandoned
 * checkouts weeks old. It can only arise from a payment started just before the removal
 * and confirmed just after it, and that customer needs a person to look at it.
 */

export const RETIRED_BOOST_PREFIX = 'BOOST-'

export const RETIRED_BOOST_MESSAGE =
    'This payment was for a listing boost, a service that has been discontinued. Contact support for a refund.'

export function isRetiredBoostReference(reference: string | null | undefined): boolean {
    return !!reference && reference.startsWith(RETIRED_BOOST_PREFIX)
}

/**
 * Records that a payment for the retired product was CONFIRMED by the provider.
 * Call only after the provider has said the money arrived; an unpaid or expired boost
 * checkout is not an event and needs no log line.
 */
export function reportRetiredBoostPayment(source: string, reference: string | null | undefined): void {
    console.error(
        `[RetiredBoost] ${source}: payment ${reference} was confirmed after listing boosts were removed. ` +
        'Nothing was credited or activated. The payer is owed a manual refund.'
    )
}
