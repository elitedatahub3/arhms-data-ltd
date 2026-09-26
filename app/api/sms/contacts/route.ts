import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'
import { normalizeGhanaPhone } from '@/lib/sms-service'

/**
 * The shop's customer list.
 *
 * Numbers are stored in the 233XXXXXXXXX form normalizeGhanaPhone() produces,
 * which is what makes the UNIQUE (account_id, phone) collapse the same customer
 * arriving as 0551234567 from a manual add and 233551234567 from an order.
 */
export async function GET(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const url = new URL(request.url)
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0'))
        const search = (url.searchParams.get('search') || '').trim()
        const groupId = url.searchParams.get('groupId')
        const PAGE_SIZE = 100

        let query = supabaseAdmin
            .from('sms_contacts')
            .select('id, phone, name, source, opted_out, created_at', { count: 'exact' })
            .eq('account_id', account.id)

        if (search) {
            // A searcher typing 0551234567 should find the stored 233551234567.
            const normalised = normalizeGhanaPhone(search)
            query = normalised
                ? query.or(`phone.ilike.%${normalised}%,name.ilike.%${search}%`)
                : query.or(`phone.ilike.%${search}%,name.ilike.%${search}%`)
        }

        if (groupId) {
            const { data: members } = await supabaseAdmin
                .from('sms_group_members')
                .select('contact_id')
                .eq('group_id', groupId)
            const ids = (members || []).map((m: any) => m.contact_id)
            if (!ids.length) {
                return NextResponse.json({ success: true, contacts: [], total: 0, page })
            }
            query = query.in('id', ids)
        }

        const { data: contacts, count } = await query
            .order('created_at', { ascending: false })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

        return NextResponse.json({
            success: true,
            contacts: contacts || [],
            total: count ?? 0,
            page,
        })
    } catch (error: any) {
        console.error('[SmsContacts] GET error:', error)
        return NextResponse.json({ error: 'Failed to load your customers' }, { status: 500 })
    }
}

/**
 * Adds contacts — one typed by hand, or a pasted block, or a CSV's rows.
 *
 * All three arrive the same way so the dedupe, the validation and the reporting
 * of bad numbers only exist once.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const body: any = await request.json().catch(() => ({}))

        const source = body.source === 'import' ? 'import' : 'manual'
        const incoming: { phone: string; name?: string | null }[] = Array.isArray(body.contacts)
            ? body.contacts
            : [{ phone: body.phone, name: body.name }]

        if (!incoming.length) {
            return NextResponse.json({ error: 'No numbers to add' }, { status: 400 })
        }
        if (incoming.length > 5000) {
            return NextResponse.json({ error: 'Add at most 5,000 numbers at a time' }, { status: 400 })
        }

        const seen = new Map<string, string | null>()
        const invalid: string[] = []

        for (const entry of incoming) {
            const raw = String(entry?.phone ?? '').trim()
            if (!raw) continue
            const phone = normalizeGhanaPhone(raw)
            if (!phone) { invalid.push(raw); continue }
            // First name wins: a later blank row must not wipe a name already given.
            if (!seen.has(phone)) seen.set(phone, (entry?.name ?? '').toString().trim() || null)
        }

        if (!seen.size) {
            return NextResponse.json(
                { error: 'None of those numbers are valid Ghana numbers', invalid },
                { status: 400 }
            )
        }

        const rows = [...seen.entries()].map(([phone, name]) => ({
            account_id: account.id,
            phone,
            name,
            source,
        }))

        // onConflict ignoreDuplicates: re-importing a list is a normal thing to
        // do, and it must not error or overwrite names already edited.
        const { data: inserted, error } = await (supabaseAdmin.from('sms_contacts') as any)
            .upsert(rows, { onConflict: 'account_id,phone', ignoreDuplicates: true })
            .select('id')

        if (error) {
            console.error('[SmsContacts] insert failed:', error)
            return NextResponse.json({ error: 'Could not save those customers' }, { status: 500 })
        }

        const added = (inserted || []).length
        return NextResponse.json({
            success: true,
            added,
            duplicates: seen.size - added,
            invalid,
            message: `${added} customer${added === 1 ? '' : 's'} added`,
        })
    } catch (error: any) {
        console.error('[SmsContacts] POST error:', error)
        return NextResponse.json({ error: error.message || 'Failed to add customers' }, { status: 500 })
    }
}

/** Removes a contact, or flips its opt-out flag. */
export async function PATCH(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const body: any = await request.json().catch(() => ({}))
        const { id, optedOut, name } = body

        if (!id) return NextResponse.json({ error: 'Which customer?' }, { status: 400 })

        const patch: Record<string, any> = {}
        if (typeof optedOut === 'boolean') patch.opted_out = optedOut
        if (typeof name === 'string') patch.name = name.trim() || null

        if (!Object.keys(patch).length) {
            return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
        }

        // Scoped by account_id as well as id: an id alone would let one shop edit
        // another shop's contact.
        const { error } = await (supabaseAdmin.from('sms_contacts') as any)
            .update(patch)
            .eq('id', id)
            .eq('account_id', account.id)

        if (error) {
            console.error('[SmsContacts] update failed:', error)
            return NextResponse.json({ error: 'Could not update that customer' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[SmsContacts] PATCH error:', error)
        return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 })
    }
}

export async function DELETE(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const url = new URL(request.url)
        const id = url.searchParams.get('id')

        if (!id) return NextResponse.json({ error: 'Which customer?' }, { status: 400 })

        const { error } = await supabaseAdmin
            .from('sms_contacts')
            .delete()
            .eq('id', id)
            .eq('account_id', account.id)

        if (error) {
            console.error('[SmsContacts] delete failed:', error)
            return NextResponse.json({ error: 'Could not remove that customer' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[SmsContacts] DELETE error:', error)
        return NextResponse.json({ error: 'Failed to remove customer' }, { status: 500 })
    }
}
