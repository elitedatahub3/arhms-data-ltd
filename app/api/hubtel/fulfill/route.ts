import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { fulfillUSSDRCBySession } from '@/lib/ussd-rc-fulfillment';
import { fulfillUSSDDataBySession } from '@/lib/ussd-data-fulfillment';
import { createClient } from '@supabase/supabase-js';
import { getDispatcher } from '@/lib/hubtel-payment-service';
import { logFulfillment } from '@/lib/hubtel-payment-log';

/**
 * Hubtel Programmable Services — Service Fulfilment URL
 *
 * Hubtel POSTs here after the customer has paid for a service initiated via the
 * AddToCart response in /api/hubtel/interact. We render the value (assign a
 * result-checker voucher + SMS) and then POST an acknowledgement back to
 * Hubtel's gs-callback within one hour.
 *
 * NO LONGER THE PRIMARY PATH. USSD sales are collected by Paystack Mobile Money
 * now and fulfilled from /api/webhooks/paystack; this endpoint only fires when
 * the USSD payment scope is set to Hubtel (Admin -> Settings -> USSD Payments,
 * backed by admin_settings.active_payment_provider_ussd), or for
 * an AddToCart order that was already in flight when that switch was flipped.
 * It stays fully wired and deliberately ungated: anything Hubtel has already
 * charged still has to be delivered.
 *
 * Fulfilment payload shape (see docs):
 *   { SessionId, OrderId, OrderInfo: { Status, Payment: { IsSuccessful, AmountPaid }, Items: [...] } }
 *
 * The gs-callback endpoint is IP-whitelisted, so the ack is sent through the
 * Fixie static proxy (same dispatcher used for all Hubtel API traffic).
 */

export const runtime = 'nodejs';
export const maxDuration = 45; // 45 seconds for the sequential fulfillment chain (voucher assign, SMS, ack)

const GS_CALLBACK_URL = 'https://gs-callback.hubtel.com:9055/callback';

export async function POST(req: Request) {
    let sessionId: string | undefined;
    let orderId: string | undefined;

    try {
        const body = await req.json();
        console.log('[Hubtel Fulfill] Service fulfilment received:', JSON.stringify(body));

        sessionId = body.SessionId;
        orderId = body.OrderId;
        const orderInfo = body.OrderInfo || {};
        const payment = orderInfo.Payment || {};

        if (!sessionId || !orderId) {
            console.error('[Hubtel Fulfill] Missing SessionId or OrderId.');
            return NextResponse.json({ message: 'Invalid fulfilment payload.' }, { status: 400 });
        }

        // Only fulfil a genuinely-paid order.
        const paid =
            payment.IsSuccessful === true ||
            String(orderInfo.Status || '').toLowerCase() === 'paid';

        // USSD payments never pass through initiatePayment or the Receive-Money webhook —
        // Hubtel collects on its side and only tells us here — so this is the only chance
        // to put the attempt on the admin's payment record.
        const payerMsisdn = orderInfo.CustomerMobileNumber ?? body.Mobile ?? null;

        if (!paid) {
            console.warn('[Hubtel Fulfill] Order not paid, skipping fulfilment:', orderId, orderInfo.Status);
            await logFulfillment({
                orderId,
                status: 'failed',
                amount: parseFloat(String(orderInfo.Subtotal ?? 0)) || null,
                payerMsisdn,
                message: `USSD order not paid (status: ${orderInfo.Status ?? 'unknown'}).`,
                raw: body,
            });
            // Ack Hubtel so it stops retrying; nothing to render for an unpaid order.
            await sendServiceCallback(sessionId, orderId, 'failed');
            return NextResponse.json({ message: 'Order not paid.' });
        }

        const amountPaid = parseFloat(
            String(payment.AmountAfterCharges ?? payment.AmountPaid ?? orderInfo.Subtotal ?? 0)
        );

        // The data path validates against the shelf price, so it needs the GROSS
        // amount. AmountAfterCharges is net of Hubtel's commission and would fail
        // processShopOrder's ±5 pesewa check on every single order.
        const grossPaid = parseFloat(
            String(payment.AmountPaid ?? orderInfo.Subtotal ?? payment.AmountAfterCharges ?? 0)
        );

        // Which product this session bought decides who fulfils it.
        const orderType = await getSessionOrderType(sessionId);

        // Fulfil (idempotent on OrderId).
        // Pass a callback for non-critical tasks to defer (admin push, session cleanup).
        const deferredWork: Array<() => Promise<void>> = [];
        const result = orderType === 'data'
            ? await fulfillUSSDDataBySession({
                sessionId,
                referenceCode: orderId,
                amountPaid: grossPaid,
                deferredWork,
            })
            : await fulfillUSSDRCBySession({
                sessionId,
                referenceCode: orderId,
                amountPaid,
                deferredWork,
            });

        // The money is in either way; `status` here reflects whether we rendered the value.
        await logFulfillment({
            orderId,
            status: result.success ? 'success' : 'failed',
            amount: amountPaid || null,
            payerMsisdn,
            message: result.success ? null : `Paid but fulfilment failed: ${result.error ?? 'unknown error'}`,
            raw: body,
        });

        // Report the outcome to Hubtel immediately. "success" only when value was rendered.
        await sendServiceCallback(sessionId, orderId, result.success ? 'success' : 'failed');

        // Fire-and-forget the deferred work (admin push, session cleanup) so it doesn't
        // block the Hubtel callback response.
        if (deferredWork.length > 0) {
            waitUntil(Promise.all(deferredWork.map((fn) => fn().catch(() => {}))));
        }

        if (!result.success) {
            console.error('[Hubtel Fulfill] Fulfilment failed:', result.error);
        }

        return NextResponse.json({ message: result.success ? 'Fulfilled.' : 'Fulfilment failed.' });
    } catch (error) {
        console.error('[Hubtel Fulfill] Unhandled error:', error);
        // Best-effort failure ack so Hubtel is not left waiting.
        if (sessionId && orderId) {
            await sendServiceCallback(sessionId, orderId, 'failed').catch(() => {});
        }
        return NextResponse.json({ message: 'Internal error. Order logged for manual review.' });
    }
}

/**
 * Reads `orderType` off the session. Defaults to 'rc': every session written
 * before short codes existed sold a result checker and has no orderType at all.
 */
async function getSessionOrderType(sessionId: string): Promise<'data' | 'rc'> {
    try {
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
        const { data } = await supabaseAdmin
            .from('hubtel_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .maybeSingle();
        return (data as any)?.data?.orderType === 'data' ? 'data' : 'rc';
    } catch (err) {
        console.error('[Hubtel Fulfill] Order type lookup failed, defaulting to rc:', err);
        return 'rc';
    }
}

/**
 * POSTs the Service Fulfilment acknowledgement to Hubtel's gs-callback.
 * Routed through the Fixie static proxy because the endpoint is IP-whitelisted.
 */
async function sendServiceCallback(
    sessionId: string,
    orderId: string,
    serviceStatus: 'success' | 'failed'
): Promise<void> {
    try {
        const res = await fetch(GS_CALLBACK_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
            },
            body: JSON.stringify({
                SessionId: sessionId,
                OrderId: orderId,
                ServiceStatus: serviceStatus,
                MetaData: null,
            }),
            // @ts-ignore — undici dispatcher for static IP routing
            dispatcher: getDispatcher(),
        });
        console.log(`[Hubtel Fulfill] gs-callback (${serviceStatus}) -> HTTP ${res.status}`);
    } catch (err: any) {
        console.error('[Hubtel Fulfill] gs-callback POST failed:', err?.message);
    }
}
