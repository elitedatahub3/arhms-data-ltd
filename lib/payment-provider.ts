/**
 * The set of payment gateways ARHMS can collect through, and how an
 * `admin_settings.active_payment_provider_*` value resolves to one.
 *
 * This exists because provider selection used to be a copy-pasted ternary
 *
 *     adminDefault === 'paystack' ? 'paystack' : adminDefault === 'hubtel' ? 'hubtel' : 'moolre'
 *
 * repeated in seven API routes and six client components. Adding a gateway meant
 * editing thirteen places, and any one that was missed silently fell through to
 * Moolre — i.e. the admin toggle would appear to do nothing for that flow.
 * Everything that needs to know the active provider now goes through here.
 *
 * Safe to import from client components: no server-only imports, no env reads.
 */

/**
 * 'paystack' and 'paystack_momo' are the same merchant account reached two
 * different ways: the former redirects the browser to a hosted checkout page, the
 * latter drives the Charge API and pushes an approval prompt to the handset. They
 * are separate entries rather than one entry with a flag because almost everything
 * that branches on a provider — the fee keys, whether the UI collects a phone
 * number, which reconciliation sweep owns the row — needs a different answer for
 * each, and a row has to be able to name which one collected it.
 */
export const PAYMENT_PROVIDERS = ['moolre', 'hubtel', 'paystack', 'paystack_momo', 'payswitch'] as const

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]

/** The independently-configurable areas of the app. */
export type PaymentScope = 'web' | 'shop' | 'ussd'

/** admin_settings key backing each scope. */
export const SCOPE_SETTING_KEY: Record<PaymentScope, string> = {
    web: 'active_payment_provider_web',
    shop: 'active_payment_provider_shop',
    ussd: 'active_payment_provider_ussd',
}

/**
 * Providers each scope actually supports.
 *
 * USSD is the narrowest scope and deliberately so. A dial-in caller has no browser,
 * so a hosted redirect cannot complete — 'paystack' is excluded because the flow has
 * no branch for it. Moolre and PaySwitch have no USSD branch at
 * all. That leaves the Charge API and the pre-Paystack Hubtel AddToCart path, which
 * is the rollback.
 */
export const SCOPE_PROVIDERS: Record<PaymentScope, readonly PaymentProvider[]> = {
    web: ['moolre', 'hubtel', 'paystack', 'paystack_momo', 'payswitch'],
    shop: ['moolre', 'hubtel', 'paystack', 'paystack_momo', 'payswitch'],
    ussd: ['paystack_momo', 'hubtel'],
}

export const DEFAULT_PAYMENT_PROVIDER: PaymentProvider = 'moolre'

/**
 * The provider a scope falls back to when its setting is unreadable.
 *
 * Only USSD differs from the global default, and it has to. Moolre has no USSD
 * branch, so falling back to it would strand a dial-in caller mid-purchase. This
 * switch does not decide WHETHER to take money, only which gateway takes it, so a
 * missing row must route to the live gateway rather than to a retired one.
 */
export const SCOPE_FALLBACK_PROVIDER: Record<PaymentScope, PaymentProvider> = {
    web: DEFAULT_PAYMENT_PROVIDER,
    shop: DEFAULT_PAYMENT_PROVIDER,
    ussd: 'paystack_momo',
}

/** Human label for admin UI / customer-facing copy. */
export const PROVIDER_LABEL: Record<PaymentProvider, string> = {
    moolre: 'Moolre',
    hubtel: 'Hubtel',
    paystack: 'Paystack',
    paystack_momo: 'Paystack MoMo',
    payswitch: 'PaySwitch',
}

export function isPaymentProvider(value: unknown): value is PaymentProvider {
    return typeof value === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Resolves a raw admin_settings value to a known provider.
 *
 * Anything unrecognised (unset, typo, a provider removed from the build) falls
 * back rather than throwing — a bad setting must not take payments down.
 */
export function resolveProvider(
    raw: unknown,
    fallback: PaymentProvider = DEFAULT_PAYMENT_PROVIDER
): PaymentProvider {
    // admin_settings.value is a text column that has been written both ways: the
    // seed migration inserts JSON-quoted ('"moolre"') while the admin UI POSTs a
    // bare string ('moolre'). Strip the quotes so a freshly-seeded row resolves to
    // the provider it names instead of silently falling back.
    const value = String(raw ?? '').trim().replace(/^"+|"+$/g, '').trim().toLowerCase()
    return isPaymentProvider(value) ? value : fallback
}

/**
 * Resolves for a specific scope, additionally rejecting providers that scope
 * does not implement.
 *
 * The fallback defaults per scope rather than globally, so a caller cannot forget
 * that USSD must not fall back to a gateway it has no branch for. Pass one
 * explicitly only to override that.
 */
export function resolveProviderForScope(
    raw: unknown,
    scope: PaymentScope,
    fallback: PaymentProvider = SCOPE_FALLBACK_PROVIDER[scope]
): PaymentProvider {
    const provider = resolveProvider(raw, fallback)
    return SCOPE_PROVIDERS[scope].includes(provider) ? provider : fallback
}

/**
 * Gateways that take payment on a hosted page the browser is redirected to.
 *
 * Everything not listed here debits by pushing an approval prompt to the handset,
 * which is what the UI keys off to decide whether to collect a phone number and
 * network. Kept as a list rather than an inequality so that adding a hosted gateway
 * is one edit here instead of inverting a condition in seven components — and so
 * that 'paystack_momo' being a prompt provider is a stated fact rather than an
 * accident of not being spelled 'paystack'.
 */
export const HOSTED_REDIRECT_PROVIDERS: readonly PaymentProvider[] = ['paystack']

export function isMomoPromptProvider(provider: PaymentProvider): boolean {
    return !HOSTED_REDIRECT_PROVIDERS.includes(provider)
}
