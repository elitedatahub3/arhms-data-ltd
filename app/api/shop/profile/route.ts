import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import {
    shortTextSchema,
    longTextSchema,
    phoneSchema,
    emailSchema,
    slugSchema,
    whatsappSchema,
    urlSchema,
    colorSchema,
} from '@/lib/validation'

// ─── Validation Schema ────────────────────────────────────────────────────────
// Every field a shop owner is allowed to write. Protected fields (owner_id,
// is_active, approval_status) are intentionally absent — they cannot be set here.
const shopProfileSchema = z.object({
    shop_name:       shortTextSchema,
    shop_slug:       slugSchema,
    description:     longTextSchema.optional(),
    owner_phone:     phoneSchema,
    owner_email:     emailSchema.optional().nullable(),
    whatsapp_number: whatsappSchema.optional().nullable(),
    community_link:  urlSchema.optional().nullable(),
    brand_color:     colorSchema.optional(),
    brand_accent:    colorSchema.optional(),
    logo_url:        urlSchema.optional().nullable(),
    banner_url:      urlSchema.optional().nullable(),
    banner_pos_x:    z.number().min(0).max(100).optional(),
    banner_pos_y:    z.number().min(0).max(100).optional(),
    banner_zoom:     z.number().min(1).max(2.5).optional(),
    divider_style:   shortTextSchema.optional(),
    is_active:       z.boolean().optional(),
})

// Helper: convert empty strings to null for optional text fields
function emptyToNull(val: string | undefined | null): string | null {
    if (val === undefined || val === null || val.trim() === '') return null
    return val.trim()
}

// ─── GET — Read the caller's own shop ─────────────────────────────────────────
// Authoritative "do I have a shop?" answer. The dashboard pages used to ask the
// browser Supabase client directly and treat ANY failure (expired token, network
// blip, RLS change) as "no shop" — which silently showed the create form to an
// owner who already had a shop, so their storefront looked lost after a re-login.
// Reading through the service role here removes that whole failure class: the
// caller either gets their shop, or an explicit error the UI can retry.
export async function GET() {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { data: shop, error } = await (supabaseAdmin as any)
            .from('shop_profiles')
            .select('*')
            .eq('owner_id', authUser.id)
            .maybeSingle()

        if (error) {
            console.error('[ShopProfile] GET error:', error)
            return NextResponse.json({ error: 'Failed to load shop' }, { status: 503 })
        }

        return NextResponse.json({ success: true, shop: shop ?? null }, { status: 200 })
    } catch (e: any) {
        console.error('[ShopProfile] GET api error:', e)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

// ─── POST — Create shop ───────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
    return handleShopProfileWrite(request, 'create')
}

// ─── PUT — Update shop ────────────────────────────────────────────────────────
export async function PUT(request: NextRequest) {
    return handleShopProfileWrite(request, 'update')
}

// ─── Shared handler ───────────────────────────────────────────────────────────
async function handleShopProfileWrite(request: NextRequest, mode: 'create' | 'update') {
    try {
        // 1. Authenticate
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const body = await request.json()

        // 2. Strict input validation (XSS / format prevention)
        const validation = shopProfileSchema.safeParse(body)
        if (!validation.success) {
            const errorDetails = validation.error.errors.map(
                err => `${err.path.join('.')}: ${err.message}`
            )
            console.warn(`[Security] Shop profile input rejected for user ${userId}: ${errorDetails.join(', ')}`)
            return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
        }

        // 3. Mass-assignment protection — explicitly destructure only allowed fields
        const data = validation.data as {
            shop_name: string
            shop_slug: string
            description?: string
            owner_phone: string
            owner_email?: string | null
            whatsapp_number?: string | null
            community_link?: string | null
            brand_color?: string
            brand_accent?: string
            logo_url?: string | null
            banner_url?: string | null
            banner_pos_x?: number
            banner_pos_y?: number
            banner_zoom?: number
            divider_style?: string
            is_active?: boolean
        }

        // Build safe DB payload — empty optional strings become null
        const dbPayload = {
            shop_name:       data.shop_name.trim(),
            shop_slug:       data.shop_slug.trim(),
            description:     emptyToNull(data.description),
            owner_phone:     data.owner_phone.trim(),
            owner_email:     emptyToNull(data.owner_email),
            whatsapp_number: emptyToNull(data.whatsapp_number),
            community_link:  emptyToNull(data.community_link),
            brand_color:     data.brand_color?.trim() || undefined,
            brand_accent:    data.brand_accent?.trim() || undefined,
            logo_url:        data.logo_url === undefined ? undefined : (data.logo_url ? data.logo_url.trim() : null),
            banner_url:      data.banner_url === undefined ? undefined : (data.banner_url ? data.banner_url.trim() : null),
            banner_pos_x:    data.banner_pos_x,
            banner_pos_y:    data.banner_pos_y,
            banner_zoom:     data.banner_zoom,
            divider_style:   data.divider_style?.trim() || undefined,
            updated_at:      new Date().toISOString(),
        }

        // 4. Use service role to bypass RLS (same pattern as update-profile)
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        if (mode === 'create') {
            // Check the user doesn't already have a shop (idempotency guard).
            // A failed lookup must NOT fall through to the insert — treating a read
            // error as "no shop" is how a returning owner ends up staring at an
            // empty create form and a bogus conflict when they resubmit.
            const { data: existing, error: existingError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .select('id, shop_slug')
                .eq('owner_id', userId)
                .maybeSingle()

            if (existingError) {
                console.error('[ShopProfile] Existing-shop lookup failed:', existingError)
                return NextResponse.json(
                    { error: 'Could not verify your shop right now. Please try again.' },
                    { status: 503 }
                )
            }

            if (existing) {
                return NextResponse.json(
                    {
                        error: 'You already have a shop.',
                        alreadyExists: true,
                        shopId: existing.id,
                        shopSlug: existing.shop_slug,
                    },
                    { status: 409 }
                )
            }

            const { data: created, error: insertError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .insert({ ...dbPayload, owner_id: userId, approval_status: 'approved', is_active: data.is_active ?? true })
                .select('id')
                .single()

            if (insertError) {
                console.error('[ShopProfile] Insert error:', insertError)
                if (insertError.code === '23505') {
                    // Two different unique indexes land here: shop_profiles_owner_id_key
                    // (this user already has a shop — e.g. a double-submit that raced the
                    // guard above) and the shop_slug index. Reporting the owner conflict
                    // as "slug taken" sends owners hunting for a new name forever.
                    if (String(insertError.message || '').includes('owner_id')) {
                        const { data: mine } = await (supabaseAdmin as any)
                            .from('shop_profiles')
                            .select('id, shop_slug')
                            .eq('owner_id', userId)
                            .maybeSingle()
                        return NextResponse.json(
                            {
                                error: 'You already have a shop.',
                                alreadyExists: true,
                                shopId: mine?.id ?? null,
                                shopSlug: mine?.shop_slug ?? null,
                            },
                            { status: 409 }
                        )
                    }
                    return NextResponse.json(
                        { error: 'Invalid input', details: ['shop_slug: This slug is already taken'] },
                        { status: 409 }
                    )
                }
                return NextResponse.json({ error: 'Failed to create shop' }, { status: 500 })
            }

            // Sub-agent shops mirror their upline's storefront from day one: their
            // prices are already bounded by the parent (no admin pricing review),
            // so auto-approve pricing and seed the catalog + airtime fees from the
            // parent. The sub can then adjust prices upward within their ceiling.
            await seedSubShopFromParent(supabaseAdmin, userId, created.id)

            return NextResponse.json(
                { success: true, shopId: created.id, shopSlug: dbPayload.shop_slug },
                { status: 200 }
            )
        } else {
            // Verify shop belongs to this authenticated user before updating
            const { data: existing, error: existingError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .select('id')
                .eq('owner_id', userId)
                .maybeSingle()

            if (existingError) {
                console.error('[ShopProfile] Owner lookup failed:', existingError)
                return NextResponse.json(
                    { error: 'Could not verify your shop right now. Please try again.' },
                    { status: 503 }
                )
            }

            if (!existing) {
                return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
            }

            const updatePayload: any = { ...dbPayload }
            if (data.is_active !== undefined) {
                updatePayload.is_active = data.is_active
            }
            const { error: updateError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .update(updatePayload)
                .eq('owner_id', userId)

            if (updateError) {
                console.error('[ShopProfile] Update error:', updateError)
                if (updateError.code === '23505') {
                    return NextResponse.json(
                        { error: 'Invalid input', details: ['shop_slug: This slug is already taken'] },
                        { status: 409 }
                    )
                }
                return NextResponse.json({ error: 'Failed to update shop' }, { status: 500 })
            }
        }

        return NextResponse.json({ success: true }, { status: 200 })

    } catch (e: any) {
        console.error('[ShopProfile] API error:', e)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

// ─── Sub-agent storefront seeding ─────────────────────────────────────────────
// If the shop's owner is a sub-agent, make their brand-new storefront mirror the
// upline (parent) shop: copy the parent's data-package catalog, Results Checker
// and AFA prices + airtime fees, and mark pricing approved so it goes live at
// once. No-op for regular shop owners.
//
// RC and AFA matter as much as data here. Both storefront tiles render only when
// the shop has its own priced rows — /api/shop/rc/types returns {types: []} and
// /api/shop/afa/config returns {enabled: false} otherwise — so before this,
// every sub storefront silently sold data and airtime only, at any level.
async function seedSubShopFromParent(supabaseAdmin: any, userId: string, newShopId: string) {
    try {
        const { data: sub } = await supabaseAdmin
            .from('sub_agents')
            .select('upline_shop_id')
            .eq('user_id', userId)
            .maybeSingle()

        const uplineShopId = sub?.upline_shop_id
        if (!uplineShopId) return // not a sub-agent — nothing to inherit

        // shop_pricing enforces profit_margin > 0, so a sub can't sell at exactly
        // the parent's price — seed at parent price + the minimum sub margin. The
        // catalog mirrors the parent; the sub adjusts prices in the pricing engine.
        const SUB_START_MARGIN = 0.5

        // Copy the parent's data-package catalog.
        const { data: parentPricing } = await supabaseAdmin
            .from('shop_pricing')
            .select('package_id, selling_price')
            .eq('shop_id', uplineShopId)

        if (parentPricing?.length) {
            const rows = parentPricing.map((r: any) => ({
                shop_id: newShopId,
                package_id: r.package_id,
                selling_price: Math.round((Number(r.selling_price) + SUB_START_MARGIN) * 100) / 100,
                profit_margin: SUB_START_MARGIN,
            }))
            await supabaseAdmin.from('shop_pricing').insert(rows)
        }

        // Copy the parent's Results Checker catalogue.
        const { data: parentRc } = await supabaseAdmin
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', uplineShopId)

        if (parentRc?.length) {
            await supabaseAdmin.from('shop_rc_pricing').insert(
                parentRc.map((r: any) => ({
                    shop_id: newShopId,
                    rc_type_id: r.rc_type_id,
                    selling_price:
                        Math.round((Number(r.selling_price) + SUB_START_MARGIN) * 100) / 100,
                }))
            )
        }

        // Copy the parent's AFA registration price. shop_afa_pricing is one row
        // per shop (shop_id is UNIQUE), unlike the two catalogues above.
        const { data: parentAfa } = await supabaseAdmin
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', uplineShopId)
            .maybeSingle()

        if (parentAfa?.selling_price != null) {
            await supabaseAdmin.from('shop_afa_pricing').upsert(
                {
                    shop_id: newShopId,
                    selling_price:
                        Math.round((Number(parentAfa.selling_price) + SUB_START_MARGIN) * 100) / 100,
                },
                { onConflict: 'shop_id' }
            )
        }

        // Mirror the parent's airtime fees and approve pricing so the storefront
        // goes live immediately instead of showing "Under Review".
        const { data: parentShop } = await supabaseAdmin
            .from('shop_profiles')
            .select('airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at')
            .eq('id', uplineShopId)
            .maybeSingle()

        await supabaseAdmin
            .from('shop_profiles')
            .update({
                pricing_status: 'approved',
                airtime_fee_mtn: parentShop?.airtime_fee_mtn ?? 0,
                airtime_fee_telecel: parentShop?.airtime_fee_telecel ?? 0,
                airtime_fee_at: parentShop?.airtime_fee_at ?? 0,
            })
            .eq('id', newShopId)
    } catch (e) {
        // Non-fatal — the shop exists; re-seeding happens when the sub saves pricing.
        console.error('[ShopProfile] Sub seed error:', e)
    }
}
