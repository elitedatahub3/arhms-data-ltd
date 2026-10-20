import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { isUssdEnabled, USSD_ENABLED_KEY, USSD_OFFLINE_MESSAGE } from '@/lib/ussd-availability';
import {
    checkMtnRegistrationStrict,
    resolveGateEnabled,
    ALL_MTN_GATE_KEYS,
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
    WEB_CHARGE_TIMEOUT_MS,
} from '@/lib/paystack-momo-service';
import { resolveProviderForScope, SCOPE_SETTING_KEY, type PaymentProvider } from '@/lib/payment-provider';
import { buildUssdReference } from '@/lib/ussd-reference';
import { getDeliveryStatusForConfirm } from '@/lib/delivery-status';
import { channelForNetwork, formatDuration, isConfirmWorthy } from '@/lib/delivery-estimate';
import { logInitiate } from '@/lib/hubtel-payment-log';
import {
    AIR_AMOUNT_PROMPT,
    AIR_PHONE_PROMPT,
    AIRTIME_ITEM_NAME,
    quoteAirtime,
    readAirtimeNumber,
    recordAirtimePayment,
    type AirtimeQuote,
} from '@/lib/ussd-airtime';
import {
    UTIL_AMOUNT_PROMPT,
    UTIL_PHONE_PROMPT,
    accountPrompt,
    callUtilitiesApi,
    readAccountNumber,
    readAmount,
    renderUtilityMenu,
    serviceFromChoice,
    utilityLabel,
} from '@/lib/ussd-utilities';
import {
    AFA_CARD_PROMPT,
    AFA_DOB_PROMPT,
    AFA_ITEM_NAME,
    AFA_NAME_PROMPT,
    AFA_PHONE_PROMPT,
    AFA_TOWN_PROMPT,
    lastRegionPage,
    loadAfaOffer,
    parseDateOfBirth,
    parseFullName,
    parseGhanaCard,
    parseTown,
    regionFromChoice,
    renderRegionMenu,
    type UssdAfaForm,
} from '@/lib/ussd-afa';
import {
    findMemberByPhone,
    loadMemberBundles,
    loadMemberCheckers,
    recordMemberPayment,
    type UssdMember,
} from '@/lib/ussd-member';

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
/**
 * How long to wait after releasing an MTN session before charging. The network
 * needs a moment to tear the USSD session down; a prompt pushed before then is
 * parked in pending approvals instead of popping up.
 */
const USSD_PROMPT_DELAY_MS = 3000;

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

/** admin_settings key: 'false' takes airtime off the USSD menu. */
const AIRTIME_ENABLED_KEY = 'ussd_airtime_enabled';

/** admin_settings key: utility bills are on the USSD menu only when this is exactly 'true'. */
const UTILITIES_ENABLED_KEY = 'ussd_utilities_enabled';

/** The edge route's wait on the Node-side bill route: pricing a bill, and recording a payment. */
const UTIL_QUOTE_TIMEOUT_MS = 7500;
const UTIL_CREATE_TIMEOUT_MS = 3500;
/** Wrong accounts tolerated before the session ends, so nobody can probe meters from a keypad. */
const MAX_UTIL_ATTEMPTS = 3;

/** admin_settings key: 'false' takes AFA registration off the USSD menu. */
const AFA_ENABLED_KEY = 'ussd_afa_enabled';

/** admin_settings key: 'false' makes registered users enter a short code again. */
const MEMBER_SKIP_CODE_KEY = 'ussd_member_skip_code';

/**
 * How long the dial-in waits to recognise a registered user. Past this the caller
 * simply gets the short-code screen — recognising them is never worth a dropped call.
 */
const MEMBER_LOOKUP_TIMEOUT_MS = 1500;

interface UssdFlags {
    enabled: boolean;
    /** 'paystack_momo' (we collect) | 'hubtel' (AddToCart, the pre-Paystack path). */
    paymentProvider: PaymentProvider;
    /** Refuse MTN data orders to numbers that are not registered yet. */
    mtnGateEnabled: boolean;
    /**
     * Registered users skip the short code (lib/ussd-member.ts). On unless an admin
     * writes 'false' to ussd_member_skip_code — the kill switch if it misbehaves.
     */
    memberSkipCode: boolean;
    /**
     * AFA registration on the menu (lib/ussd-afa.ts). On unless an admin writes 'false'
     * to ussd_afa_enabled. Shops additionally need the storefront AFA switch.
     */
    afaEnabled: boolean;
    /** admin_settings.storefront_afa_enabled — the same switch the storefront obeys. */
    afaStorefrontOpen: boolean;
    /**
     * Utility bills on the menu. OFF unless ussd_utilities_enabled is exactly 'true' —
     * unlike the other switches — because bills move real money through a provider whose
     * track record here is short.
     */
    utilitiesEnabled: boolean;
    /** admin_settings.utility_public_launch — the website's own master switch for bills. */
    utilityLaunched: boolean;
    /** Airtime on the menu for main-site users. On unless ussd_airtime_enabled is 'false'. */
    airtimeEnabled: boolean;
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
                .in('key', [USSD_ENABLED_KEY, USSD_PROVIDER_KEY, MEMBER_SKIP_CODE_KEY, AFA_ENABLED_KEY, 'storefront_afa_enabled', UTILITIES_ENABLED_KEY, 'utility_public_launch', AIRTIME_ENABLED_KEY, ...ALL_MTN_GATE_KEYS]),
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
            // Resolved by the same helper loadGateSettings() uses, under the main-site
            // toggle (USSD sells the main catalogue), so this route and the dashboard can
            // never disagree about whether the gate is on. Deliberately NOT
            // isUssdEnabled(): that helper's extra strictness belongs to the switch that
            // stops the service, and applying it here would be borrowing a rule from an
            // unrelated decision.
            mtnGateEnabled: resolveGateEnabled(raw, 'site'),
            memberSkipCode: String(raw[MEMBER_SKIP_CODE_KEY] ?? 'true').toLowerCase() !== 'false',
            afaEnabled: String(raw[AFA_ENABLED_KEY] ?? 'true').toLowerCase() !== 'false',
            afaStorefrontOpen: String(raw['storefront_afa_enabled'] ?? '') === 'true',
            utilitiesEnabled: String(raw[UTILITIES_ENABLED_KEY] ?? '') === 'true',
            utilityLaunched: String(raw['utility_public_launch'] ?? '') === 'true',
            airtimeEnabled: String(raw[AIRTIME_ENABLED_KEY] ?? 'true').toLowerCase() !== 'false',
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
            ?? { enabled: false, paymentProvider: 'paystack_momo', mtnGateEnabled: false, memberSkipCode: false, afaEnabled: false, afaStorefrontOpen: false, utilitiesEnabled: false, utilityLaunched: false, airtimeEnabled: false };
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

        // Initiation. A caller whose number is an account on the main site is never
        // asked for a short code: they go straight to the platform menu at their own
        // prices (lib/ussd-member.ts). Everyone else gets the short-code screen.
        //
        // Recognising them costs one indexed lookup inside this keypress, capped at
        // MEMBER_LOOKUP_TIMEOUT_MS. If it is slow or fails, the caller gets the
        // short-code screen — the old flow — rather than a dropped session.
        //
        // Only on the Paystack rail: members settle into their wallet, which the
        // Hubtel AddToCart rollback path knows nothing about.
        if (requestType === 'initiation' && SessionId) {
            if (ussdFlags.memberSkipCode && ussdFlags.paymentProvider === 'paystack_momo' && Mobile) {
                let member: UssdMember | null = null;
                try {
                    member = await withTimeout(
                        findMemberByPhone(getSupabaseAdmin(), String(Mobile)),
                        MEMBER_LOOKUP_TIMEOUT_MS,
                        'Member lookup timeout'
                    );
                } catch (err: any) {
                    console.warn('[Hubtel Interact] Member lookup skipped:', err?.message);
                }

                if (member) {
                    const memberData = {
                        operator: (Operator || 'mtn').toLowerCase(),
                        mode: 'member',
                        member,
                        // A sub-agent member is not offered AFA: see loadAfaOffer.
                        afaListed: ussdFlags.afaEnabled && ussdFlags.paymentProvider === 'paystack_momo' && !member.sub,
                        utilListed: ussdFlags.utilitiesEnabled && ussdFlags.utilityLaunched && ussdFlags.paymentProvider === 'paystack_momo',
                        // Airtime is for main-site users: a shop's airtime is priced by the shop
                        // and settled through the storefront order processor, which USSD does not use.
                        airListed: ussdFlags.airtimeEnabled && ussdFlags.paymentProvider === 'paystack_momo',
                    };
                    waitUntil((async () => {
                        const { error } = await getSupabaseAdmin().from('hubtel_sessions').upsert({
                            session_id: SessionId,
                            mobile: Mobile || '',
                            current_step: 'choose_service',
                            data: memberData,
                            updated_at: new Date().toISOString(),
                        });
                        if (error) console.error('[Hubtel] Member session creation error:', error);
                    })());
                    return respond(SessionId, 'response', serviceMenuFor(memberData), {
                        label: 'Select service',
                    });
                }
            }

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
            // Back from the recipient step depends on what is being bought: an AFA
            // application returns to its last question, not to the service menu.
            const back = currentStep === 'enter_phone' && sessionData.orderType === 'afa'
                ? 'afa_town'
                // Back from the amount returns to the last thing asked: the linked phone for
                // ECG, the account number for the TV bills.
                : currentStep === 'util_amount'
                    ? (sessionData.util?.service === 'ecg' ? 'util_phone' : 'util_account')
                    : BACK_STEPS[currentStep];
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
                        .select('id, shop_name, owner_id, utilities_enabled')
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

                // AFA is listed only for a shop that has priced it. One small read, and
                // only when the switches are on; if it is slow or fails the shop simply
                // shows no AFA line rather than delaying the menu.
                // Bills are listed for a shop that accepts them. No read needed: the flag rides
                // on the shop row already fetched. The Node-side route re-checks everything.
                sessionData.utilListed = ussdFlags.utilitiesEnabled && ussdFlags.utilityLaunched
                    && ussdFlags.paymentProvider === 'paystack_momo' && shop.utilities_enabled === true;
                sessionData.afaListed = false;
                if (ussdFlags.afaEnabled && ussdFlags.afaStorefrontOpen && ussdFlags.paymentProvider === 'paystack_momo') {
                    try {
                        const { data: afaRow } = await withTimeout(
                            getSupabaseAdmin().from('shop_afa_pricing').select('selling_price').eq('shop_id', shop.id).maybeSingle(),
                            1500,
                            'AFA price lookup timeout'
                        );
                        sessionData.afaListed = Number(afaRow?.selling_price) > 0;
                    } catch (e: any) {
                        console.warn('[Hubtel Interact] AFA listing skipped:', e?.message);
                    }
                }

                saveAsync(SessionId, 'choose_service', sessionData);
                return respond(SessionId, 'response', serviceMenuFor(sessionData), {
                    label: 'Select service',
                });
            }

            // ── SERVICE ──────────────────────────────────────────────────────────
            case 'choose_service': {
                const menu = serviceMenuFor(sessionData);
                // Every re-render below has to persist the step it drew, otherwise a
                // back-navigation would leave the DB pointing at the step we left.
                const reprompt = (msg: string) => {
                    saveAsync(SessionId, 'choose_service', sessionData);
                    return respond(SessionId, 'response', msg, { label: 'Select service' });
                };

                if (userInput === '2') {
                    const checkers = await loadCheckers(sessionData);
                    if (!checkers.length) {
                        return reprompt(`Result checkers unavailable.\n${menu}`);
                    }
                    sessionData.availableCheckers = checkers;
                    saveAsync(SessionId, 'select_checker_type', sessionData);
                    return respond(SessionId, 'response', renderCheckerMenu(checkers), {
                        label: 'Select Checker',
                    });
                }

                if (userInput === '1') {
                    // A shop sells its own catalogue; a registered user buys the platform
                    // catalogue at their own prices. The house code sells no bundles.
                    if (sessionData.mode !== 'shop' && sessionData.mode !== 'member') {
                        return reprompt(`Data bundles unavailable.\n${menu}`);
                    }

                    let bundles: Array<{ id: string; network: string; size: string; price: number }> = [];
                    try {
                        bundles = sessionData.mode === 'member'
                            ? await withTimeout(loadMemberBundles(getSupabaseAdmin(), sessionData.member), 8000, 'Member bundles timeout')
                            : await loadShopBundles(sessionData.shopId);
                    } catch (e: any) {
                        console.error('[Hubtel Interact] Bundle load failed:', e?.message);
                    }
                    if (!bundles.length) {
                        return reprompt(`No bundles available.\n${menu}`);
                    }

                    sessionData.allBundles = bundles;
                    const networks = uniqueNetworks(bundles);
                    sessionData.networks = networks;

                    saveAsync(SessionId, 'choose_network', sessionData);
                    return respond(SessionId, 'response', renderNetworkMenu(networks), {
                        label: 'Select network',
                    });
                }

                // 3 and up map through the same list the menu was numbered from.
                const extraKey = /^\d+$/.test(userInput || '') ? extraServices(sessionData)[parseInt(userInput, 10) - 3] : undefined;

                if (extraKey === 'air') {
                    sessionData.orderType = 'air';
                    sessionData.air = {};
                    saveAsync(SessionId, 'air_phone', sessionData);
                    return respond(SessionId, 'response', AIR_PHONE_PROMPT, { label: 'Number to top up', fieldType: 'phone' });
                }

                if (extraKey === 'util') {
                    sessionData.orderType = 'util';
                    sessionData.util = { attempts: 0 };
                    saveAsync(SessionId, 'util_service', sessionData);
                    return respond(SessionId, 'response', renderUtilityMenu(), { label: 'Select bill' });
                }

                if (extraKey === 'afa') {
                    let offer: { price: number } | null = null;
                    try {
                        offer = await withTimeout(loadAfaOffer(getSupabaseAdmin(), sessionData), 6000, 'AFA offer timeout');
                    } catch (e: any) {
                        console.error('[Hubtel Interact] loadAfaOffer failed:', e?.message);
                    }
                    if (!offer) {
                        return reprompt(`AFA registration is unavailable right now.\n${menu}`);
                    }

                    sessionData.orderType = 'afa';
                    sessionData.selectedPrice = offer.price;
                    sessionData.itemName = AFA_ITEM_NAME;
                    sessionData.afaForm = {};
                    sessionData.afaRegionPage = 0;
                    saveAsync(SessionId, 'afa_name', sessionData);
                    return respond(SessionId, 'response', AFA_NAME_PROMPT, { label: 'Full name' });
                }

                return reprompt(`${invalid('input')}${menu}`);
            }

            // ── AFA: the applicant's answers ─────────────────────────────────────
            // Five short questions. A wrong answer re-asks the same one with the reason;
            // "0" goes back one (handled above). Each answer is checked with the same
            // rules the web forms use, so nothing reaches the admin queue the dashboard
            // would have refused.

            case 'afa_name': {
                if (!userInput) {
                    saveAsync(SessionId, 'afa_name', sessionData);
                    return respond(SessionId, 'response', AFA_NAME_PROMPT, { label: 'Full name' });
                }
                const parsed = parseFullName(userInput);
                if (!parsed.ok) {
                    saveAsync(SessionId, 'afa_name', sessionData);
                    return respond(SessionId, 'response', `${parsed.error}\n${AFA_NAME_PROMPT}`, { label: 'Full name' });
                }
                sessionData.afaForm = { ...(sessionData.afaForm || {}), full_name: parsed.value };
                saveAsync(SessionId, 'afa_card', sessionData);
                return respond(SessionId, 'response', AFA_CARD_PROMPT, { label: 'Ghana Card' });
            }

            case 'afa_card': {
                if (!userInput) {
                    saveAsync(SessionId, 'afa_card', sessionData);
                    return respond(SessionId, 'response', AFA_CARD_PROMPT, { label: 'Ghana Card' });
                }
                const parsed = parseGhanaCard(userInput);
                if (!parsed.ok) {
                    saveAsync(SessionId, 'afa_card', sessionData);
                    return respond(SessionId, 'response', `${parsed.error}\n${AFA_CARD_PROMPT}`, { label: 'Ghana Card' });
                }
                sessionData.afaForm = { ...(sessionData.afaForm || {}), id_number: parsed.value };
                saveAsync(SessionId, 'afa_dob', sessionData);
                return respond(SessionId, 'response', AFA_DOB_PROMPT, { label: 'Date of birth' });
            }

            case 'afa_dob': {
                if (!userInput) {
                    saveAsync(SessionId, 'afa_dob', sessionData);
                    return respond(SessionId, 'response', AFA_DOB_PROMPT, { label: 'Date of birth' });
                }
                const parsed = parseDateOfBirth(userInput);
                if (!parsed.ok) {
                    saveAsync(SessionId, 'afa_dob', sessionData);
                    return respond(SessionId, 'response', `${parsed.error}\n${AFA_DOB_PROMPT}`, { label: 'Date of birth' });
                }
                sessionData.afaForm = { ...(sessionData.afaForm || {}), date_of_birth: parsed.value };
                sessionData.afaRegionPage = 0;
                saveAsync(SessionId, 'afa_region', sessionData);
                return respond(SessionId, 'response', renderRegionMenu(0), { label: 'Select region' });
            }

            case 'afa_region': {
                const page: number = sessionData.afaRegionPage || 0;
                if (userInput === '99' || userInput === '88') {
                    const next = userInput === '99' ? Math.min(page + 1, lastRegionPage()) : Math.max(page - 1, 0);
                    sessionData.afaRegionPage = next;
                    saveAsync(SessionId, 'afa_region', sessionData);
                    return respond(SessionId, 'response', renderRegionMenu(next), { label: 'Select region' });
                }
                if (!userInput) {
                    saveAsync(SessionId, 'afa_region', sessionData);
                    return respond(SessionId, 'response', renderRegionMenu(page), { label: 'Select region' });
                }
                const region = regionFromChoice(userInput, page);
                if (!region) {
                    saveAsync(SessionId, 'afa_region', sessionData);
                    return respond(SessionId, 'response', `Invalid selection.\n${renderRegionMenu(page)}`, { label: 'Select region' });
                }
                sessionData.afaForm = { ...(sessionData.afaForm || {}), region };
                saveAsync(SessionId, 'afa_town', sessionData);
                return respond(SessionId, 'response', AFA_TOWN_PROMPT, { label: 'Town' });
            }

            case 'afa_town': {
                if (!userInput) {
                    saveAsync(SessionId, 'afa_town', sessionData);
                    return respond(SessionId, 'response', AFA_TOWN_PROMPT, { label: 'Town' });
                }
                const parsed = parseTown(userInput);
                if (!parsed.ok) {
                    saveAsync(SessionId, 'afa_town', sessionData);
                    return respond(SessionId, 'response', `${parsed.error}\n${AFA_TOWN_PROMPT}`, { label: 'Town' });
                }
                sessionData.afaForm = { ...(sessionData.afaForm || {}), location: parsed.value };
                saveAsync(SessionId, 'enter_phone', sessionData);
                return respond(SessionId, 'response', AFA_PHONE_PROMPT, { label: 'Number to register', fieldType: 'phone' });
            }

            // ── AIRTIME: whose number, how much ──────────────────────────────────
            // Priced right here from admin_settings (the website's own keys): there is no
            // provider lookup to wait for. The network is read off the number, and the
            // beneficiary receives exactly the amount typed, with the fee on top.
            case 'air_phone': {
                if (!userInput) {
                    saveAsync(SessionId, 'air_phone', sessionData);
                    return respond(SessionId, 'response', AIR_PHONE_PROMPT, { label: 'Number to top up', fieldType: 'phone' });
                }
                const target = readAirtimeNumber(userInput, Mobile);
                if (!target.ok) {
                    saveAsync(SessionId, 'air_phone', sessionData);
                    return respond(SessionId, 'response', `${target.error}\n${AIR_PHONE_PROMPT}`, { label: 'Number to top up', fieldType: 'phone' });
                }
                sessionData.air = { phone: target.phone, network: target.network };
                saveAsync(SessionId, 'air_amount', sessionData);
                return respond(SessionId, 'response', `${target.network} ${target.phone}\n${AIR_AMOUNT_PROMPT}`, { label: 'Amount', fieldType: 'decimal' });
            }

            case 'air_amount': {
                const a = sessionData.air || {};
                if (!a.phone || !a.network || !sessionData.member) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Session expired. Please dial again.');
                }
                const prompt = `${a.network} ${a.phone}\n${AIR_AMOUNT_PROMPT}`;
                if (!userInput) {
                    saveAsync(SessionId, 'air_amount', sessionData);
                    return respond(SessionId, 'response', prompt, { label: 'Amount', fieldType: 'decimal' });
                }
                const amount = readAmount(userInput);
                if (!amount.ok) {
                    saveAsync(SessionId, 'air_amount', sessionData);
                    return respond(SessionId, 'response', `${amount.error}\n${AIR_AMOUNT_PROMPT}`, { label: 'Amount', fieldType: 'decimal' });
                }

                let priced: { ok: boolean; error?: string; quote?: AirtimeQuote } = { ok: false, error: 'Could not price that. Please try again.' };
                try {
                    priced = await withTimeout(
                        quoteAirtime(getSupabaseAdmin(), sessionData.member, { phone: a.phone, network: a.network, amount: amount.value as number }),
                        6000,
                        'Airtime quote timeout'
                    );
                } catch (e: any) {
                    console.error('[Hubtel Interact] quoteAirtime failed:', e?.message);
                }
                if (!priced.ok || !priced.quote) {
                    saveAsync(SessionId, 'air_amount', sessionData);
                    return respond(SessionId, 'response', screenText(`${priced.error}\n${AIR_AMOUNT_PROMPT}`, AIR_AMOUNT_PROMPT), { label: 'Amount', fieldType: 'decimal' });
                }

                const q = priced.quote;
                sessionData.air = { ...a, amount: q.airtimeAmount };
                sessionData.selectedPrice = q.total;
                sessionData.itemName = `${q.network} ${AIRTIME_ITEM_NAME}`;
                saveAsync(SessionId, 'confirm', sessionData);
                return respond(
                    SessionId,
                    'response',
                    `Confirm Airtime:\n${q.network} ${q.phone}\nAirtime GHS ${formatGhs(q.airtimeAmount)}\nFee GHS ${formatGhs(q.feeAmount)}\nTotal GHS ${formatGhs(q.total)}${USSD_CONFIRM_FOOTER}`,
                    { label: 'Confirm order' }
                );
            }

            // ── UTILITIES: which bill, which account, how much ───────────────────
            // Nothing here decides a price or whether an account exists. The Node-side route
            // does, in one bounded provider call at the amount step (lib/ussd-utilities.ts
            // explains why it cannot run here). The caller sees the account holder's name and
            // the total on the confirm screen, before any money is asked for.
            case 'util_service': {
                if (!userInput) {
                    saveAsync(SessionId, 'util_service', sessionData);
                    return respond(SessionId, 'response', renderUtilityMenu(), { label: 'Select bill' });
                }
                const service = serviceFromChoice(userInput);
                if (!service) {
                    saveAsync(SessionId, 'util_service', sessionData);
                    return respond(SessionId, 'response', `Invalid selection.\n${renderUtilityMenu()}`, { label: 'Select bill' });
                }
                sessionData.util = { ...(sessionData.util || {}), service };
                sessionData.itemName = utilityLabel(service);
                saveAsync(SessionId, 'util_account', sessionData);
                return respond(SessionId, 'response', accountPrompt(service), { label: 'Account number' });
            }

            case 'util_account': {
                const service = sessionData.util?.service;
                if (!service) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Session expired. Please dial again.');
                }
                if (!userInput) {
                    saveAsync(SessionId, 'util_account', sessionData);
                    return respond(SessionId, 'response', accountPrompt(service), { label: 'Account number' });
                }
                const account = readAccountNumber(userInput);
                if (!account.ok) {
                    saveAsync(SessionId, 'util_account', sessionData);
                    return respond(SessionId, 'response', `${account.error}\n${accountPrompt(service)}`, { label: 'Account number' });
                }
                sessionData.util = { ...sessionData.util, accountNumber: account.value };
                // ECG finds a meter through the phone it is linked to, so it needs that too.
                if (service === 'ecg') {
                    saveAsync(SessionId, 'util_phone', sessionData);
                    return respond(SessionId, 'response', UTIL_PHONE_PROMPT, { label: 'Linked phone', fieldType: 'phone' });
                }
                saveAsync(SessionId, 'util_amount', sessionData);
                return respond(SessionId, 'response', UTIL_AMOUNT_PROMPT, { label: 'Amount', fieldType: 'decimal' });
            }

            case 'util_phone': {
                if (!userInput) {
                    saveAsync(SessionId, 'util_phone', sessionData);
                    return respond(SessionId, 'response', UTIL_PHONE_PROMPT, { label: 'Linked phone', fieldType: 'phone' });
                }
                const phone = userInput === '1' ? normalizeGhanaPhone(Mobile) : normalizeGhanaPhone(userInput);
                if (!phone) {
                    saveAsync(SessionId, 'util_phone', sessionData);
                    return respond(SessionId, 'response', `Invalid number.\n${UTIL_PHONE_PROMPT}`, { label: 'Linked phone', fieldType: 'phone' });
                }
                sessionData.util = { ...sessionData.util, phone };
                saveAsync(SessionId, 'util_amount', sessionData);
                return respond(SessionId, 'response', UTIL_AMOUNT_PROMPT, { label: 'Amount', fieldType: 'decimal' });
            }

            case 'util_amount': {
                const u = sessionData.util || {};
                if (!u.service || !u.accountNumber) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Session expired. Please dial again.');
                }
                if (!userInput) {
                    saveAsync(SessionId, 'util_amount', sessionData);
                    return respond(SessionId, 'response', UTIL_AMOUNT_PROMPT, { label: 'Amount', fieldType: 'decimal' });
                }
                const amount = readAmount(userInput);
                if (!amount.ok) {
                    saveAsync(SessionId, 'util_amount', sessionData);
                    return respond(SessionId, 'response', `${amount.error}\n${UTIL_AMOUNT_PROMPT}`, { label: 'Amount', fieldType: 'decimal' });
                }

                const result = await callUtilitiesApi(
                    new URL(req.url).origin,
                    { action: 'quote', sessionId: SessionId, service: u.service, accountNumber: u.accountNumber, phone: u.phone, amount: amount.value },
                    UTIL_QUOTE_TIMEOUT_MS
                );

                if (!result.ok || !result.quote) {
                    const message = screenText(result.error, 'We could not price that bill. Please try again.');
                    if (result.field === 'fatal') {
                        endSession(SessionId);
                        return respond(SessionId, 'release', message);
                    }
                    if (result.field === 'amount') {
                        saveAsync(SessionId, 'util_amount', sessionData);
                        return respond(SessionId, 'response', screenText(`${message}\n${UTIL_AMOUNT_PROMPT}`, UTIL_AMOUNT_PROMPT), { label: 'Amount', fieldType: 'decimal' });
                    }
                    // An account the provider would not verify: count it, and send the caller
                    // back to re-enter it (and the phone, for ECG) rather than the amount.
                    const attempts = (u.attempts || 0) + 1;
                    if (attempts >= MAX_UTIL_ATTEMPTS) {
                        endSession(SessionId);
                        return respond(SessionId, 'release', 'We could not verify that account. Please check the number and dial again.');
                    }
                    sessionData.util = { ...u, attempts };
                    const retryStep = result.field === 'phone' ? 'util_phone' : 'util_account';
                    saveAsync(SessionId, retryStep, sessionData);
                    return respond(
                        SessionId,
                        'response',
                        screenText(`${message}\n${retryStep === 'util_phone' ? UTIL_PHONE_PROMPT : accountPrompt(u.service)}`, accountPrompt(u.service)),
                        { label: retryStep === 'util_phone' ? 'Linked phone' : 'Account number', ...(retryStep === 'util_phone' ? { fieldType: 'phone' as const } : {}) }
                    );
                }

                // The price is the server's, signed; the session only carries it to confirm.
                const q = result.quote;
                sessionData.util = { ...u, quote: q };
                sessionData.selectedPrice = q.total;
                sessionData.itemName = q.label;
                saveAsync(SessionId, 'confirm', sessionData);

                const holder = toAsciiSafe(q.accountName, '').slice(0, 24);
                const body = `Confirm ${q.label}:\n${q.accountNumber}${holder ? `\n${holder}` : ''}\nBill GHS ${formatGhs(q.billAmount)}\nFee GHS ${formatGhs(q.fee)}\nTotal GHS ${formatGhs(q.total)}`;
                return respond(SessionId, 'response', `${body}${USSD_CONFIRM_FOOTER}`, { label: 'Confirm order' });
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
                            sessionData.orderType === 'afa'
                                ? `Invalid number.\n${AFA_PHONE_PROMPT}`
                                : 'Invalid number.\nEnter recipient number:\n(or send 1 for your own number)',
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

                if (sessionData.orderType === 'afa') {
                    // The applicant's phone is the number being registered. The ID is not
                    // echoed back: a USSD screen is not a place to display it.
                    sessionData.afaForm = { ...(sessionData.afaForm || {}), phone: recipientMobile };
                    saveAsync(SessionId, 'confirm', sessionData);
                    const nm = String(sessionData.afaForm.full_name || '');
                    const shown = nm.length > 28 ? `${nm.slice(0, 27)}.` : nm;
                    return respond(
                        SessionId,
                        'response',
                        `Confirm AFA Registration:\n${shown}\nCost: GHS ${formatGhs(sessionData.selectedPrice)}\nNumber: ${recipientMobile}${USSD_CONFIRM_FOOTER}`,
                        { label: 'Confirm order' }
                    );
                }

                saveAsync(SessionId, 'confirm', sessionData);
                const confirmBody = `Confirm Order:\n${sessionData.itemName} x1\nCost: GHS ${formatGhs(sessionData.selectedPrice)}\nTo: ${recipientMobile}`;
                return respond(
                    SessionId,
                    'response',
                    `${confirmBody}${await ussdDeliveryLine(sessionData.orderType, sessionData.network, confirmBody)}${USSD_CONFIRM_FOOTER}`,
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
                const orderType: 'data' | 'rc' | 'afa' | 'util' | 'air' =
                    sessionData.orderType === 'data' ? 'data'
                        : sessionData.orderType === 'afa' ? 'afa'
                            : sessionData.orderType === 'util' ? 'util'
                                : sessionData.orderType === 'air' ? 'air' : 'rc';

                // The Hubtel rollback rail fulfils data and checkers only. A session
                // opened before an admin flipped to it must not charge for an AFA it
                // cannot deliver.
                if (orderType === 'afa' && ussdFlags.paymentProvider === 'hubtel') {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'AFA registration is unavailable right now. Please try again later.');
                }
                // Airtime settles through its own payment record too, and only for a main-site user.
                if (orderType === 'air' && (ussdFlags.paymentProvider === 'hubtel' || sessionData.mode !== 'member' || !sessionData.air?.phone)) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Airtime is unavailable right now. Please try again later.');
                }
                // Same for bills, which settle through their own payment record.
                if (orderType === 'util' && (ussdFlags.paymentProvider === 'hubtel' || !sessionData.util?.quote?.token)) {
                    endSession(SessionId);
                    return respond(SessionId, 'release', 'Bill payments are unavailable right now. Please try again later.');
                }

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
                        'We could not identify your mobile money network. Please buy at dataking.qzz.io.'
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
                        Promise.all([
                            save(SessionId, 'awaiting_payment', sessionData),
                            // A registered user's order is also recorded as a pending
                            // wallet top-up carrying the order: settlement credits it
                            // once and buys from the wallet (lib/ussd-member-settle.ts).
                            // Recorded BEFORE the charge for the same reason as the
                            // session: a payment we cannot match is a lost customer.
                            // A bill records its payment through the Node-side route, which holds the
                            // signed quote's contents; the edge sends only the quote and the reference.
                            // Airtime is priced AGAIN here, from the database, before it is recorded: a
                            // fee changed since the caller saw the total is refused, never charged silently.
                            orderType === 'air'
                                ? (async () => {
                                    const again = await quoteAirtime(getSupabaseAdmin(), sessionData.member, {
                                        phone: sessionData.air.phone, network: sessionData.air.network, amount: sessionData.air.amount,
                                    });
                                    if (!again.ok || !again.quote || again.quote.total !== price) throw new Error('Airtime price changed');
                                    await recordAirtimePayment(getSupabaseAdmin(), sessionData.member, {
                                        reference, quote: again.quote, payerMsisdn, sessionId: SessionId,
                                    });
                                })()
                                : orderType === 'util'
                                ? callUtilitiesApi(
                                    new URL(req.url).origin,
                                    { action: 'create', sessionId: SessionId, reference, token: sessionData.util.quote.token },
                                    UTIL_CREATE_TIMEOUT_MS
                                ).then((r) => { if (!r.ok) throw new Error(r.error || 'Bill payment could not be recorded'); })
                                : sessionData.mode === 'member'
                                ? recordMemberPayment(getSupabaseAdmin(), sessionData.member, {
                                    reference,
                                    amount: price,
                                    order: {
                                        orderType,
                                        packageId: sessionData.selectedPackageId,
                                        typeId: sessionData.selectedCheckerId,
                                        itemName: sessionData.itemName,
                                        recipient: sessionData.recipientMobile || payerMsisdn,
                                        payerMsisdn,
                                        sessionId: SessionId,
                                        afa: orderType === 'afa' ? (sessionData.afaForm as UssdAfaForm) : undefined,
                                    },
                                })
                                : Promise.resolve(),
                        ]),
                        orderType === 'util' ? UTIL_CREATE_TIMEOUT_MS + 500 : 2500,
                        'Order save timeout'
                    );
                } catch (saveError: any) {
                    // Refusing here is the safe end of the trade: no charge has gone
                    // out yet, so the customer keeps their money and can retry.
                    console.error('[Hubtel Interact] Order save failed, refusing to charge:', saveError?.message);
                    return respond(SessionId, 'release', 'System busy. Please dial again in a moment.');
                }

                const startCharge = async (timeoutMs?: number) => {
                    const chargeStart = Date.now();
                    const result = await chargeMobileMoney({
                        reference,
                        amountGhs: price,
                        payerMsisdn,
                        provider,
                        timeoutMs,
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
                    console.log('[Hubtel Interact] Paystack charge took', Date.now() - chargeStart, 'ms,', 'outcome:', result.outcome, 'ref:', reference);

                    // Fail-open audit row. The webhook and the cron both upsert onto this
                    // same client_reference, so this is the first write of three.
                    await logInitiate({
                        clientReference: reference,
                        status: result.outcome === 'paid' ? 'success' : result.outcome === 'failed' ? 'failed' : 'pending',
                        amount: price,
                        channel: provider,
                        payerMsisdn,
                        responseCode: result.rawStatus,
                        message: result.message,
                        raw: result.raw,
                    }).catch((err: any) => console.error('[Hubtel Interact] logInitiate failed:', err?.message));
                    return result;
                };

                // ── MTN: hang up FIRST, charge after ─────────────────────────────
                // A handset cannot show a pushed MoMo prompt while it is still inside
                // a USSD session. Charging before we release made MTN park the prompt
                // in pending approvals instead of popping it up. MTN never answers
                // send_otp, so nothing needs the session open: release now, wait for
                // the network to tear the session down, then charge so the PIN prompt
                // lands on an idle phone. With no Hubtel window to answer any more,
                // the charge gets the web budget instead of the 6s USSD one.
                if (payerNetwork === 'MTN') {
                    waitUntil((async () => {
                        await new Promise(resolve => setTimeout(resolve, USSD_PROMPT_DELAY_MS));
                        const result = await startCharge(WEB_CHARGE_TIMEOUT_MS);
                        if (result.outcome === 'failed') {
                            console.error('[Hubtel Interact] Background MTN charge refused:', result.message, 'ref:', reference);
                            endSession(SessionId);
                        }
                    })());
                    return respond(
                        SessionId,
                        'release',
                        `A MoMo prompt is coming now to pay GHS ${formatGhs(price)}. Enter your PIN to approve. You will get an SMS when done.`
                    );
                }

                // Telecel / AirtelTigo may answer send_otp, and the code has to be
                // typed into THIS session — so they keep the in-session charge.
                const charge = await startCharge();

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
    afa_name: 'choose_service',
    afa_card: 'afa_name',
    afa_dob: 'afa_card',
    afa_region: 'afa_dob',
    afa_town: 'afa_region',
    util_service: 'choose_service',
    util_account: 'util_service',
    util_phone: 'util_account',
    air_phone: 'choose_service',
    air_amount: 'air_phone',
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
    // A registered user pays their dashboard price (lib/ussd-member.ts).
    if (sessionData.mode === 'member') {
        try {
            return await withTimeout(loadMemberCheckers(getSupabaseAdmin(), sessionData.member), 8000, 'Member checkers timeout');
        } catch (e: any) {
            console.error('[Hubtel Interact] loadMemberCheckers failed:', e?.message);
            return [];
        }
    }
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
    // MTN is option 1. The loaders sort networks alphabetically, which buried it behind
    // AT and EXPRESS MTN; everything else keeps that order.
    const mtn = seen.filter((n) => String(n).trim().toUpperCase() === 'MTN');
    return [...mtn, ...seen.filter((n) => !mtn.includes(n))];
}

/** The service menu for whoever this session belongs to. */
/**
 * The services after Data (1) and Result Checker (2), in the order they are numbered from 3.
 * Numbered by what is actually on offer, so a shop with bills but no AFA shows "3. Utilities",
 * not a gap — and choose_service reads the caller's number back through this same list.
 */
function extraServices(sessionData: any): Array<'afa' | 'air' | 'util'> {
    const out: Array<'afa' | 'air' | 'util'> = [];
    if (sessionData.afaListed) out.push('afa');
    if (sessionData.airListed) out.push('air');
    if (sessionData.utilListed) out.push('util');
    return out;
}

const EXTRA_SERVICE_LABELS = { afa: 'AFA Registration', air: 'Airtime', util: 'Utilities' } as const;

/** The name a main-site user is welcomed to. */
const MEMBER_MENU_BRAND = 'ARHMSTECH';
const MEMBER_SERVICE_LABELS = { afa: 'AFA Registration', air: 'Buy Airtime', util: 'Pay Utility' } as const;

function serviceMenuFor(sessionData: any): string {
    const extras = extraServices(sessionData)
        .map((key, i) => `\n${3 + i}. ${EXTRA_SERVICE_LABELS[key]}`)
        .join('');
    if (sessionData.mode === 'member') {
        // What a main-site user sees. Deliberately plain: the brand, no help line, and the
        // services in the order the platform sells them. Labels differ slightly from a shop's
        // (the shop menu is the shop's own wording), so they are listed here, not shared.
        const memberExtras = extraServices(sessionData)
            .map((key, i) => `\n${3 + i}. ${MEMBER_SERVICE_LABELS[key]}`)
            .join('');
        return `Welcome to ${MEMBER_MENU_BRAND}\nChoose a Service:\n1. Data Bundles\n2. Waec Results Checker${memberExtras}`;
    }
    if (sessionData.mode === 'shop' && extras) {
        const shop = String(sessionData.shopName || 'ARHMS');
        const name = shop.length > 20 ? `${shop.slice(0, 19)}.` : shop;
        return `Welcome to ${name}\n1. Data Bundles\n2. Result Checker${extras}\n0. Exit`;
    }
    return renderServiceMenu(sessionData.shopName || 'ARHMS');
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
        return 'Enter your MoMo PIN on the prompt to pay. You will get an SMS when done.';
    }
    return 'Approve the payment prompt on your phone. You will get an SMS once it is done.';
}

const USSD_CONFIRM_FOOTER = '\n\n1. Confirm & Pay\n0. Cancel';

/**
 * "\nDelivery: ~2 min" for the confirm screen, or '' — when the channel isn't
 * live and fast, when the lookup is slow or fails, or when the line would push
 * the screen past one page. Never discouraging, never blocking a purchase.
 */
async function ussdDeliveryLine(orderType: string | undefined, network: string | undefined, body: string): Promise<string> {
    if (orderType !== 'data') return '';
    const channel = channelForNetwork(network);
    if (!channel) return '';
    const est = await getDeliveryStatusForConfirm(channel);
    if (!isConfirmWorthy(est)) return '';
    const line = `\nDelivery: ~${formatDuration(est.current)}`;
    if (!/^[\x20-\x7E\n]*$/.test(line)) return '';
    return (body + line + USSD_CONFIRM_FOOTER).length <= USSD_SCREEN_CHARS ? line : '';
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
