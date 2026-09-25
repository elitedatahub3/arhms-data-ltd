import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'
import { SUB_AGENTS_GROUP_ID, getSubAgentPhones } from '@/lib/sms/customer-sms'

/**
 * Customer groups, plus the built-in "My Sub-Agents" group for a Lead.
 *
 * The built-in group has no rows anywhere: it is listed here with a live count
 * and expanded at send time by normaliseRecipients(), so a sub who joined today
 * is in it and one suspended yesterday is not.
 */
export async function GET() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, shop, sub } = ctx

        const { data: groups } = await supabaseAdmin
            .from('sms_groups')
            .select('id, name, created_at, sms_group_members(count)')
            .eq('account_id', account.id)
            .order('name', { ascending: true })

        const result: any[] = (groups || []).map((g: any) => ({
            id: g.id,
            name: g.name,
            memberCount: g.sms_group_members?.[0]?.count ?? 0,
            system: false,
        }))

        // Anyone with a shop can have sub-agents under it — including a level-1
        // sub who has recruited their own. Shown only when there is someone in it.
        if (shop) {
            const subPhones = await getSubAgentPhones(supabaseAdmin, shop.id)
            if (subPhones.length) {
                result.unshift({
                    id: SUB_AGENTS_GROUP_ID,
                    name: 'My Sub-Agents',
                    memberCount: subPhones.length,
                    system: true,
                })
            }
        }

        return NextResponse.json({ success: true, groups: result, isSub: sub.isSub })
    } catch (error: any) {
        console.error('[SmsGroups] GET error:', error)
        return NextResponse.json({ error: 'Failed to load groups' }, { status: 500 })
    }
}

/**
 * Creates a group, or adds/removes contacts in one.
 *
 * body: { name } to create; { groupId, addContactIds?, removeContactIds? } to edit.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const body: any = await request.json().catch(() => ({}))

        if (body.groupId) {
            if (body.groupId === SUB_AGENTS_GROUP_ID) {
                return NextResponse.json(
                    { error: 'My Sub-Agents updates itself as sub-agents join or leave' },
                    { status: 400 }
                )
            }

            const { data: group } = await supabaseAdmin
                .from('sms_groups')
                .select('id')
                .eq('id', body.groupId)
                .eq('account_id', account.id)
                .maybeSingle()

            if (!group) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

            const addIds: string[] = Array.isArray(body.addContactIds) ? body.addContactIds : []
            const removeIds: string[] = Array.isArray(body.removeContactIds) ? body.removeContactIds : []

            if (addIds.length) {
                // Only this account's own contacts may be put into its group: the
                // id list comes from the client.
                const { data: owned } = await supabaseAdmin
                    .from('sms_contacts')
                    .select('id')
                    .eq('account_id', account.id)
                    .in('id', addIds)

                const rows = (owned || []).map((c: any) => ({ group_id: body.groupId, contact_id: c.id }))
                if (rows.length) {
                    const { error } = await (supabaseAdmin.from('sms_group_members') as any)
                        .upsert(rows, { onConflict: 'group_id,contact_id', ignoreDuplicates: true })
                    if (error) {
                        console.error('[SmsGroups] add members failed:', error)
                        return NextResponse.json({ error: 'Could not add to group' }, { status: 500 })
                    }
                }
            }

            if (removeIds.length) {
                await supabaseAdmin
                    .from('sms_group_members')
                    .delete()
                    .eq('group_id', body.groupId)
                    .in('contact_id', removeIds)
            }

            return NextResponse.json({ success: true })
        }

        const name = String(body.name || '').trim()
        if (!name) return NextResponse.json({ error: 'Give the group a name' }, { status: 400 })
        if (name.length > 60) return NextResponse.json({ error: 'Group name is too long' }, { status: 400 })

        const { data: created, error } = await (supabaseAdmin.from('sms_groups') as any)
            .insert({ account_id: account.id, name })
            .select('id, name')
            .single()

        if (error) {
            if ((error as any).code === '23505') {
                return NextResponse.json({ error: 'You already have a group with that name' }, { status: 409 })
            }
            console.error('[SmsGroups] create failed:', error)
            return NextResponse.json({ error: 'Could not create the group' }, { status: 500 })
        }

        return NextResponse.json({ success: true, group: { ...created, memberCount: 0, system: false } })
    } catch (error: any) {
        console.error('[SmsGroups] POST error:', error)
        return NextResponse.json({ error: error.message || 'Failed to save group' }, { status: 500 })
    }
}

export async function DELETE(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const id = new URL(request.url).searchParams.get('id')

        if (!id || id === SUB_AGENTS_GROUP_ID) {
            return NextResponse.json({ error: 'That group cannot be deleted' }, { status: 400 })
        }

        // Deleting a group removes the grouping only; the contacts stay on the list.
        const { error } = await supabaseAdmin
            .from('sms_groups')
            .delete()
            .eq('id', id)
            .eq('account_id', account.id)

        if (error) {
            console.error('[SmsGroups] delete failed:', error)
            return NextResponse.json({ error: 'Could not delete the group' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[SmsGroups] DELETE error:', error)
        return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 })
    }
}
