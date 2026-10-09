import { NextResponse } from 'next/server'
import { loadSmsContext, smsBlockReason } from '@/lib/sms/sms-purchase'
import { getSmsBusiness, SMS_BUSINESS_COLUMNS, type SmsBusinessRow } from '@/lib/sms/platform'
import {
    businessSubmitErrors,
    normaliseDomain,
    normaliseGhanaCard,
    ghanaCardLast4,
    maskGhanaCard,
    normaliseWhatsApp,
    BUSINESS_NAME_MIN,
    BUSINESS_NAME_MAX,
    BUSINESS_DESCRIPTION_MAX,
} from '@/lib/sms/sms-rules'

/**
 * Business registration for the SMS Platform.
 *
 * GET  — the registration (Ghana Card masked) and the account's mode.
 * PUT  — save a draft. Only the name is required.
 * POST — submit for review. Every field is required.
 *
 * The full Ghana Card number is validated and then dropped: only its last four
 * digits are stored, so a leaked row cannot be used to impersonate anybody.
 * Supporting documents travel over WhatsApp, never through here.
 */

function present(row: SmsBusinessRow | null) {
    if (!row) return null
    const { ghana_card_last4, ...rest } = row
    return { ...rest, ghana_card_masked: maskGhanaCard(ghana_card_last4), has_ghana_card: !!ghana_card_last4 }
}

export async function GET() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const business = await getSmsBusiness(ctx.supabaseAdmin, ctx.account.id)
        return NextResponse.json({
            success: true,
            mode: ctx.mode,
            business: present(business),
            documentsWhatsApp: String(ctx.settingsMap.sms_business_docs_whatsapp ?? '').replace(/^"+|"+$/g, '') || null,
        })
    } catch (error: any) {
        console.error('[SmsBusiness] GET error:', error)
        return NextResponse.json({ error: 'Failed to load your business registration' }, { status: 500 })
    }
}

export async function PUT(request: Request) {
    return save(request, false)
}

export async function POST(request: Request) {
    return save(request, true)
}

async function save(request: Request, submit: boolean) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, shop, sub } = ctx

        const blockedReason = smsBlockReason(shop, sub, ctx.userStatus)
        if (blockedReason) return NextResponse.json({ error: blockedReason }, { status: 403 })
        if (account.status === 'suspended') {
            return NextResponse.json({ error: 'Your SMS access is suspended. Please contact support.' }, { status: 403 })
        }

        const existing = await getSmsBusiness(supabaseAdmin, account.id)

        // Under review or approved, the registration is what the admin is
        // looking at (or signed off) — it cannot change underneath them.
        if (existing?.status === 'pending') {
            return NextResponse.json({ error: 'Your registration is under review and cannot be changed right now.' }, { status: 409 })
        }
        if (existing?.status === 'approved') {
            return NextResponse.json({ error: 'Your business is already approved. Contact support to change its details.' }, { status: 409 })
        }

        const body: any = await request.json().catch(() => ({}))
        const businessName = String(body.businessName ?? '').trim()
        const description = String(body.description ?? '').trim()
        const domainRaw = String(body.domain ?? '').trim()
        const cardRaw = String(body.ghanaCard ?? '').trim()
        const whatsappRaw = String(body.whatsapp ?? '').trim()

        if (businessName.length < BUSINESS_NAME_MIN || businessName.length > BUSINESS_NAME_MAX) {
            return NextResponse.json({ error: `Business name must be ${BUSINESS_NAME_MIN}–${BUSINESS_NAME_MAX} characters` }, { status: 400 })
        }
        if (description.length > BUSINESS_DESCRIPTION_MAX) {
            return NextResponse.json({ error: `Description must be ${BUSINESS_DESCRIPTION_MAX} characters or fewer` }, { status: 400 })
        }

        // A card typed now replaces the stored one; left blank, the stored last
        // four stand (the form can never show the full number back).
        const card = cardRaw ? normaliseGhanaCard(cardRaw) : null
        if (cardRaw && !card) {
            return NextResponse.json({ error: 'Enter a valid Ghana Card number (GHA-XXXXXXXXX-X)' }, { status: 400 })
        }
        const last4 = card ? ghanaCardLast4(card) : existing?.ghana_card_last4 ?? null

        const domain = domainRaw ? normaliseDomain(domainRaw) : null
        if (domainRaw && !domain) return NextResponse.json({ error: 'Enter a valid website or domain, e.g. yourbusiness.com' }, { status: 400 })

        const whatsapp = whatsappRaw ? normaliseWhatsApp(whatsappRaw) : null
        if (whatsappRaw && !whatsapp) return NextResponse.json({ error: 'Enter a valid WhatsApp number, e.g. 233244123456' }, { status: 400 })

        if (submit) {
            const errors = businessSubmitErrors({
                businessName,
                description,
                domain: domain ?? '',
                // The stored card counts as provided: rebuild a valid shape from it.
                ghanaCard: card ?? (last4 ? `GHA-000000${last4.slice(0, 3)}-${last4.slice(3)}` : ''),
                whatsapp: whatsapp ?? '',
            })
            if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 })
        }

        const now = new Date().toISOString()
        const row = {
            account_id: account.id,
            business_name: businessName,
            description,
            domain,
            ghana_card_last4: last4,
            whatsapp,
            status: submit ? 'pending' : 'draft',
            rejection_reason: null,
            submitted_at: submit ? now : null,
            updated_at: now,
        }

        const { data: saved, error } = await (supabaseAdmin.from('sms_businesses') as any)
            .upsert(row, { onConflict: 'account_id' })
            .select(SMS_BUSINESS_COLUMNS)
            .single()

        if (error) {
            console.error('[SmsBusiness] save failed:', error)
            if (error.code === '42P01') {
                return NextResponse.json({ error: 'Business registration is not available yet. Please try again later.' }, { status: 503 })
            }
            return NextResponse.json({ error: 'Could not save your registration' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            business: present(saved as SmsBusinessRow),
            message: submit
                ? 'Submitted for review. Send your documents on WhatsApp — we will let you know once you are approved.'
                : 'Draft saved.',
        })
    } catch (error: any) {
        console.error('[SmsBusiness] save error:', error)
        return NextResponse.json({ error: error.message || 'Could not save your registration' }, { status: 500 })
    }
}
