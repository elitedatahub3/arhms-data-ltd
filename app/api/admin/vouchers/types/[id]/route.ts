import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { validateBulkTiers } from '@/lib/vouchers/pricing'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await validateAdminAccess(false)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params

    const supabase = createServerClient()
    const body = await request.json()
    const updates: Record<string, any> = { updated_at: new Date().toISOString() }

    // A blank/garbage numeric field must be rejected up front — parseFloat would
    // yield NaN, which serialises to null and trips the NOT NULL constraints.
    const numericFields = ['customer_price', 'agent_price', 'dealer_price', 'cost_price', 'display_order'] as const
    for (const field of numericFields) {
        if (body[field] === undefined) continue
        if (body[field] === null || body[field] === '' || !Number.isFinite(Number(body[field]))) {
            return NextResponse.json({ error: `${field.replace(/_/g, ' ')} must be a valid number` }, { status: 400 })
        }
    }

    if (body.name !== undefined) updates.name = body.name
    if (body.customer_price !== undefined) updates.customer_price = parseFloat(body.customer_price)
    if (body.agent_price !== undefined) updates.agent_price = parseFloat(body.agent_price)
    if (body.dealer_price !== undefined) updates.dealer_price = parseFloat(body.dealer_price) || 0
    if (body.cost_price !== undefined) updates.cost_price = parseFloat(body.cost_price)
    // Developer API price. Blank clears it, so API callers fall back to role pricing.
    if (body.api_price !== undefined) {
        const raw = body.api_price
        if (raw === null || raw === '') {
            updates.api_price = null
        } else if (!(Number(raw) >= 0)) {
            return NextResponse.json({ error: 'api price must be a valid number' }, { status: 400 })
        } else {
            updates.api_price = Number(raw) > 0 ? parseFloat(raw) : null
        }
    }
    if (body.display_order !== undefined) updates.display_order = parseInt(body.display_order)
    if (body.is_active !== undefined) updates.is_active = body.is_active

    // JSONB bulk pricing tiers
    if ('bulk_pricing' in body) {
        const tiers = Array.isArray(body.bulk_pricing) ? body.bulk_pricing : []

        // We need cost_price to validate tiers — fetch from DB if not provided
        let costForValidation = updates.cost_price
        if (costForValidation === undefined) {
            const { data: existing } = await (supabase as any)
                .from('results_checker_types')
                .select('cost_price')
                .eq('id', id)
                .single()
            costForValidation = existing?.cost_price ?? 0
        }

        const tierError = validateBulkTiers(tiers, costForValidation)
        if (tierError) return NextResponse.json({ error: tierError }, { status: 400 })

        updates.bulk_pricing = tiers
    }

    // Pricing sanity checks
    const cp = updates.customer_price
    const ap = updates.agent_price
    const dp = updates.dealer_price
    const cost = updates.cost_price

    if (cp !== undefined && cost !== undefined && cp < cost)
        return NextResponse.json({ error: 'Customer price cannot be below cost price' }, { status: 400 })
    if (ap !== undefined && cost !== undefined && ap < cost)
        return NextResponse.json({ error: 'Agent price cannot be below cost price' }, { status: 400 })
    if (dp !== undefined && dp > 0 && cost !== undefined && dp < cost)
        return NextResponse.json({ error: 'Dealer price cannot be below cost price' }, { status: 400 })
    if (updates.api_price != null && cost !== undefined && updates.api_price < cost)
        return NextResponse.json({ error: 'API price cannot be below cost price' }, { status: 400 })

    const { data, error } = await (supabase as any)
        .from('results_checker_types')
        .update(updates)
        .eq('id', id)
        .select()
        .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // cost_price is included — admin-only endpoint, the edit form needs it back.
    return NextResponse.json({ data })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await validateAdminAccess(false)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params

    const supabase = createServerClient()
    const { error } = await (supabase as any)
        .from('results_checker_types')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
}
