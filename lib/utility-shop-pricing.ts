/**
 * What a customer pays over the face value of a bill, and who keeps it.
 *
 * One rule, and it is a TOTAL: the markup on a bill never exceeds
 * `utility_total_markup_cap_percent` (5%) no matter who sold it. The platform's own
 * fee, the selling shop's margin and every sub-agent above it all come out of that
 * single budget.
 *
 * This is the only place that knows the whole chain, which is why the cap cannot be
 * a database constraint. A CHECK sees one row; this rule spans admin_settings plus
 * every ancestor in sub_agents. A shop at 3% is legal beneath a Lead taking 0% and
 * illegal beneath a Lead taking 3% — and the same stored value flips between the two
 * when the upline edits theirs, without that shop's row ever changing.
 *
 * Which is also why `headroomFor` exists: the pricing screen has to show a shop the
 * ceiling it is actually working against today, not a constant.
 */
import { resolveSubAgentChain } from '@/lib/sub-agents'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'

const DEFAULT_CAP_PERCENT = 5
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface MarkupLeg {
    shopId: string
    ownerId: string
    /** 0 for the selling shop, 1 for its Lead, and so on up. */
    depth: number
    percent: number
    amount: number
}

export interface UtilityMarkup {
    /** The platform's own cut, from utility_fee_<service>_<band>. */
    platformPercent: number
    platformAmount: number
    /** One entry per reseller, selling shop first. */
    legs: MarkupLeg[]
    resellerPercent: number
    resellerAmount: number
    /** platform + resellers. Never above `capPercent`. */
    totalPercent: number
    totalFee: number
    capPercent: number
    /**
     * True when the configured percentages summed above the cap and had to be
     * trimmed. The customer is always charged the capped figure; this says the
     * configuration disagrees with what was charged, which an admin should know.
     */
    trimmed: boolean
}

export async function resolveMarkupCap(db: any): Promise<number> {
    try {
        const { data } = await db
            .from('admin_settings')
            .select('value')
            .eq('key', 'utility_total_markup_cap_percent')
            .maybeSingle()
        const n = parseFloat((data as any)?.value ?? '')
        return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP_PERCENT
    } catch {
        return DEFAULT_CAP_PERCENT
    }
}

/**
 * The platform's own percentage for this service, by the shop owner's role.
 *
 * Same keys the dashboard path reads, so a bill bought through a storefront and one
 * bought from the dashboard are priced by the platform identically.
 */
export async function platformFeePercent(
    db: any,
    service: string,
    ownerRole: string
): Promise<number> {
    if (!isUtilityService(service)) return 0
    const band = ownerRole === 'agent' ? 'agent' : 'customer'
    const { data } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', `utility_fee_${service}_${band}`)
        .maybeSingle()
    const n = parseFloat((data as any)?.value ?? '')
    return Number.isFinite(n) && n >= 0 ? n : 2
}

interface ShopRow {
    id: string
    owner_id: string
    utility_fee_percent: number | null
    utilities_enabled: boolean | null
    shop_name?: string | null
}

/**
 * Every reseller entitled to a cut of this shop's sale, nearest first.
 *
 * The selling shop is always leg 0. Its ancestors follow, because in this network a
 * sub-agent's customer is also, indirectly, the Lead's customer — the same shape
 * lib/pricing/chain-cost.ts uses for data.
 */
async function resolveChainShops(db: any, sellingShopId: string): Promise<ShopRow[]> {
    const { data: shop } = await db
        .from('shop_profiles')
        .select('id, owner_id, shop_name, utility_fee_percent, utilities_enabled')
        .eq('id', sellingShopId)
        .maybeSingle()

    if (!shop) return []

    const chain: ShopRow[] = [shop as ShopRow]

    const ancestors = await resolveSubAgentChain(db, (shop as ShopRow).owner_id)
    for (const a of ancestors) {
        const { data: up } = await db
            .from('shop_profiles')
            .select('id, owner_id, shop_name, utility_fee_percent, utilities_enabled')
            .eq('id', a.shopId)
            .maybeSingle()
        if (up) chain.push(up as ShopRow)
    }

    return chain
}

/**
 * The most this shop may set, given the platform's fee and what its upline takes.
 *
 * Returns 0 rather than a negative when the chain above has already used the whole
 * budget — a shop in that position can still sell, just at no margin.
 */
export async function headroomFor(
    db: any,
    shopId: string,
    service: string,
    ownerRole: string
): Promise<{ cap: number; platform: number; upline: number; headroom: number }> {
    const cap = await resolveMarkupCap(db)
    const platform = await platformFeePercent(db, service, ownerRole)

    const chain = await resolveChainShops(db, shopId)
    // Skip index 0 — that is this shop itself, whose ceiling we are computing.
    const upline = chain.slice(1).reduce((sum, s) => sum + Number(s.utility_fee_percent || 0), 0)

    return {
        cap,
        platform,
        upline: round2(upline),
        headroom: Math.max(0, round2(cap - platform - upline)),
    }
}

/**
 * Splits the markup on one bill.
 *
 * Trimming, when the configured percentages exceed the cap, takes from the FURTHEST
 * reseller first. The customer is charged the capped amount either way, so somebody
 * has to absorb the difference, and the shop that actually made the sale is the last
 * one to lose out. The platform's own fee is never trimmed: it is the floor the
 * whole model is priced against.
 */
export async function computeUtilityMarkup(
    db: any,
    params: { shopId: string | null; service: string; ownerRole: string; billAmount: number }
): Promise<UtilityMarkup> {
    const { shopId, service, ownerRole, billAmount } = params
    const cap = await resolveMarkupCap(db)
    const platformPercent = await platformFeePercent(db, service, ownerRole)

    const base: UtilityMarkup = {
        platformPercent,
        platformAmount: round2(billAmount * platformPercent / 100),
        legs: [],
        resellerPercent: 0,
        resellerAmount: 0,
        totalPercent: platformPercent,
        totalFee: round2(billAmount * platformPercent / 100),
        capPercent: cap,
        trimmed: false,
    }

    if (!shopId) return base

    const chain = await resolveChainShops(db, shopId)
    if (chain.length === 0) return base

    let budget = Math.max(0, round2(cap - platformPercent))
    let trimmed = false

    // Nearest-first: the selling shop is served before its upline, so a squeeze
    // falls on the level furthest from the customer.
    const legs: MarkupLeg[] = []
    for (let i = 0; i < chain.length; i++) {
        const wanted = Math.max(0, Number(chain[i].utility_fee_percent || 0))
        const granted = Math.min(wanted, budget)
        if (granted < wanted) trimmed = true
        budget = round2(budget - granted)

        if (granted > 0) {
            legs.push({
                shopId: chain[i].id,
                ownerId: chain[i].owner_id,
                depth: i,
                percent: granted,
                amount: round2(billAmount * granted / 100),
            })
        }
        if (budget <= 0) {
            // Anyone left gets nothing; record that the configuration wanted more.
            if (chain.slice(i + 1).some(s => Number(s.utility_fee_percent || 0) > 0)) trimmed = true
            break
        }
    }

    const resellerPercent = round2(legs.reduce((s, l) => s + l.percent, 0))
    const resellerAmount = round2(legs.reduce((s, l) => s + l.amount, 0))

    return {
        platformPercent,
        platformAmount: base.platformAmount,
        legs,
        resellerPercent,
        resellerAmount,
        totalPercent: round2(platformPercent + resellerPercent),
        totalFee: round2(base.platformAmount + resellerAmount),
        capPercent: cap,
        trimmed,
    }
}

/** Human-readable service name, for storefront copy and receipts. */
export function serviceLabel(service: string): string {
    return isUtilityService(service) ? UTILITY_SERVICES[service].label : service
}
