/**
 * USSD for registered users ("members").
 *
 * A caller whose number belongs to an account on the main site is never asked for a
 * short code. They go straight to the platform catalogue at their OWN account prices —
 * exactly what their dashboard charges — and anyone else is asked for a short code as
 * before.
 *
 * Payment is still a MoMo prompt, but the money lands where it would on the dashboard:
 * the charge is recorded as a pending wallet top-up (wallet_payments, under the USSD
 * reference, with the order in its metadata), and settlement credits the wallet once
 * and then buys from it through the dashboard's own purchase code — see
 * lib/ussd-member-settle.ts. If the purchase then fails, the money is safely in the
 * member's wallet rather than in a refund queue.
 *
 * EDGE-SAFE. app/api/hubtel/interact runs on the edge runtime, so this file may only
 * import pure modules (no Node built-ins, no undici). Everything here is PostgREST.
 */
import { rolePriceForPackage } from '@/lib/data-order-pricing'
import { calculateRCPrice } from '@/lib/vouchers/pricing'
import type { UssdAfaForm } from '@/lib/ussd-afa'

export interface UssdMember {
    userId: string
    firstName: string
    role: string
    isApiUser: boolean
    /** Set when the member is a sub-agent: they buy at their upline's prices. */
    sub: { status: string | null; uplineShopId: string } | null
}

/** Marks a wallet_payments row as a USSD member order rather than a plain top-up. */
export const USSD_MEMBER_PAYMENT_KIND = 'ussd_member'

/** Every way a number is stored in users.phone_number, for one handset. */
export function phoneVariants(msisdn: string): string[] {
    let digits = String(msisdn || '').replace(/\D/g, '')
    if (digits.startsWith('233') && digits.length === 12) digits = digits.slice(3)
    if (digits.startsWith('0') && digits.length === 10) digits = digits.slice(1)
    if (digits.length !== 9) return []
    return [`0${digits}`, `233${digits}`, `+233${digits}`]
}

/**
 * The account this handset belongs to, or null.
 *
 * Null also for anything we should not treat as a member: no match, more than one
 * account on the number (we cannot tell whose wallet it is), or an account that is
 * not active. Those callers get the short-code screen, as everyone did before.
 */
export async function findMemberByPhone(db: any, msisdn: string): Promise<UssdMember | null> {
    const variants = phoneVariants(msisdn)
    if (variants.length === 0) return null

    // '*' so a database without is_api_user still answers.
    const { data: rows, error } = await db
        .from('users')
        .select('*')
        .in('phone_number', variants)
        .limit(2)
    if (error) throw error
    if (!rows || rows.length !== 1) {
        if (rows && rows.length > 1) console.warn('[UssdMember] Number shared by several accounts; asking for a short code.')
        return null
    }

    const user = rows[0]
    const status = String(user.status || 'active').toLowerCase()
    if (status !== 'active') return null

    const { data: membership } = await db
        .from('sub_agents')
        .select('status, upline_shop_id')
        .eq('user_id', user.id)
        .maybeSingle()

    return {
        userId: user.id,
        firstName: String(user.first_name || '').trim(),
        role: user.role || 'customer',
        isApiUser: user.is_api_user === true,
        sub: membership?.upline_shop_id
            ? { status: membership.status ?? null, uplineShopId: membership.upline_shop_id }
            : null,
    }
}

export interface MemberBundle { id: string; network: string; size: string; price: number }

/**
 * The bundles a member can buy, at the price their dashboard would charge.
 *
 * A non-sub pays rolePriceForPackage() — the very expression resolveDataPrice()
 * charges with. A sub pays their upline's sub_price, and only for packages the
 * upline has set one on, matching resolveDataPrice()'s sub branch.
 */
export async function loadMemberBundles(db: any, member: UssdMember): Promise<MemberBundle[]> {
    const { data: packages } = await db
        .from('data_packages')
        .select('id, network, size, price, agent_price, dealer_price, api_price, sort_order')
        .eq('is_available', true)

    let priceOf: (pkg: any) => number | null
    if (member.sub) {
        if (member.sub.status !== 'active') return []
        const { data: rows } = await db
            .from('shop_pricing')
            .select('package_id, sub_price')
            .eq('shop_id', member.sub.uplineShopId)
        const subPrice = new Map<string, number>(
            ((rows || []) as any[])
                .filter((r) => Number(r.sub_price) > 0)
                .map((r) => [r.package_id, Number(r.sub_price)])
        )
        priceOf = (pkg) => subPrice.get(pkg.id) ?? null
    } else {
        const userRow = { role: member.role, is_api_user: member.isApiUser }
        priceOf = (pkg) => rolePriceForPackage(userRow, pkg)
    }

    return ((packages || []) as any[])
        .map((pkg) => ({ pkg, price: priceOf(pkg) }))
        .filter(({ pkg, price }) => pkg.network && pkg.size && price !== null && price > 0)
        .sort((a, b) => a.pkg.network.localeCompare(b.pkg.network) || (a.pkg.sort_order ?? 0) - (b.pkg.sort_order ?? 0))
        .map(({ pkg, price }) => ({ id: pkg.id, network: pkg.network, size: pkg.size, price: price as number }))
}

/**
 * The checkers a member can buy, at their dashboard price for one voucher.
 *
 * A non-sub pays calculateRCPrice() for a quantity of 1 — the function the wallet
 * purchase itself prices with. A sub pays their upline's selling price, as on
 * /dashboard/sub (and only while storefront_rc_enabled is on, the same toggle).
 */
export async function loadMemberCheckers(
    db: any,
    member: UssdMember
): Promise<Array<{ id: string; name: string; price: number }>> {
    const { data: types } = await db
        .from('results_checker_types')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true })
    if (!types?.length) return []

    if (member.sub) {
        if (member.sub.status !== 'active') return []
        const [{ data: setting }, { data: rows }] = await Promise.all([
            db.from('admin_settings').select('value').eq('key', 'storefront_rc_enabled').maybeSingle(),
            db.from('shop_rc_pricing').select('rc_type_id, selling_price').eq('shop_id', member.sub.uplineShopId),
        ])
        if (!setting || setting.value !== 'true') return []
        const priceByType = new Map<string, number>(
            ((rows || []) as any[]).map((r) => [r.rc_type_id, Number(r.selling_price)])
        )
        return (types as any[])
            .filter((t) => (priceByType.get(t.id) ?? 0) > 0)
            .map((t) => ({ id: t.id, name: t.name, price: priceByType.get(t.id) as number }))
    }

    const priced = await Promise.all((types as any[]).map(async (t) => {
        try {
            const breakdown = await calculateRCPrice({
                type: { ...t, bulk_pricing: Array.isArray(t.bulk_pricing) ? t.bulk_pricing : [] },
                quantity: 1,
                userRole: member.role,
                apiUser: member.isApiUser,
            })
            return { id: t.id, name: t.name, price: breakdown.total }
        } catch {
            return null // priced below cost — not for sale
        }
    }))
    return priced.filter((t): t is { id: string; name: string; price: number } => !!t && t.price > 0)
}

/**
 * Records the member's order as a pending wallet top-up, BEFORE the charge goes out.
 *
 * This row is what settlement acts on, so it carries everything needed to buy the
 * item without the USSD session (which is deleted after fulfilment). The existing
 * top-up settlement — processCompletedWalletPayment — claims it with an atomic
 * pending→completed update, so the wallet is credited exactly once however many
 * webhooks and sweeps arrive.
 */
export async function recordMemberPayment(
    db: any,
    member: UssdMember,
    params: {
        reference: string
        amount: number
        order: {
            orderType: 'data' | 'rc' | 'afa'
            packageId?: string
            typeId?: string
            itemName: string
            recipient: string
            payerMsisdn: string
            sessionId: string
            /** The applicant, for an AFA registration — settlement has no session to read. */
            afa?: UssdAfaForm
        }
    }
): Promise<void> {
    const { data: wallet } = await db
        .from('wallets')
        .select('id')
        .eq('user_id', member.userId)
        .maybeSingle()
    if (!wallet?.id) throw new Error('Member has no wallet')

    const { error } = await db.from('wallet_payments').insert({
        user_id: member.userId,
        wallet_id: wallet.id,
        amount: params.amount,
        fee: 0,
        total_amount: params.amount,
        reference: params.reference,
        provider: 'paystack_momo',
        status: 'pending',
        metadata: {
            kind: USSD_MEMBER_PAYMENT_KIND,
            channel: 'ussd',
            user_id: member.userId,
            role: member.role,
            order_type: params.order.orderType,
            package_id: params.order.packageId ?? null,
            type_id: params.order.typeId ?? null,
            item_name: params.order.itemName,
            recipient: params.order.recipient,
            payer_msisdn: params.order.payerMsisdn,
            session_id: params.order.sessionId,
            afa: params.order.afa ?? null,
        },
    })
    if (error) throw error
}
