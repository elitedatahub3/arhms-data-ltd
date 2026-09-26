import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { isUssdEnabled, USSD_ENABLED_KEY, USSD_OFFLINE_MESSAGE } from '@/lib/ussd-availability';
import {
    checkMtnRegistrationStrict,
    isMtnPackageNetwork,
    USSD_NOT_REGISTERED_MESSAGE,
    USSD_REGISTRATION_UNVERIFIABLE_MESSAGE,
} from '@/lib/mtn-registration-gate';
import { detectNetwork } from '@/lib/phone-validation';
import {
    chargeMobileMoney,
    resolvePayerProvider,
    submitOtp,
    toAsciiSafe,
} from '@/lib/paystack-momo-service';
import { resolveProviderForScope, SCOPE_SETTING_KEY, type PaymentProvider } from '@/lib/payment-provider';
import { buildUssdReference } from '@/lib/ussd-reference';
import { logInitiate } from '@/lib/hubtel-payment-log';

/**
 * Hubtel Programmable Services — Service Interaction URL
 *
 * Hubtel POSTs a Push Request here on every USSD keypress (Type: Initiation |
 * Response | Timeout). We drive a server-side state machine and reply with a
 * Programmable Services response.
 *
 * Every session opens by asking for a SHORT CODE — the 4-character identifier a
 * shop buys once and keeps for life. It resolves to a shop, and the rest of the
 * session sells that shop's catalogue at that shop's prices. One reserved house
 * short code (admin_settings.ussd_house_code) keeps ARHMS' own platform-direct
 * sales working exactly as before.
 *
 * PAYMENT: we collect it ourselves, via Paystack Mobile Money. On confirm we debit
 * the caller's wallet with the Charge API and release the session; Paystack pushes
 * the approval to the handset and the outcome arrives at /api/webhooks/paystack,
 * which fulfils. Hubtel is a menu channel here and nothing more.
 *
 * This used to be Hubtel's job — confirm returned `Type: "AddToCart"` and Hubtel
 * charged the customer inside the session, reporting to /api/hubtel/fulfill. That
 * path is still wired and one click away (Admin -> Settings -> USSD Payments ->
 * Hubtel) so a bad day does not need a deploy to undo.
 *
 * EDGE RUNTIME. Nothing imported here may pull in undici — that rules out
 * lib/hubtel-payment-service.ts and everything re-exported from it. Paystack is
 * called with plain fetch and does not want a static-IP proxy.
 *
 * Docs: https://developers.hubtel.com — Programmable Services API
 *       https://paystack.com/docs/api/charge/
 */

// Never cache/prerender.
export const dynamic = 'force-dynamic';
export const runtime = 'edge';

/** Bundles shown per USSD screen. A screen is ~160 chars, so five is the safe ceiling. */
const PAGE_SIZE = 5;
/** Wrong short codes tolerated before we hang up, so a wrong-number dialler can't loop forever. */
const MAX_CODE_ATTEMPTS = 3;

// Lazy-load Supabase client to avoid blocking on module import
let supabaseAdmin: any = null;
function getSupabaseAdmin() {
    if (!supabaseAdmin) {
        supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return supabaseAdmin;
}

/**
 * Keep-warm ping. A Vercel Cron GET keeps this exact function instance hot so a
 * real USSD initiation never pays a cold-start (which can exceed Hubtel's
 * timeout). Returns immediately with no DB work.
 */
export async function GET() {
    return NextResponse.json({ ok: true, warm: true, ts: Date.now() });
}

const WELCOME_MESSAGE = 'Enter short code to continue:';

/**
 * ussd_enabled, cached per instance for a minute.
 *
 * This is the one route in the codebase where a millisecond can cost a sale —
 * Hubtel hangs up at 10s and an initiation deliberately answers before touching
 * the database. Reading the switch on every keypress would put a round trip back
 * into that path for a value that changes about once a year, so an instance holds
 * it briefly instead. The keep-warm cron keeps instances alive, so in practice
 * this is read once a minute, not once a session; the price of the cache is that
 * a flip in /admin/settings takes up to a minute to reach every instance.
 */
const USSD_FLAG_TTL_MS = 60_000;

/** admin_settings key naming which gateway collects for a USSD sale. */
const USSD_PROVIDER_KEY = SCOPE_SETTING_KEY.ussd;

/** Shared with every other surface — the same switch the admin fulfillment page writes. */
const MTN_GATE_KEY = 'mtn_registration_gate_enabled';

interface UssdFlags {
    enabled: boolean;
    /** 'paystack_momo' (we collect) | 'hubtel' (AddToCart, the pre-Paystack path). */
    paymentProvider: PaymentProvider;
    /** Refuse MTN data orders to numbers that are not registered yet. */
    mtnGateEnabled: boolean;
}

let ussdFlagCache: { flags: UssdFlags; at: number } | null = null;

/**
 * Every USSD switch in one round trip.
 *
 * They are read together because this is the one route where a millisecond costs a
 * sale, and sequential lookups would put extra round trips into Hubtel's window
 * for values that change about once a year. The MTN gate rides along for the same
 * reason — it is needed mid-session, on a keypress, where a second lookup would cost
 * more than the check it guards.
 */
async function getUssdFlags(): Promise<UssdFlags> {
    if (ussdFlagCache && Date.now() - ussdFlagCache.at < USSD_FLAG_TTL_MS) {
        return ussdFlagCache.flags;
    }
    try {
        const { data } = await withTimeout(
            getSupabaseAdmin()
                .from('admin_settings')
                .select('key, value')
                .in('key', [USSD_ENABLED_KEY, USSD_PROVIDER_KEY, MTN_GATE_KEY]),
            3000,
            'ussd flags fetch timeout'
        );

        const raw: Record<string, unknown> = {};
        for (const row of (data || [])) {
            raw[row.key] = row.value;
        }

        const flags: UssdFlags = {
            // The RAW value goes to isUssdEnabled, deliberately. It answers true only
            // for the exact string 'true', and normalising first would widen that: a
            // JSONB boolean true arrives here as JS true, which String() would turn
            // into 'true' and open a service the strict check keeps shut. This is the
            // one switch in the codebase whose whole job is failing closed, and it is
            // now the only gate in front of live money.
            enabled: isUssdEnabled({ [USSD_ENABLED_KEY]: raw[USSD_ENABLED_KEY] as any }),
            // Resolved through the shared registry rather than parsed here, so this
            // route and /api/shop/ussd/activate can never disagree about which
            // gateway is collecting. lib/payment-provider.ts is pure — no server
            // imports, no env reads — so it is safe on the edge runtime this route
            // runs on. The 'ussd' scope's fallback is paystack_momo, not the global
            // Moolre default, which has no USSD branch at all.
            paymentProvider: resolveProviderForScope(raw[USSD_PROVIDER_KEY], 'ussd'),
            // Read exactly as loadGateSettings() reads it, so this route and the web
            // routes can never disagree about whether the gate is on. Deliberately NOT
            // isUssdEnabled(): that helper's extra strictness belongs to the switch that
            // stops the service, and applying it here would be borrowing a rule from an
            // unrelated decision.
            mtnGateEnabled: String(raw[MTN_GATE_KEY]) === 'true',
        };
        ussdFlagCache = { flags, at: Date.now() };
        return flags;
    } catch (err) {
        console.error('[Hubtel Interact] USSD flags read failed:', err);
        // Prefer a stale answer over flapping; with no answer at all, stay shut.
        // Every step past this point needs the same database, so a session we
        // cannot verify is one we could not have fulfilled either.
        //
        // mtnGateEnabled defaults to false here, unlike `enabled` above. Deploying must
        // not turn a check ON that the admin has not switched on, and this branch only
        // runs when we could not read the setting at all — the same reasoning as
        // loadGateSettings(), which also treats an unreadable setting as off.
        return ussdFlagCache?.flags
            ?? { enabled: false, paymentProvider: 'paystack_momo', mtnGateEnabled: false };
    }
}

export async function POST(req: Request) {
    const requestStartTime = Date.now();
    try {
        const body = await req.json();
        const { Mobile, SessionId, Type: RequestType, Message, Operator } = body;
        const requestType = String(RequestType || '').toLowerCase();

        // Master switch, checked ahead of the fast path so a deactivated service
        // never even draws a welcome screen. Fulfilment (/api/hubtel/fulfill) is
        // deliberately left alone: no new charge can start once this returns, and
        // anything Hubtel has already taken still has to be delivered.
        const ussdFlags = await getUssdFlags();
        if (!ussdFlags.enabled) {
            return respond(SessionId, 'release', USSD_OFFLINE_MESSAGE);
        }

        // ULTRA-FAST PATH: Initiation — return hardcoded response, defer everything
        if (requestType === 'initiation' && SessionId) {
            const response = respond(SessionId, 'response', WELCOME_MESSAGE, {
                label: 'Short code',
            });

            // Defer Supabase init and session creation to background
            waitUntil((async () => {
                try {
                    const client = createClient(
                        process.env.NEXT_PUBLIC_SUPABASE_URL!,
                        process.env.SUPABASE_SERVICE_ROLE_KEY!
                    );
                    await client.from('hubtel_sessions').upsert({
                        session_id: SessionId,
                        mobile: Mobile || '',
                        current_step: 'enter_short_code',
                        data: { operator: (Operator || 'mtn').toLowerCase() },
                        updated_at: new Date().toISOString(),
                    });
                } catch (err) {
                    console.error('[Hubtel] Initiation session creation error:', err);
                }
            })());

            return response;
        }

        // For any other request type, we need the full client
        if (!SessionId || !Mobile) {
            return respond(SessionId, 'release', 'Invalid USSD request. Missing session data.');
        }

        // Timeout — user cancelled the session. Clean up and end.
        if (requestType === 'timeout') {
            await getSupabaseAdmin().from('hubtel_sessions').delete().eq('session_id', SessionId);
            return respond(SessionId, 'release', 'Session timed out. Thank you for using ARHMS.');
        }

        // 1. Fetch existing session for a continuation request
        // Use a 9-second timeout — aggressive but leaves 1s buffer before Hubtel's timeout
        const sessionFetchStart = Date.now();
        let session: any = null;
        let sessionError: any = null;
        try {
            const sessionFetchPromise = getSupabaseAdmin()
                .from('hubtel_sessions')
                .select('*')
                .eq('session_id', SessionId)
                .single();
            const result = await withTimeout(sessionFetchPromise, 9000, 'Session fetch timeout');
            session = result.data;
            sessionError = result.error;
        } catch (e: any) {
            sessionError = e;
        }
        const sessionFetchDuration = Date.now() - sessionFetchStart;

        if (sessionError && sessionError.code !== 'PGRST116') {
            console.error('[Hubtel Interact] Session fetch error (took', sessionFetchDuration, 'ms):', sessionError);
            return respond(SessionId, 'release', 'System error. Please try again.');
        }

        if (!session) {
            // Session missing (expired/cleaned) — restart from the menu.
            console.log('[Hubtel Interact] Session not found (fetch took', sessionFetchDuration, 'ms) for SessionId:', SessionId);
            return respond(SessionId, 'release', 'Session expired. Please dial again.');
        }

        if (sessionFetchDuration > 3000) {
            console.warn('[Hubtel Interact] Slow session fetch (', sessionFetchDuration, 'ms) for SessionId:', SessionId, 'Type:', requestType);
        }

        // 2. State machine
        let currentStep = session.current_step;
        const sessionData = session.data || {};
        let userInput = Message?.trim();

        // Global "0" = Back one step (or Exit at the first menu after the short code)
        if (requestType !== 'initiation' && userInput === '0') {
            const back = BACK_STEPS[currentStep];
            if (back === 'exit') {
                endSession(SessionId);
                return respond(SessionId, 'release', 'Thank you for using ARHMS. Goodbye.');
            }
            if (back) {
                currentStep = back;
                // Clearing the input makes the target step redraw its menu cleanly
                // instead of scolding the user for the "0" they pressed to get there.
                userInput = '';
            }
        }

        // Only an actual wrong keypress deserves the scold.
        const invalid = (what: string) => (userInput ? `Invalid ${what}.\n` : '');

        switch (currentStep) {
            // ── SHORT CODE ───────────────────────────────────────────────────────
            case 'enter_short_code': {
                const code = String(userInput || '').toUpperCase().replace(/\s+/g, '');

                if (!code) {
                    return respond(SessionId, 'response', WELCOME_MESSAGE, { label: 'Short code' });
                }

                // Both lookups fire together: this is the latency-critical keypress,
                // and running them in series would put two round trips inside
                // Hubtel's window for no reason.
                let houseCode: string | null = null;
                let shop: any = null;
                try {
                    const shopPromise = getSupabaseAdmin()
                        .from('shop_profiles')
                        .select('id, shop_name, owner_id')
                        .eq('ussd_code', code)
                        .eq('ussd_status', 'active')
                        .eq('approval_status', 'approved')
                        .eq('is_active', true)
                        .maybeSingle();

                    const [houseResult, shopResult] = await Promise.all([
                        getHouseCode(),
                        withTimeout(shopPromise, 8000, 'Shop lookup timeout'),
                    ]);
                    houseCode = houseResult;
                    shop = shopResult.data;
                } catch (e: any) {
                    console.error('[Hubtel Interact] Shop lookup failed:', e?.message);
                    return respond(SessionId, 'release', 'System busy. Please dial again.');
                }

                // The house short code is ARHMS selling direct: platform catalogue,
                // platform prices, no shop attribution. Unchanged from before.
                if (houseCode && code === houseCode) {
                    sessionData.mode = 'platform';
                    saveAsync(SessionId, 'choose_service', sessionData);
                    return respond(SessionId, 'response', renderServiceMenu('ARHMS'), {
                        label: 'Select service',
                    });
                }

                if (!shop) {
                    const attempts = (sessionData.codeAttempts || 0) + 1;
                    if (attempts >= MAX_CODE_ATTEMPTS) {
                        endSession(SessionId);
                        return respond(SessionId, 'release', 'Invalid short code. Please check with the shop and dial again.');
                    }
                    sessionData.codeAttempts = attempts;
                    saveAsync(SessionId, 'enter_short_code', sessionData);
                    return respond(
                        SessionId,
                        'response',
                        `Invalid short code.\nAttempt ${attempts} of ${MAX_CODE_ATTEMPTS}.\nEnter short code:`,
                        { label: 'Short code' }
                    );
                }

                sessionData.mode = 'shop';
                sessionData.shopId = shop.id;
                sessionData.shopName = shop.shop_name;
                sessionData.ownerId = shop.owner_id;
                sessionData.codeAttempts = 0;

                saveAsync(SessionId, 'choose_service', sessionData);
                return respond(SessionId, 'response', renderServiceMenu(shop.shop_name), {
                    label: 'Select service',
                });
            }

            // ── SERVICE ──────────────────────────────────────────────────────────
            case 'choose_service': {
                const shopLabel = sessionData.shopName || 'ARHMS';
                // Every re-render below has to persist the step it drew, otherwise a
                // back-navigation would leave the DB pointing at the step we left.
                const reprompt = (msg: string) => {
                    saveAsync(SessionId, 'choose_service', sessionData);
                    return respond(SessionId, 'response', msg, { label: 'Select service' });
                };

                if (userInput === '2') {
                    const checkers = await loadCheckers(sessionData);
                    if (!checkers.length) {
                        return reprompt(`Result checkers unavailable.\n${renderServiceMenu(shopLabel)}`);
                    }
                    sessionData.availableCheckers = checkers;
                    saveAsync(SessionId, 'select_checker_type', sessionData);
                    return respond(SessionId, 'response', renderCheckerMenu(checkers), {
                        label: 'Select Checker',
                    });
                }

                if (userInput === '1') {
                    // Platform mode has no data catalogue on USSD — only shops sell bundles.
                    if (sessionData.mode !== 'shop') {
                        return reprompt(`Data bundles unavailable.\n${renderServiceMenu(shopLabel)}`);
                    }

                    const bundles = await loadShopBundles(sessionData.shopId);
                    if (!bundles.length) {
                        return reprompt(`No bundles available.\n${renderServiceMenu(shopLabel)}`);
                    }

                    sessionData.allBundles = bundles;
                    const networks = uniqueNetworks(bundles);
                    sessionData.networks = networks;

                    saveAsync(SessionId, 'choose_network', sessionData);
                    return respond(SessionId, 'response', renderNetworkMenu(networks), {
                        label: 'Select network',
                    });
                }

                return reprompt(`${invalid('input')}${renderServiceMenu(shopLabel)}`);
            }

            // ── DATA: NETWORK ────────────────────────────────────────────────────
            case 'choose_network': {
                const networks: string[] = sessionData.networks || [];
                const idx = parseInt(userInput, 10) - 1;

                if (isNaN(idx) || idx < 0 || idx >= networks.length) {
                    saveAsync(SessionId, 'choose_network', sessionData);
                    return respond(SessionId, 'response', `${invalid('selection')}${renderNetworkMenu(networks)}`, {
                        label: 'Select network',
                    });
                }

                const network = networks[idx];
                sessionData.network = network;
                sessionData.bundles = (sessionData.allBundles || []).filter((b: any) => b.network === network);
                sessionData.bundlePage = 0;

                saveAsync(SessionId, 'select_bundle', sessionData);
                return respond(SessionId, 'response', renderBundleMenu(sessionData.bundles, 0), {
                    label: 'Select bundle',
                });
            }

            // ── DATA: BUNDLE (paginated) ─────────────────────────────────────────
            case 'select_bundle': {
                const bundles: any[] = sessionData.bundles || [];
                const page: number = sessionData.bundlePage || 0;
                const lastPage = Math.max(0, Math.ceil(bundles.length / PAGE_SIZE) - 1);

                if (userInput === '99') {
                    const nextPage = page < lastPage ? page + 1 : page;
                    sessionData.bundlePage = nextPage;
                    saveAsync(SessionId, 'select_bundle', sessionData);
                    return respond(SessionId, 'response', renderBundleMenu(bundles, nextPage), {
                        label: 'Select bundle',
                    });
                }

                if (userInput === '88') {
                    const prevPage = page > 0 ? page - 1 : 0;
                    sessionData.bundlePage = prevPage;
                    saveAsync(SessionId, 'select_bundle', sessionData);
                    return respond(SessionId, 'response', renderBundleMenu(bundles, prevPage), {
                        label: 'Select bundle',
                    });
                }

                // Numbering restarts at 1 on every page, so map it back through the offset.
                const withinPage = parseInt(userInput, 10) - 1;
                const idx = page * PAGE_SIZE + withinPage;

                if (isNaN(withinPage) || withinPage < 0 || withinPage >= PAGE_SIZE || idx >= bundles.length) {
                    saveAsync(SessionId, 'select_bundle', sessionData);
                    return respond(SessionId, 'response', `${invalid('selection')}${renderBundleMenu(bundles, page)}`, {
                        label: 'Select bundle',
                    });
                }

                const bundle = bundles[idx];
                sessionData.orderType = 'data';
                sessionData.selectedPackageId = bundle.id;
                sessionData.packageSize = bundle.size;
                sessionData.selectedPrice = bundle.price;
                sessionData.itemName = `${bundle.network} ${bundle.size}`;

                saveAsync(SessionId, 'enter_phone', sessionData);
                return respond(SessionId, 'response', 'Enter recipient number:\n(or send 1 for your own number)', {
                    label: 'Recipient number',
                    fieldType: 'phone',
                });
            }

            // ── RESULT CHECKER ───────────────────────────────────────────────────
            case 'select_checker_type': {
                const availableCheckers = sessionData.availableCheckers || [];
                const selectionIndex = parseInt(userInput, 10) - 1;

                if (isNaN(selectionIndex) || selectionIndex < 0 || selectionIndex >= availableCheckers.length) {
                    saveAsync(SessionId, 'select_checker_type', sessionData);
                    return respond(
                        SessionId,
                        'response',
                        invalid('selection') + renderCheckerMenu(availableCheckers),
                        { label: 'Select Checker' }
                    );
                }

                const selected = availableCheckers[selectionIndex];
                sessionData.orderType = 'rc';
                sessionData.selectedCheckerId = selected.id;
                sessionData.selectedCheckerName = selected.name;
                sessionData.selectedCheckerPrice = selected.price;
                sessionData.selectedPrice = selected.price;
                sessionData.itemName = selected.name;

                saveAsync(SessionId, 'enter_phone', sessionData);
                return respond(
                    SessionId,
                    'response',
                    'Enter recipient number:\n(or send 1 for your own number)',
                    { label: 'Recipient number', fieldType: 'phone' }
                );
            }

            // ── RECIPIENT ────────────────────────────────────────────────────────
            case 'enter_phone': {
                let recipientMobile: string;

                if (!userInput || userInput === '1') {
                    recipientMobile = normalizeGhanaPhone(Mobile) || Mobile;
                } else {
                    const normalized = normalizeGhanaPhone(userInput);
                    if (!normalized) {
                        saveAsync(SessionId, 'enter_phone', sessionData);
                        return respond(
                            SessionId,
                            'response',
                            'Invalid number.\nEnter recipient number:\n(or send 1 for your own number)',
                            { label: 'Recipient number', fieldType: 'phone' }
                        );
                    }
                    recipientMobile = normalized;
                }

                sessionData.recipientMobile = recipientMobile;

                // ── MTN REGISTRATION GATE ────────────────────────────────────────
                // Here, and not at 'confirm': this is the last step where no money is
                // in motion and both the bundle and the recipient are known. 'confirm'
                // already spends its budget on the Paystack charge.
                //
                // Unlike every web surface, this fails CLOSED — a USSD caller cannot be
                // warned, cannot be shown a held order, and cannot be reached once the
                // line drops. See checkMtnRegistrationStrict for the full reasoning.
                //
                // isMtnPackageNetwork, not === 'MTN', so 'Special MTN Mashup' and
                // 'EXPRESS MTN' stay exempt: they are fulfilled by hand and the
                // whitelist has no bearing on whether they can be delivered.
                if (sessionData.orderType === 'data' && isMtnPackageNetwork(sessionData.network)) {
                    const gate = await checkMtnRegistrationStrict(
                        getSupabaseAdmin(),
                        recipientMobile,
                        sessionData.network,
                        { enabled: ussdFlags.mtnGateEnabled }
                    );
                    if (gate.blocked) {
                        endSession(SessionId);
                        return respond(
                            SessionId,
                            'release',
                            gate.reason === 'unregistered'
                                ? USSD_NOT_REGISTERED_MESSAGE
                                : USSD_REGISTRATION_UNVERIFIABLE_MESSAGE
                        );
                    }
                }

                saveAsync(SessionId, 'confirm', sessionData);
                return respond(
                    SessionId,
                    'response',
                    `Confirm Order:\n${sessionData.itemName} x1\nCost: GHS ${formatGhs(sessionData.selectedPrice)}\nTo: ${recipientMobile}\n\n1. Confirm & Pay\n0. Cancel`,
                    { label: 'Confirm order' }
                );
            }

            // ── CONFIRM ──────────────────────────────────────────────────────────
            case 'confirm': {
                if (userInput !== '1') {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Order cancelled. Thank you for using ARHMS.');
                }

                const price = parseFloat(String(sessionData.selectedPrice || '0'));
                const orderType: 'data' | 'rc' = sessionData.orderType === 'data' ? 'data' : 'rc';

                sessionData.chargedAmount = price;
                // The candidate lists are only needed while browsing; dropping them
                // keeps the persisted JSON small on the write that blocks the response.
                delete sessionData.allBundles;
                delete sessionData.bundles;
                delete sessionData.availableCheckers;

                // ROLLBACK PATH: hand the cart to Hubtel and let it collect, exactly
                // as before Paystack. One admin setting, no deploy.
                if (ussdFlags.paymentProvider === 'hubtel') {
                    try {
                        await withTimeout(save(SessionId, 'awaiting_payment', sessionData), 8000, 'Confirm save timeout');
                    } catch (confirmError: any) {
                        console.error('[Hubtel Interact] Confirm save timeout/error:', confirmError?.message);
                        return respond(SessionId, 'release', 'Payment confirmation failed. Please try again.');
                    }
                    return respond(
                        SessionId,
                        'AddToCart',
                        'The request has been submitted. Please wait for a payment prompt soon.',
                        {
                            label: 'The request has been submitted. Please wait for a payment prompt soon.',
                            dataType: 'display',
                            item: { ItemName: sessionData.itemName, Qty: 1, Price: price },
                        }
                    );
                }

                // The PAYER is whoever is holding this handset — not the recipient
                // chosen in enter_phone, and not the network chosen in choose_network
                // (that one describes the bundle being bought, which is routinely a
                // different network from the one paying for it).
                const payerMsisdn = normalizeGhanaPhone(Mobile) || Mobile;
                const { provider, network: payerNetwork } = resolvePayerProvider(
                    sessionData.operator,
                    payerMsisdn,
                    detectNetwork
                );

                if (!provider) {
                    console.error('[Hubtel Interact] Could not resolve payer network for', payerMsisdn, 'operator:', sessionData.operator);
                    endSession(SessionId);
                    return respond(
                        SessionId,
                        'release',
                        'We could not identify your mobile money network. Please buy at arhmsgh.com.'
                    );
                }

                // A price that did not survive the session is not something to
                // improvise around: charging 0 succeeds at the gateway and delivers
                // nothing, and chargeMobileMoney would refuse with wording meant for
                // a log, not a handset.
                if (!Number.isFinite(price) || price <= 0) {
                    console.error("[Hubtel Interact] Bad price on confirm:", sessionData.selectedPrice, "session:", SessionId);
                    endSession(SessionId);
                    return respond(SessionId, "release", "Sorry, that item is unavailable right now. Please dial again.");
                }

                const reference = buildUssdReference(orderType);
                sessionData.paystackReference = reference;
                sessionData.payerMsisdn = payerMsisdn;
                sessionData.payerNetwork = payerNetwork;

                // The order MUST be recorded before the charge. A customer who
                // approves instantly can have their webhook arrive in seconds, and a
                // webhook that cannot find its session has nothing to deliver.
                //
                // This was a Redis mirror until Upstash hit its request ceiling and
                // every write began returning HTTP 400 — which, because we refuse to
                // charge what we cannot record, stopped USSD selling altogether. The
                // session row was always going to be needed for fulfilment, so it is
                // now the only thing standing between the charge and the webhook, and
                // there is no cache quota in front of a payment any more.
                //
                // 2.5s, not the 8s this step used to allow: the Paystack call still
                // has to fit inside Hubtel's ~10s window after it.
                try {
                    await withTimeout(
                        save(SessionId, 'awaiting_payment', sessionData),
                        2500,
                        'Order save timeout'
                    );
                } catch (saveError: any) {
                    // Refusing here is the safe end of the trade: no charge has gone
                    // out yet, so the customer keeps their money and can retry.
                    console.error('[Hubtel Interact] Order save failed, refusing to charge:', saveError?.message);
                    return respond(SessionId, 'release', 'System busy. Please dial again in a moment.');
                }

                const chargeStart = Date.now();
                const charge = await chargeMobileMoney({
                    reference,
                    amountGhs: price,
                    payerMsisdn,
                    provider,
                    metadata: {
                        channel: 'ussd',
                        session_id: SessionId,
                        order_type: orderType,
                        payer_msisdn: payerMsisdn,
                        // ASCII only: the item name is echoed back to Hubtel on some
                        // paths, and a multi-byte character there makes the call throw.
                        item_name: toAsciiSafe(sessionData.itemName, 'ARHMS order'),
                        shop_id: sessionData.shopId ?? null,
                    },
                });
                console.log('[Hubtel Interact] Paystack charge took', Date.now() - chargeStart, 'ms,', 'outcome:', charge.outcome, 'ref:', reference);

                // Fail-open audit row. The webhook and the cron both upsert onto this
                // same client_reference, so this is the first write of three.
                waitUntil(
                    logInitiate({
                        clientReference: reference,
                        status: charge.outcome === 'paid' ? 'success' : charge.outcome === 'failed' ? 'failed' : 'pending',
                        amount: price,
                        channel: provider,
                        payerMsisdn,
                        responseCode: charge.rawStatus,
                        message: charge.message,
                        raw: charge.raw,
                    })
                );

                switch (charge.outcome) {
                    case 'otp':
                        sessionData.awaitingOtpFor = reference;
                        saveAsync(SessionId, 'awaiting_otp', sessionData);
                        return respond(
                            SessionId,
                            'response',
                            screenText(charge.displayText, 'Enter the OTP sent to your phone:'),
                            { label: 'Enter OTP', fieldType: 'number' }
                        );

                    case 'paid':
                        // Rare but real on a re-charge. The webhook still does the
                        // delivering — never fulfil from this route.
                        return respond(SessionId, 'release', 'Payment received. Your order is on the way.');

                    case 'failed':
                        endSession(SessionId);
                        return respond(
                            SessionId,
                            'release',
                            // Only Paystack's own wording reaches the customer. A null
                            // raw means the message came from US - a missing env var, a
                            // rejected amount - and putting our internals on a stranger's
                            // handset helps nobody and leaks configuration.
                            charge.raw
                                ? screenText(charge.message, 'Payment could not be started. Please try again.')
                                : 'Payment could not be started. Please try again.'
                        );

                    default:
                        // 'pending' covers both a genuine pay_offline AND a timeout we
                        // could not read the outcome of. Both get the same words on
                        // purpose: a charge whose fate we do not know may still take
                        // the customer's money, and telling them it failed is how we
                        // end up owing a delivery nobody is expecting.
                        return respond(SessionId, 'release', approvalInstruction(payerNetwork));
                }
            }

            // ── OTP (Telecel / AirtelTigo) ───────────────────────────────────────
            case 'awaiting_otp': {
                const reference = String(sessionData.awaitingOtpFor || sessionData.paystackReference || '');
                if (!reference) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Session expired. Please dial again.');
                }

                const otp = String(userInput || '').replace(/\D/g, '');
                // No "0. Back" here on purpose — a charge is live and there is nothing
                // to go back to. A short entry is a typo, so redraw rather than burn
                // the OTP on a request Paystack will reject.
                if (otp.length < 4) {
                    saveAsync(SessionId, 'awaiting_otp', sessionData);
                    return respond(SessionId, 'response', 'Invalid code.\nEnter the OTP sent to your phone:', {
                        label: 'Enter OTP',
                        fieldType: 'number',
                    });
                }

                const otpResult = await submitOtp({ reference, otp });
                console.log('[Hubtel Interact] OTP submit outcome:', otpResult.outcome, 'ref:', reference);

                waitUntil(
                    logInitiate({
                        clientReference: reference,
                        status: otpResult.outcome === 'paid' ? 'success' : otpResult.outcome === 'failed' ? 'failed' : 'pending',
                        responseCode: otpResult.rawStatus,
                        message: otpResult.message,
                        raw: otpResult.raw,
                    })
                );

                if (otpResult.outcome === 'failed') {
                    endSession(SessionId);
                    return respond(
                        SessionId,
                        'release',
                        otpResult.raw
                            ? screenText(otpResult.message, 'That code was not accepted. Please try again.')
                            : 'That code was not accepted. Please try again.'
                    );
                }

                // Everything else — approved, still processing, or unreadable — ends
                // the same way. Delivery is the webhook's job either way.
                return respond(
                    SessionId,
                    'release',
                    'Thank you. You will get an SMS once your order is delivered.'
                );
            }

            default:
                return respond(SessionId, 'release', 'Session expired or invalid state.');
        }
    } catch (error) {
        const totalDuration = Date.now() - requestStartTime;
        console.error('[Hubtel Interact] Unhandled error (took', totalDuration, 'ms):', error);
        return NextResponse.json({
            Type: 'Release',
            Message: 'An unexpected error occurred.'
        });
    }
}

/**
 * Where "0" goes from each step. 'exit' hangs up; anything else re-enters that
 * step, which re-renders its menu on the next keypress.
 */
const BACK_STEPS: Record<string, string> = {
    enter_short_code: 'exit',
    choose_service: 'exit',
    choose_network: 'choose_service',
    select_bundle: 'choose_network',
    select_checker_type: 'choose_service',
    enter_phone: 'choose_service',
};

/**
 * Races a query against a timeout so a slow DB can never eat Hubtel's window.
 * Returns `any` because Supabase query builders are thenables, not Promises,
 * and their resolved shape doesn't survive Promise.race's inference.
 */
function withTimeout(promise: PromiseLike<any>, ms: number, message: string): Promise<any> {
    return Promise.race([
        promise as Promise<any>,
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
}

/** Fire-and-forget session delete for every terminal path. */
function endSession(sessionId: string): void {
    waitUntil((async () => {
        const { error } = await getSupabaseAdmin().from('hubtel_sessions').delete().eq('session_id', sessionId);
        if (error) console.error('[Hubtel Interact] Session delete error:', error);
    })());
}

async function getHouseCode(): Promise<string | null> {
    try {
        const promise = getSupabaseAdmin()
            .from('admin_settings')
            .select('value')
            .eq('key', 'ussd_house_code')
            .maybeSingle();
        const result = await withTimeout(promise, 4000, 'House code timeout');
        // admin_settings.value is JSONB, so this arrives already parsed. It should
        // be a string, but String() keeps a mis-seeded number or boolean from
        // throwing here and taking down every USSD session.
        return String(result.data?.value ?? '').toUpperCase() || null;
    } catch {
        // Losing the house code only costs ARHMS its own direct sales for this
        // session; shop short codes still resolve, so don't fail the call.
        return null;
    }
}

/**
 * The checker list for this session: a shop's own selling prices when a shop is
 * resolved, otherwise the platform's `ussd_price ?? customer_price`.
 */
async function loadCheckers(sessionData: any): Promise<Array<{ id: string; name: string; price: number }>> {
    try {
        const typesPromise = getSupabaseAdmin()
            .from('results_checker_types')
            .select('id, name, customer_price, ussd_price')
            .eq('is_active', true)
            .order('display_order', { ascending: true });
        const typesResult = await withTimeout(typesPromise, 8000, 'Types fetch timeout');
        const types = typesResult.data || [];
        if (!types.length) return [];

        // Price only — the shop's margin is derived at fulfilment from the DB, so
        // carrying a cost figure through the session would just be a second,
        // staler source of truth.
        if (sessionData.mode !== 'shop') {
            return types.map((t: any) => ({
                id: t.id,
                name: t.name,
                price: Number(t.ussd_price ?? t.customer_price ?? 0),
            }));
        }

        const pricingPromise = getSupabaseAdmin()
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', sessionData.shopId);
        const pricingResult = await withTimeout(pricingPromise, 8000, 'Shop RC pricing timeout');

        const priceByType: Record<string, number> = {};
        for (const row of (pricingResult.data || [])) {
            priceByType[row.rc_type_id] = Number(row.selling_price);
        }

        // A shop only sells the checkers it has priced — an unpriced type has no
        // margin and must not appear.
        return types
            .filter((t: any) => priceByType[t.id] > 0)
            .map((t: any) => ({
                id: t.id,
                name: t.name,
                price: priceByType[t.id],
            }));
    } catch (e: any) {
        console.error('[Hubtel Interact] loadCheckers failed:', e?.message);
        return [];
    }
}

/** The shop's priced, available data bundles. */
async function loadShopBundles(shopId: string): Promise<Array<{ id: string; network: string; size: string; price: number }>> {
    try {
        const promise = getSupabaseAdmin()
            .from('shop_pricing')
            .select('package_id, selling_price, data_packages!inner(id, network, size, is_available, sort_order)')
            .eq('shop_id', shopId)
            .eq('data_packages.is_available', true);
        const result = await withTimeout(promise, 8000, 'Shop bundles timeout');

        return (result.data || [])
            .map((row: any) => ({
                id: row.package_id,
                network: row.data_packages?.network,
                size: row.data_packages?.size,
                price: Number(row.selling_price),
                sort: row.data_packages?.sort_order ?? 0,
            }))
            .filter((b: any) => b.network && b.size && b.price > 0)
            .sort((a: any, b: any) => a.network.localeCompare(b.network) || a.sort - b.sort)
            .map(({ id, network, size, price }: any) => ({ id, network, size, price }));
    } catch (e: any) {
        console.error('[Hubtel Interact] loadShopBundles failed:', e?.message);
        return [];
    }
}

function uniqueNetworks(bundles: Array<{ network: string }>): string[] {
    const seen: string[] = [];
    for (const b of bundles) {
        if (!seen.includes(b.network)) seen.push(b.network);
    }
    return seen;
}

function renderServiceMenu(shopName: string): string {
    // Long shop names would push the menu past one screen.
    const name = shopName.length > 20 ? `${shopName.slice(0, 19)}.` : shopName;
    return `Welcome to ${name}\n1. Data Bundles\n2. Result Checker\n0. Exit`;
}

function renderNetworkMenu(networks: string[]): string {
    let msg = 'Select Network:\n';
    networks.forEach((n, i) => {
        msg += `${i + 1}. ${n}\n`;
    });
    msg += '0. Back';
    return msg;
}

/** One page of bundles, numbered from 1 on every page. */
function renderBundleMenu(bundles: Array<{ size: string; price: number }>, page: number): string {
    const start = page * PAGE_SIZE;
    const slice = bundles.slice(start, start + PAGE_SIZE);
    const lastPage = Math.max(0, Math.ceil(bundles.length / PAGE_SIZE) - 1);

    let msg = 'Select Bundle:\n';
    slice.forEach((b, i) => {
        msg += `${i + 1}. ${b.size} - GHS ${formatGhs(b.price)}\n`;
    });
    if (page < lastPage) msg += '99. Next\n';
    if (page > 0) msg += '88. Prev\n';
    msg += '0. Back';
    return msg;
}

/** Renders the numbered checker list with inline prices, e.g. "1. BECE (18 GHS)". */
function renderCheckerMenu(types: Array<{ name: string; price: number }>): string {
    let msg = 'Select Checker Type:\n';
    types.forEach((t, i) => {
        msg += `${i + 1}. ${t.name} (${formatGhs(t.price)} GHS)\n`;
    });
    msg += '0. Back';
    return msg;
}

/**
 * Normalises a Ghanaian MSISDN to local 0XXXXXXXXX form, or returns null when it
 * isn't one. The old flow accepted any string verbatim, which meant a typo was
 * only discovered after the customer had paid.
 */
function normalizeGhanaPhone(input: string): string | null {
    if (!input) return null;
    let digits = String(input).replace(/[^\d]/g, '');

    if (digits.startsWith('233') && digits.length === 12) {
        digits = `0${digits.slice(3)}`;
    } else if (digits.length === 9 && !digits.startsWith('0')) {
        digits = `0${digits}`;
    }

    return /^0[235]\d{8}$/.test(digits) ? digits : null;
}

/**
 * What we tell a caller once the charge is away.
 *
 * "Wait for the prompt" was not enough. Of the first eleven live charges, three
 * were accepted by Paystack and then expired unapproved, and the caller's report
 * was simply that no prompt arrived. On MTN Ghana a merchant-initiated debit
 * often does not surface a prompt on its own; it waits in the approvals menu
 * until the customer goes and gets it. A caller who does not know that has no way
 * to complete a payment we have already asked for.
 *
 * Deliberately no menu numbers. They differ across handsets and MTN has moved
 * them before, and a confidently wrong instruction is worse than a vague one.
 *
 * ASCII only and inside one ~160-character screen: a non-ASCII character makes
 * the Hubtel call throw, and an over-long message is truncated mid-word.
 */
function approvalInstruction(network: string | null): string {
    if (network === 'MTN') {
        return 'Approve the prompt to pay. No prompt? Dial *170#, choose My Approvals. You get an SMS when done.';
    }
    return 'Approve the payment prompt on your phone. You will get an SMS once it is done.';
}

/**
 * Makes gateway text safe to put on a USSD screen: ASCII only, one screen long.
 *
 * Paystack writes for a web page and will happily hand back a sentence longer than
 * a handset can show. A truncated apology reads as a broken service, so cut it
 * ourselves at a word boundary rather than letting the network do it mid-word.
 */
const USSD_SCREEN_CHARS = 155;
function screenText(value: string | null | undefined, fallback: string): string {
    const ascii = toAsciiSafe(value, fallback);
    if (ascii.length <= USSD_SCREEN_CHARS) return ascii;
    const cut = ascii.slice(0, USSD_SCREEN_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "...";
}

/** Formats a GHS amount without trailing zeros: 18 -> "18", 0.01 -> "0.01", 18.5 -> "18.5" */
function formatGhs(price: any): string {
    const n = parseFloat(String(price ?? 0));
    if (isNaN(n)) return '0';
    return n.toFixed(2).replace(/\.?0+$/, '');
}

/** Persists the session's next step and data (awaited — use when ordering matters). */
async function save(sessionId: string, nextStep: string, data: any) {
    const { error } = await getSupabaseAdmin()
        .from('hubtel_sessions')
        .update({ current_step: nextStep, data, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId);
    if (error) console.error('[Hubtel Interact] Session update error:', error);
}

/**
 * Fire-and-forget session save — responds to Hubtel immediately without blocking
 * on the DB write. Errors are logged but never surfaced to the user.
 *
 * Used for every browsing step. NOT for the `awaiting_payment` transition, which
 * the confirm step awaits: that row is the only record tying the charge about to
 * go out to the order it pays for, and a charge we cannot match to a session is a
 * customer debited for nothing. Fire-and-forget is fine for a menu redraw and
 * quite wrong for that.
 */
function saveAsync(sessionId: string, nextStep: string, data: any): void {
    waitUntil((async () => {
        const { error } = await getSupabaseAdmin()
            .from('hubtel_sessions')
            .update({ current_step: nextStep, data, updated_at: new Date().toISOString() })
            .eq('session_id', sessionId);
        if (error) console.error('[Hubtel Interact] Async session update error:', error);
    })());
}

interface RespondOpts {
    label?: string;
    /** "menu" | "input" (default) | "display" */
    dataType?: 'menu' | 'input' | 'display';
    /** "text" (default) | "phone" | "decimal" | "number" | "email" | "textarea" */
    fieldType?: 'text' | 'phone' | 'decimal' | 'number' | 'email' | 'textarea';
    /** AddToCart cart item */
    item?: { ItemName: string; Qty: number; Price: number };
}

/**
 * Builds a Programmable Services response with all mandatory fields
 * (SessionId, Type, Message, Label, DataType, FieldType). A missing field
 * makes Hubtel reject the response with "Error: UUE".
 */
function respond(
    sessionId: string,
    type: 'response' | 'release' | 'AddToCart',
    message: string,
    opts: RespondOpts = {}
) {
    const isAddToCart = type === 'AddToCart';
    const isRelease = type === 'release';
    // Hubtel Programmable Services requires every response to echo SessionId and
    // carry the display metadata (Label, DataType, FieldType). Omitting them makes
    // Hubtel reject the payload as incomplete ("missing sessionId and required parameters").
    const TYPE_MAP = { response: 'Response', release: 'Release', AddToCart: 'AddToCart' } as const;
    const payload: Record<string, any> = {
        SessionId: sessionId,
        Type: TYPE_MAP[type],
        Message: message,
        Label: opts.label || 'ARHMS',
        DataType: opts.dataType || (isAddToCart || isRelease ? 'display' : 'input'),
        FieldType: opts.fieldType || 'text',
    };
    if (isAddToCart && opts.item) {
        payload.Item = opts.item;
    }
    return NextResponse.json(payload);
}
