import { createServerClient } from './supabase'
import { updateOrderWithColumnFallback } from './order-update-fallback'
import { creditShopProfit } from './shop-service'
import { resolveSubAgentContext } from './sub-agents'
import { resolveChainCosts, splitChainProfit } from './pricing/chain-cost'
import { shopFeeSettingKeys, resolveShopFeePercent } from './gateway-fees'
import type { PaymentProvider } from './payment-provider'

// In-memory lock to prevent race conditions between frontend verification and Paystack webhooks
const processingLocks = new Set<string>();

/**
 * Shared logic for processing a successful shop storefront payment.
 * Handles idempotency, security amount validation, order creation, profit credit, and fulfillment.
 */
export async function processShopOrder(
    reference: string,
    metadata: {
        shop_id: string;
        package_id: string;
        guest_phone: string;
        network: string;
        package_size: string;
        fulfillment_mode?: string;
        order_type?: string;
        type?: string;           // 'airtime' | 'mashup' — mirrors the airtime_orders.type column
        bundle_preference?: string; // 'balanced' | 'data' | 'voice' — Mashup only
        airtime_amount?: number;
        selling_price?: number;
        cost_price?: number;
        profit?: number;
        use_exact_amount?: boolean;
        original_amount?: number;
        /** 'ussd' when the sale came through the USSD short code rather than a web gateway. */
        channel?: string;
        /**
         * Set by /api/shop/initialize when the buyer was warned the recipient's MTN
         * number is not registered yet and chose to pay anyway. The order is created
         * but held — no supplier call — and the agentportal-mtn-verify cron delivers
         * it once MTN enables the number. USSD never sets this, so USSD sales keep
         * their existing behaviour.
         */
        awaiting_registration?: boolean;
        /**
         * Which rail collected this order, set by /api/shop/initialize. Read only to
         * pick the fee keys, since 'paystack' and 'paystack_momo' can be priced
         * differently. Absent on every reference initialized before paystack_momo
         * existed, which is why the resolution below treats absent as 'paystack'
         * rather than requiring it.
         */
        provider?: string;
    },
    paidAmountPesewas: number,
    slug?: string
): Promise<{ success: boolean; error?: string; orderId?: string; isDuplicate?: boolean }> {
    const supabase = createServerClient()
    const db = supabase as any

    try {
        console.log(`[Shop Order Processor] Processing paid shop order`)

        // 0. High-Speed Memory Lock (prevents exact-millisecond race conditions on same Vercel lambda)
        if (processingLocks.has(reference)) {
            console.log(`[Shop Order Processor] Active lock found. Skipping duplicate execution.`);
            return { success: true, isDuplicate: true }
        }
        processingLocks.add(reference);

        // 1. Idempotency Check
        const { data: existingOrder } = await db
            .from('shop_orders')
            .select('id, status')
            .eq('paystack_reference', reference)
            .single()

        if (existingOrder) {
            // STRICT IDEMPOTENCY: If the order exists, another process handles/handled it.
            // Do NOT re-trigger fulfillment if it's pending to prevent double-charging DataKazina.
            if (['pending', 'processing', 'completed', 'delivered'].includes(existingOrder.status)) {
                console.log(`[Shop Order Processor] Idempotency: Order exists with status: ${existingOrder.status}. Skipping duplicate fulfillment.`)
                processingLocks.delete(reference);
                return { success: true, orderId: existingOrder.id, isDuplicate: true }
            }
        }

        // 2. Security: Verify Amount Against DB Prices
        // A1 — Added airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at to select
        const { data: shopProfile } = await db
            .from('shop_profiles')
            .select('owner_id, shop_name, paystack_fee_percent, fulfillment_mode, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at')
            .eq('id', metadata.shop_id)
            .single()

        if (!shopProfile) return { success: false, error: 'Shop profile not found' }

        let expectedTotalPesewas = 0
        let verifiedSellingPrice = 0
        let verifiedCostPrice = 0
        let verifiedProfit = 0
        let adminCostAtTime = 0

        // Sub-agent attribution. Stays null for every ordinary shop, which is
        // what keeps this change inert for the vast majority of orders.
        let parentShopId: string | null = null
        let parentProfit: number | null = null
        // The root Lead, when the seller is a level-2 sub. Null at one or two
        // levels, where the direct upline IS the root.
        let grandparentShopId: string | null = null
        let grandparentProfit: number | null = null
        /**
         * Total margin on a sub order (selling − the ROOT Lead's cost). The
         * profit floor tests this instead of the sub's own leg: a zero leg at
         * any level is a legitimate outcome when an upline raises their price
         * after a downline set theirs, and rejecting there would fail an order
         * the customer has already paid for.
         */
        let subTotalMargin: number | null = null

        const { data: ownerProfile } = await db
            .from('users')
            .select('role')
            .eq('id', shopProfile?.owner_id)
            .single()
            
        const ownerRole = ownerProfile?.role || 'customer'

        if (metadata.order_type === 'airtime') {
            const { data: settingsRows } = await db.from('admin_settings').select('key, value').in('key', [
                `airtime_fee_${metadata.network.toLowerCase()}_customer`, 
                `airtime_fee_${metadata.network.toLowerCase()}_agent`,
                `airtime_fee_${metadata.network.toLowerCase()}_dealer`
            ])
            const settingsMap = (settingsRows || []).reduce((acc: any, curr: any) => ({ ...acc, [curr.key]: curr.value }), {})
            
            // A1 — shopFeeKey now reads correctly because columns were added to the select above
            const shopFeeKey = `airtime_fee_${metadata.network.toLowerCase()}`
            const shopFee = parseFloat((shopProfile as any)[shopFeeKey] || 0)
            const adminFee = parseFloat(settingsMap[`airtime_fee_${metadata.network.toLowerCase()}_${ownerRole}`] || '0')
            
            const originalAmount = parseFloat((metadata.original_amount || metadata.airtime_amount || metadata.selling_price || '0') as any)
            
            const totalFeeMultiplier = (shopFee + adminFee) / 100
            const feeAmount = originalAmount * totalFeeMultiplier
            
            let actualAirtimeAmount = originalAmount
            const exactFlag = metadata.use_exact_amount
            const isExact = exactFlag === true || String(exactFlag) === 'true'
            
            if (isExact || exactFlag === undefined) {
                // If it's an old pending order without the flag, it behaves like exact mode
                expectedTotalPesewas = Math.round((originalAmount + feeAmount) * 100)
            } else {
                expectedTotalPesewas = Math.round(originalAmount * 100)
                actualAirtimeAmount = Math.max(0, originalAmount - feeAmount)
            }
            
            verifiedSellingPrice = actualAirtimeAmount
            verifiedCostPrice = actualAirtimeAmount
            verifiedProfit = actualAirtimeAmount > 0 ? actualAirtimeAmount * (shopFee / 100) : 0
            adminCostAtTime = actualAirtimeAmount
        } else {
            // --- Role-Aware Paystack Fee Resolution ---
            // Resolved through lib/gateway-fees.ts, which the checkout routes also
            // use. The amount check below rejects anything more than five pesewas off
            // the figure derived here, so if the two sides resolve differently the
            // order fails AFTER the customer has paid. One ladder, both ends.
            //
            // The rail is read off the metadata rather than the settings, because the
            // admin setting may have been switched between this order being charged
            // and it being settled. The row has to be priced by whatever collected it.
            // Absent on every reference initialized before paystack_momo existed, so
            // it defaults to the hosted-checkout keys those orders were priced with.
            const settledProvider: PaymentProvider =
                metadata.provider === 'paystack_momo' ? 'paystack_momo' : 'paystack'

            const { data: paystackSettingsRows } = await db
                .from('shop_global_settings')
                .select('key, value')
                .in('key', shopFeeSettingKeys(ownerRole, settledProvider))
            const paystackSettingsMap: Record<string, string> = {}
            for (const row of (paystackSettingsRows || [])) {
                paystackSettingsMap[row.key] = row.value
            }

            const paystackFeePercent = resolveShopFeePercent(paystackSettingsMap, {
                shopOverride: shopProfile?.paystack_fee_percent,
                ownerRole,
                provider: settledProvider,
            })

            const { data: pkg } = await db.from('data_packages').select('price, agent_price, dealer_price, cost_price').eq('id', metadata.package_id).single()
            const { data: shopPrice } = await db.from('shop_pricing').select('selling_price').eq('shop_id', metadata.shop_id).eq('package_id', metadata.package_id).single()

            if (!shopPrice || !pkg) return { success: false, error: 'Price configuration missing' }

            const dbSellingPrice = parseFloat(shopPrice.selling_price)
            // USSD carries no gateway fee: the caller is charged exactly the shelf
            // price and the gateway absorbs its cut at settlement, so adding one here
            // would make every USSD order fail the amount check below. True of both
            // collection paths - Hubtel took its commission on its own side, Paystack
            // deducts its percentage from the payout.
            const paystackFee = metadata.channel === 'ussd'
                ? 0
                : Math.round(dbSellingPrice * (paystackFeePercent / 100) * 100) / 100
            expectedTotalPesewas = Math.round((dbSellingPrice + paystackFee) * 100)
            
            const isDealerOwner = ownerRole === 'dealer' && parseFloat(pkg?.dealer_price) > 0
            const isAgentOwner = ownerRole === 'agent' && parseFloat(pkg?.agent_price) > 0
            
            verifiedSellingPrice = dbSellingPrice
            
            if (isDealerOwner) {
                verifiedCostPrice = parseFloat(pkg?.dealer_price)
            } else if (isAgentOwner) {
                verifiedCostPrice = parseFloat(pkg?.agent_price)
            } else {
                verifiedCostPrice = parseFloat(pkg?.price) || 0
            }
            
            verifiedProfit = dbSellingPrice - verifiedCostPrice
            adminCostAtTime = parseFloat(pkg?.cost_price) || 0

            // ── SUB-AGENT SPLIT ──────────────────────────────────────────────
            // A sub prices their storefront strictly above their upline's retail
            // price (enforced in /api/dashboard/sub/pricing), so the UPLINE's
            // price — not the base package price — is the seller's cost basis.
            // Without this the seller banks the entire margin and the levels
            // above earn nothing on their own network's sales.
            //
            // The network runs three levels, so this walks every ancestor: a
            // level-2 sale owes its direct upline AND the root Lead. Pricing the
            // direct upline at their platform role price — as the two-level code
            // did — hands a level-1 sub the whole chain margin and pays the root
            // nothing, silently.
            const subContext = await resolveSubAgentContext(db, shopProfile.owner_id)

            if (subContext.isSub && subContext.chain.length > 0) {
                const levels = await resolveChainCosts(
                    db,
                    subContext.chain,
                    metadata.package_id,
                    {
                        price: parseFloat(pkg?.price) || 0,
                        agentPrice: pkg?.agent_price != null ? parseFloat(pkg.agent_price) : null,
                        dealerPrice: pkg?.dealer_price != null ? parseFloat(pkg.dealer_price) : null,
                    }
                )

                const split = splitChainProfit(dbSellingPrice, levels)

                if (!split) {
                    // An upline dropped this package after the seller priced it.
                    // Never fail an order the customer has already paid for —
                    // fall back to owner-role pricing with no attribution.
                    console.warn(
                        `[Shop Order Processor] Sub order with no upline price. Ref: ${reference}, shop: ${metadata.shop_id}, package: ${metadata.package_id}`
                    )
                } else {
                    verifiedCostPrice = split.sellerCost
                    verifiedProfit = split.sellerProfit
                    subTotalMargin = split.totalMargin

                    parentShopId = levels[0].shopId
                    parentProfit = split.ancestorProfits[0] ?? 0

                    if (levels[1]) {
                        grandparentShopId = levels[1].shopId
                        grandparentProfit = split.ancestorProfits[1] ?? 0
                    }
                }
            }
        }

        const amountDifference = Math.abs(paidAmountPesewas - expectedTotalPesewas)

        // A2 — SECURITY: Amount validation runs BEFORE any order creation
        if (amountDifference > 5) {
            console.error(`[Shop Order Processor] 🚨 AMOUNT MISMATCH: Ref: ${reference}, Paid: ${paidAmountPesewas}, Expected: ${expectedTotalPesewas}`)

            // B5 — Audit trail: persist mismatch for fraud monitoring
            try {
                await db.from('security_events').insert({
                    event_type: 'airtime_amount_mismatch',
                    reference,
                    shop_id: metadata.shop_id,
                    paid_amount: paidAmountPesewas,
                    expected_amount: expectedTotalPesewas,
                    guest_phone: metadata.guest_phone,
                    network: metadata.network,
                    order_type: metadata.order_type || 'data',
                    created_at: new Date().toISOString()
                })
            } catch (auditErr) {
                // Non-fatal — log but continue returning the error
                console.warn('[Shop Order Processor] Audit log failed:', auditErr)
            }

            // A5 — Safety net: if an existingOrder record was found (already in DB), update all tables to failed
            if (existingOrder?.id) {
                await db.from('shop_orders').update({ status: 'failed' }).eq('id', existingOrder.id)
                await db.from('orders').update({ status: 'failed' }).eq('shop_order_id', existingOrder.id)
                await db.from('airtime_orders')
                    .update({ status: 'failed' })
                    .eq('reference_code', `SHOP-${reference.slice(-10)}`)
            }

            return { success: false, error: 'Payment amount mismatch' }
        }

        // 3. SECURITY: Validate profit floors (§7.5 — prevents underwater orders)
        // Ensure profit > 0 to prevent negative margins persisting through downgrade races.
        // On a sub order the two legs (sub markup + Lead margin) are tested together:
        // either one may legitimately be zero, but their total may not be.
        const floorMargin = subTotalMargin !== null ? subTotalMargin : verifiedProfit
        if (floorMargin <= 0) {
            console.error(`[Shop Order Processor] 🚨 PROFIT FLOOR VIOLATION: Ref: ${reference}, Margin: ${floorMargin}`)
            return { success: false, error: 'Order profit would be non-positive; order rejected' }
        }

        // 3. Create Order Records (only runs after amount validation passes)
        let orderId = existingOrder?.id
        let airtimeOrderId: string | null = null
        const fulfillmentMode = shopProfile?.fulfillment_mode || metadata.fulfillment_mode || 'auto'

        // Set at /api/shop/initialize: the buyer was warned this MTN number is not
        // registered and paid anyway. USSD never sets it, so USSD orders behave as before.
        const awaitingRegistration = metadata.awaiting_registration === true

        if (!existingOrder) {
            const payload = {
                shop_id: metadata.shop_id,
                package_id: metadata.package_id || null, // null for airtime
                guest_phone: metadata.guest_phone,
                network: metadata.network,
                package_size: metadata.package_size || `${metadata.airtime_amount} Airtime`,
                selling_price: verifiedSellingPrice,
                cost_price: verifiedCostPrice,
                profit: verifiedProfit,
                admin_cost_at_time: adminCostAtTime,
                owner_role_at_time: ownerRole,
                paystack_reference: reference,
                status: 'pending',
                awaiting_registration: awaitingRegistration,
                // Only sent for sub orders, so an ordinary shop's insert is
                // byte-for-byte what it was before this feature.
                ...(parentShopId ? { parent_shop_id: parentShopId, parent_profit: parentProfit } : {}),
                // Level-2 sales only — the root Lead sitting above the seller's
                // own upline. Shed on failure below.
                ...(grandparentShopId
                    ? { grandparent_shop_id: grandparentShopId, grandparent_profit: grandparentProfit }
                    : {}),
            }

            const insertOrder = (row: Record<string, any>) =>
                db.from('shop_orders').insert(row).select('id').single()

            let { data: newOrder, error: createError } = await insertOrder(payload)

            if (createError && grandparentShopId) {
                // The customer has already paid. A DB that predates
                // migrations/20260825_sub_agent_level_3.sql rejects the whole
                // row for the sake of two columns — so drop the root Lead's
                // attribution and keep the order. That costs one manual credit
                // an admin can repair; failing here costs the bundle.
                console.error(
                    `[Shop Order Processor] Insert failed carrying grandparent attribution ` +
                    `(${createError.message}). Retrying without it — apply ` +
                    `migrations/20260825_sub_agent_level_3.sql. Ref: ${reference}`
                )
                const { grandparent_shop_id, grandparent_profit, ...withoutGrandparent } = payload as any
                const retry = await insertOrder(withoutGrandparent)
                newOrder = retry.data
                createError = retry.error
            }

            if (createError) {
                console.error('[Shop Order Processor] Failed to create shop order:', createError)
                return { success: false, error: 'Order creation failed' }
            }
            orderId = newOrder?.id

            await db.from('orders').insert({
                user_id: shopProfile?.owner_id,
                phone_number: metadata.guest_phone,
                network: metadata.network,
                size: metadata.package_size || `${metadata.airtime_amount} Airtime`,
                price: verifiedSellingPrice,
                cost_price_at_time: verifiedCostPrice,
                role_at_time: ownerRole,
                status: 'pending',
                payment_status: 'paid',
                reference_code: `SHOP-${reference.slice(-10)}`,
                fulfillment_method: 'auto',
                shop_name: shopProfile?.shop_name || slug,
                shop_order_id: orderId,
                awaiting_registration: awaitingRegistration,
                registration_submitted_at: awaitingRegistration ? new Date().toISOString() : null,
            })

            // Mirror airtime orders to the primary airtime_orders ledger
            // so admins can view and fulfill them in the Airtime Intelligence page
            if (metadata.order_type === 'airtime') {
                // A3 — Use actual paid amount (paidAmountPesewas), NOT expectedTotalPesewas
                const totalPaidGHS = paidAmountPesewas / 100
                const totalFeeAmount = Math.max(0, totalPaidGHS - verifiedSellingPrice)
                const totalFeeRate = verifiedSellingPrice > 0 ? (totalFeeAmount / verifiedSellingPrice) * 100 : 0

                // A4 — Read use_exact_amount from metadata instead of hardcoding false
                const useExactAmountFlag = metadata.use_exact_amount === true || String(metadata.use_exact_amount) === 'true'
                
                const { data: mirroredAirtime } = await db.from('airtime_orders').insert({
                    user_id: shopProfile?.owner_id,
                    user_role: ownerRole,
                    beneficiary_phone: metadata.guest_phone,
                    network: metadata.network,
                    airtime_amount: verifiedSellingPrice, // Net airtime value credited
                    fee_rate: totalFeeRate,               // Combined markup %
                    fee_amount: totalFeeAmount,            // Total fee in GHS
                    total_paid: totalPaidGHS,              // Actual amount charged to customer
                    use_exact_amount: useExactAmountFlag,
                    // Mashup: forward type and bundle_preference so admin page shows correct badge
                    type: metadata.type || 'airtime',
                    bundle_preference: metadata.bundle_preference || null,
                    status: 'pending',
                    reference_code: `SHOP-${reference.slice(-10)}`,
                    shop_id: metadata.shop_id,
                    shop_name: shopProfile?.shop_name || slug
                }).select('id').single()

                // The mirrored row is what auto-fulfilment operates on, so its ID has
                // to travel to triggerShopFulfillment below.
                airtimeOrderId = mirroredAirtime?.id ?? null
            }
        }

        // 4. Process Valid Order — Profit Credit, Fulfillment
        // No "order received" SMS: the payment provider already texts a receipt, and
        // the customer hears from us again when the bundle actually lands.

        // 4.2 Credit Profit — sub orders pay two wallets (sub + Lead)
        try {
            await creditShopProfit(orderId!, { hasUpline: !!parentShopId })
        } catch (profitErr) {
            console.error('[Shop Order Processor] Profit credit error:', profitErr)
        }

        // 4.3 Trigger Fulfillment
        try {
            // On a replay the mirror row was written by the first pass, so recover its
            // ID rather than treating the order as un-fulfillable.
            if (!airtimeOrderId && metadata.order_type === 'airtime') {
                const { data: priorAirtime } = await db
                    .from('airtime_orders')
                    .select('id')
                    .eq('reference_code', `SHOP-${reference.slice(-10)}`)
                    .maybeSingle()
                airtimeOrderId = priorAirtime?.id ?? null
            }

            // Held for MTN registration — the whitelist would reject the supplier call.
            // Tell the recipient once here; agentportal-mtn-verify delivers it later.
            if (awaitingRegistration) {
                const { sendMtnVerificationPendingSMS } = await import('./sms-service')
                await sendMtnVerificationPendingSMS(metadata.guest_phone, {
                    network: metadata.network,
                    size: metadata.package_size,
                }).catch((err: Error) =>
                    console.error('[Shop Order Processor] Verification-pending SMS failed:', err))

                console.log(`[Shop Order Processor] Order ${orderId} held — MTN number awaiting registration`)
                return { success: true, orderId }
            }

            const fulfillmentPayload = metadata.order_type === 'airtime'
               ? { amount: metadata.airtime_amount || verifiedSellingPrice }
               : { size: metadata.package_size }

            await triggerShopFulfillment(orderId!, metadata.network, metadata.guest_phone, db, {
                referenceCode: `SHOP-${reference.slice(-10)}`,
                price: verifiedSellingPrice,
                customerName: 'Shop Guest',
                customerEmail: 'N/A',
                shopName: shopProfile?.shop_name || slug || shopProfile?.shop_name,
                fulfillmentMode,
                orderType: metadata.type || metadata.order_type || 'data',
                bundlePreference: metadata.bundle_preference,
                airtimeOrderId,
                ...fulfillmentPayload
            })
        } catch (fulfillErr) {
            console.error('[Shop Order Processor] Fulfillment error:', fulfillErr)
        }

        return { success: true, orderId }

    } catch (error) {
        console.error('[Shop Order Processor] Critical error:', error)
        return { success: false, error: 'Internal processor error' }
    } finally {
        // Clear lock after processing completes or fails
        processingLocks.delete(reference);
    }
}

async function triggerShopFulfillment(
    orderId: string,
    network: string,
    phone: string,
    db: any,
    extra: {
        referenceCode: string
        price: number
        customerName: string
        customerEmail: string
        shopName: string
        fulfillmentMode: string
        orderType: string
        amount?: number
        size?: string
        bundlePreference?: string
        /** The mirrored airtime_orders row, when this is an airtime order. */
        airtimeOrderId?: string | null
    }
) {
    const { sendAdminNewOrderAlert } = await import('./email-service')

    const alertDetails = {
        referenceCode: extra.referenceCode,
        phoneNumber: phone,
        network: network,
        size: extra.size || `${extra.amount} Airtime`,
        price: extra.price,
        customerName: extra.customerName,
        customerEmail: extra.customerEmail,
        source: 'shop_storefront' as const,
        shopName: extra.shopName
    }

    // Airtime can now be delivered over Hubtel Commission Services, so try that before
    // falling back to the admin email. Mashup is deliberately excluded — it is an MTN
    // data/voice bundle, not airtime, and no API of ours can deliver it.
    if (extra.orderType === 'airtime' && extra.airtimeOrderId) {
        try {
            const { triggerAirtimeFulfillment } = await import('./airtime-fulfillment-dispatcher')
            const result = await triggerAirtimeFulfillment(extra.airtimeOrderId)
            if (result.dispatched) {
                console.log(`[Shop Order Processor] Airtime ${extra.referenceCode} auto-fulfilled via Hubtel`)
                return
            }
            console.log(`[Shop Order Processor] Airtime auto-fulfilment declined (${result.reason}) — alerting admin`)
        } catch (err) {
            console.error('[Shop Order Processor] Airtime auto-fulfilment threw — alerting admin:', err)
        }
    }

    if (extra.fulfillmentMode !== 'auto' || extra.orderType === 'airtime' || extra.orderType === 'mashup') {
        console.log(`[Shop Order Processor] Manual fulfillment required - sending alert`)

        if (extra.orderType === 'airtime' || extra.orderType === 'mashup') {
            const { sendAdminAirtimeOrderEmail } = await import('./email-service')
            await sendAdminAirtimeOrderEmail({
                referenceCode: extra.referenceCode,
                userName: extra.customerName,
                userEmail: extra.customerEmail,
                userRole: 'Guest',
                beneficiaryPhone: phone,
                network: network,
                airtimeAmount: extra.amount || extra.price,
                totalPaid: extra.price,
                useExactAmount: false,
                source: `Shop Storefront (${extra.shopName})`,
                // Pass through Mashup-specific fields so admin email shows correct template
                orderType: extra.orderType as 'airtime' | 'mashup',
                bundlePreference: extra.bundlePreference as 'balanced' | 'data' | 'voice' | undefined,
            }).catch(e => console.error('[Shop Order Processor] Admin Airtime Email Error:', e))
            
            try {
                const { sendAdminAirtimeAlertSMS } = await import('./sms-service')
                const { data: admins } = await db.from('users').select('phone_number').eq('role', 'admin')
                const adminPhones = admins?.map((a: any) => a.phone_number).filter(Boolean) || []
                if (adminPhones.length > 0) {
                    await sendAdminAirtimeAlertSMS(adminPhones, {
                        source: `${extra.customerName} / ${extra.shopName} (Shop)`,
                        receiver: phone,
                        amount: extra.amount || extra.price || 0,
                        network: network
                    })
                }
            } catch (err) {
                console.error('[Shop Order Processor] Admin SMS Error:', err)
            }
        } else {
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: 'Manual fulfillment mode enabled for this shop'
            }).catch(e => console.error('[Shop Order Processor] Admin Alert Error:', e))
        }
        
        return
    }

    try {
        // ── 1. Fetch fulfillment settings from admin_settings ──────────────
        const { data: settingsData } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        if (String(settingsMap.auto_fulfillment_enabled) === 'false') {
            console.log(`[Shop Order Processor] Auto-fulfillment globally disabled`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: 'Global auto-fulfillment is disabled' })
            return
        }

        // ── 2. Parse fulfillment_settings ─────────────────────────────────
        let fulfillmentSettings: {
            networks: Record<string, boolean>
            codecraft_networks: Record<string, boolean>
            kingflexy_networks: Record<string, boolean>
            eazydata_networks: Record<string, boolean>
            agentportal_networks: Record<string, boolean>
            netpulse_networks: Record<string, boolean>
            hendylinks_networks: Record<string, boolean>
        } = { networks: {}, codecraft_networks: {}, kingflexy_networks: {}, eazydata_networks: {}, agentportal_networks: {}, netpulse_networks: {}, hendylinks_networks: {} }

        try {
            if (settingsMap.fulfillment_settings) {
                const parsed = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
                fulfillmentSettings.networks = parsed.networks || {}
                fulfillmentSettings.codecraft_networks = parsed.codecraft_networks || {}
                fulfillmentSettings.kingflexy_networks = parsed.kingflexy_networks || {}
                fulfillmentSettings.eazydata_networks = parsed.eazydata_networks || {}
                fulfillmentSettings.agentportal_networks = parsed.agentportal_networks || {}
                fulfillmentSettings.netpulse_networks = parsed.netpulse_networks || {}
                fulfillmentSettings.hendylinks_networks = parsed.hendylinks_networks || {}
            }
        } catch (e) { /* ignore parse failure — defaults to empty */ }

        const isDataKazinaEnabled = fulfillmentSettings.networks[network] === true
        const isCodeCraftEnabled = fulfillmentSettings.codecraft_networks[network] === true
        const isKingFlexyEnabled = fulfillmentSettings.kingflexy_networks[network] === true
        const isEazyDataEnabled = fulfillmentSettings.eazydata_networks[network] === true
        const isAgentPortalEnabled = fulfillmentSettings.agentportal_networks[network] === true
        const isNetPulseEnabled = fulfillmentSettings.netpulse_networks[network] === true
        const isHendyLinksEnabled = fulfillmentSettings.hendylinks_networks[network] === true

        // ── 3. FULFILLMENT_CONFLICT Guard (absolute last line of defense) ──
        const activeCount = [isDataKazinaEnabled, isCodeCraftEnabled, isKingFlexyEnabled, isEazyDataEnabled, isAgentPortalEnabled, isNetPulseEnabled, isHendyLinksEnabled].filter(Boolean).length
        if (activeCount > 1) {
            console.error(`[Fulfillment] CONFLICT DETECTED for ${network} on order ${orderId}`)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `⚠️ SYSTEM HALTED: Multiple suppliers are active for ${network}. Order ${orderId} kept pending. Fix in admin panel immediately.`
            })
            // Keep order as PENDING — do not throw to outer catch (would trigger duplicate alert)
            return
        }

        // ── 4. No active supplier ──────────────────────────────────────────
        if (!isDataKazinaEnabled && !isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled && !isNetPulseEnabled && !isHendyLinksEnabled) {
            console.log(`[Shop Order Processor] No active supplier for network ${network}. Order ${orderId} kept pending.`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: `No active supplier configured for network: ${network}` })
            return
        }

        // ── 5. Determine supplier and stamp fulfilled_by ATOMICALLY first ──
        const supplierLabel = isCodeCraftEnabled ? 'codecraft' : isKingFlexyEnabled ? 'kingflexy' : isEazyDataEnabled ? 'eazydata' : isAgentPortalEnabled ? 'agentportal' : isNetPulseEnabled ? 'netpulse' : isHendyLinksEnabled ? 'hendylinks' : 'datakazina'
        await db.from('shop_orders').update({ fulfilled_by: supplierLabel }).eq('id', orderId)
        console.log(`[Shop Order Processor] Routing to ${supplierLabel} for order ${orderId} | network: ${network}`)

        // ── 6. Execute fulfillment (dedicated try/catch — ensures alert fires on any exception) ──
        // webhookRef is set by the Dakazina path only (see lib/fulfillment-service).
        let result: { success: boolean; reference?: string; transactionId?: string; webhookRef?: string; error?: string; isRateLimited?: boolean }

        try {
            if (isCodeCraftEnabled) {
                const { fulfillOrder: ccFulfill } = await import('./codecraft-service')
                result = await ccFulfill(network, phone, extra.size || '', orderId)
            } else if (isKingFlexyEnabled) {
                const { fulfillOrder: kfFulfill } = await import('./kingflexy-service')
                result = await kfFulfill(network, phone, extra.size || '', orderId)
            } else if (isEazyDataEnabled) {
                const { fulfillOrder: edFulfill } = await import('./eazydata-service')
                result = await edFulfill(network, phone, extra.size || '', orderId)
            } else if (isAgentPortalEnabled) {
                const { fulfillOrder: apFulfill } = await import('./agentportal-service')
                result = await apFulfill(network, phone, extra.size || '', orderId)
            } else if (isNetPulseEnabled) {
                const { fulfillOrder: npFulfill } = await import('./netpulse-service')
                result = await npFulfill(network, phone, extra.size || '', orderId)
            } else if (isHendyLinksEnabled) {
                const { fulfillOrder: hlFulfill } = await import('./hendylinks-service')
                result = await hlFulfill(network, phone, extra.size || '', orderId)
            } else {
                const { fulfillOrder: dkFulfill } = await import('./fulfillment-service')
                result = await dkFulfill(network, phone, extra.size || '', orderId)
            }
        } catch (importOrCallErr: any) {
            console.error(`[Shop Order Processor] Supplier import/call exception for order ${orderId}:`, importOrCallErr)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `Supplier exception during fulfillment (${supplierLabel}): ${importOrCallErr?.message || 'Unknown error'}. Order kept pending.`
            })
            return
        }

        // ── 7. Handle result ───────────────────────────────────────────────
        if (result.success) {
            const updatedAt = new Date().toISOString()

            const updatePayload: Record<string, any> = {
                status: 'processing',
                updated_at: updatedAt,
            }

            if (isCodeCraftEnabled && result.transactionId) {
                updatePayload.codecraft_reference_id = result.transactionId
            }
            if (isKingFlexyEnabled && result.transactionId) {
                updatePayload.kingflexy_reference = result.transactionId
            }
            if (isEazyDataEnabled && result.transactionId) {
                updatePayload.eazydata_reference = result.transactionId
            }
            if (isAgentPortalEnabled && result.transactionId) {
                updatePayload.agentportal_reference = result.transactionId
            }
            if (isNetPulseEnabled && result.transactionId) {
                updatePayload.netpulse_reference = result.transactionId
            }
            if (isHendyLinksEnabled && result.transactionId) {
                updatePayload.hendylinks_reference = result.transactionId
            }

            // Both writes below were previously unchecked: a missing supplier reference
            // column failed them silently and the order stayed 'pending' even though the
            // bundle had been bought. Shed the reference rather than lose the transition.
            await updateOrderWithColumnFallback(
                db,
                'shop_orders',
                { column: 'id', value: orderId },
                updatePayload,
                Object.keys(updatePayload).filter(k => k.endsWith('_reference')),
                '[Shop Order Processor]'
            )
            const ordersUpdate: Record<string, string> = { status: 'processing' }
            if (isCodeCraftEnabled && result.transactionId) {
                ordersUpdate.codecraft_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'codecraft'
            }
            if (isKingFlexyEnabled && result.transactionId) {
                ordersUpdate.kingflexy_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'kingflexy'
            }
            if (isEazyDataEnabled && result.transactionId) {
                ordersUpdate.eazydata_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'eazydata'
            }
            if (isAgentPortalEnabled && result.transactionId) {
                ordersUpdate.agentportal_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'agentportal'
            }
            if (isNetPulseEnabled && result.transactionId) {
                ordersUpdate.netpulse_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'netpulse'
            }
            if (isHendyLinksEnabled && result.transactionId) {
                ordersUpdate.hendylinks_reference = result.transactionId
                ordersUpdate.fulfillment_method = 'hendylinks'
            }
            await updateOrderWithColumnFallback(
                db,
                'orders',
                { column: 'shop_order_id', value: orderId },
                ordersUpdate,
                [...Object.keys(ordersUpdate).filter(k => k.endsWith('_reference')), 'fulfillment_method'],
                '[Shop Order Processor]'
            )

            if (!isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled && !isNetPulseEnabled && !isHendyLinksEnabled && (result.webhookRef || result.transactionId || result.reference)) {
                // webhookRef FIRST — see the matching note in order-fulfillment-dispatcher.
                const dakazinaRef = result.webhookRef || result.transactionId || result.reference

                const { error: refError } = await db
                    .from('orders')
                    .update({ dakazina_reference: dakazinaRef })
                    .eq('shop_order_id', orderId)
                if (refError) console.error(`[ShopOrderProcessor] Failed to stamp dakazina_reference:`, refError.message)

                await db
                    .from('shop_orders')
                    .update({ dakazina_reference: dakazinaRef })
                    .eq('id', orderId)
            }

            console.log(`[Shop Order Processor] Fulfillment success for order ${orderId} via ${supplierLabel}`)

            // AirtelTigo via Agent Portal has no verification gate — it delivers quickly.
            // Reassure the recipient once that delivery is instant.
            if (isAgentPortalEnabled && /^AT/i.test(network)) {
                try {
                    const { sendAtInstantDeliverySMS } = await import('@/lib/sms-service')
                    await sendAtInstantDeliverySMS(phone, { network, size: extra.size || '' })
                } catch (smsErr: any) {
                    console.error(`[Shop Order Processor] AT instant SMS failed for ${orderId}:`, smsErr?.message)
                }
            } else if (/MTN/i.test(network) && extra.size) {
                // MTN is with the supplier now. Confirm receipt once, without quoting a
                // delivery time. Airtime has its own SMS, so skip it here.
                try {
                    const { sendMtnOrderReceivedSMS } = await import('@/lib/sms-service')
                    await sendMtnOrderReceivedSMS(phone, { network, size: extra.size })
                } catch (smsErr: any) {
                    console.error(`[Shop Order Processor] MTN order-received SMS failed for ${orderId}:`, smsErr?.message)
                }
            }

        } else {
            // ALL failures → keep order as PENDING — never mark as failed
            console.warn(`[Shop Order Processor] Fulfillment attempt failed for order ${orderId} via ${supplierLabel}:`, result.error)
            console.warn(`[Shop Order Processor] Order ${orderId} kept as PENDING for manual review.`)

            // MTN whitelist gate (Agent Portal): number auto-submitted to MTN for
            // verification (up to 2 weeks) and the auto-refulfill cron delivers once it clears.
            // No SMS is sent to the recipient while the order is pending.

            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `Auto-fulfillment (${supplierLabel}) failed: ${result.error || 'Unknown error'}. Order kept pending.`
            })
        }

    } catch (err) {
        console.error(`[Shop Order Processor] Exception for order ${orderId}:`, err)
        // Keep order as PENDING — do not update status
        await sendAdminNewOrderAlert({
            ...alertDetails,
            reason: `System Exception during fulfillment: ${err instanceof Error ? err.message : 'Unknown exception'}. Order kept pending.`
        })
    }
}
