import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { COMMISSION_KEY_TAG } from '@/lib/api-auth'

// GET    — key metadata (prefix, status, last_used_at) for every kind. Never the full key.
// POST   — generate a key of one kind. Returns the full key ONCE.
// PATCH  — set or clear the webhook URL, rotating the signing secret.
// DELETE — revoke one kind.
//
// Everything here is scoped by `kind`. Before v2 a user held exactly one key and POST
// opened with an unscoped `.delete().eq('user_id', ...)`; left that way, generating a
// commission key would silently destroy the standard key the caller is mid-integration
// with. Every query below therefore carries an .eq('kind', …).

const KINDS = ['standard', 'commission'] as const
type Kind = typeof KINDS[number]

/**
 * kf_live_ for data, kf_cs_live_ for commission services.
 *
 * The tags are different lengths, so the stored prefix is the tag plus 8 hex rather
 * than a fixed 16 characters — see prefixLengthFor() in lib/api-auth.ts, which is the
 * one place that has to agree with this.
 */
const KIND_TAG: Record<Kind, string> = {
    standard:   'kf_live_',
    commission: COMMISSION_KEY_TAG,
}

const KIND_NAME: Record<Kind, string> = {
    standard:   'Standard API Key',
    commission: 'Commission Services Key',
}

function parseKind(raw: unknown): Kind | null {
    if (raw === undefined || raw === null || raw === '') return 'standard'
    return (KINDS as readonly string[]).includes(raw as string) ? (raw as Kind) : null
}

const SELECT_COLUMNS = 'kind, key_prefix, name, status, last_used_at, created_at, updated_at, webhook_url, webhook_secret'

export async function GET() {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { data: keys } = await (supabase.from('api_keys') as any)
            .select(SELECT_COLUMNS)
            .eq('user_id', user.id)

        // The secret is fetched only to answer "is one configured?" — the UI needs to
        // distinguish a saved endpoint from one that can actually be verified. It is
        // dropped here and never leaves the server; it is shown once, at creation.
        const rows = ((keys as any[]) || []).map(({ webhook_secret, ...rest }: any) => ({
            ...rest,
            has_webhook_secret: !!webhook_secret,
        }))

        return NextResponse.json({
            success: true,
            keys: rows,
            // Retained so anything still reading the single-key shape keeps working.
            key: rows.find(k => (k.kind ?? 'standard') === 'standard') || null,
        })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let name: string | null = null
        let kindRaw: unknown
        try {
            const body = await request.json()
            if (body?.name && typeof body.name === 'string') name = body.name.slice(0, 80)
            kindRaw = body?.kind
        } catch { /* optional body */ }

        const kind = parseKind(kindRaw)
        if (!kind) {
            return NextResponse.json({ error: 'kind must be "standard" or "commission"' }, { status: 400 })
        }

        const randomPart = randomBytes(16).toString('hex')
        const fullKey = `${KIND_TAG[kind]}${randomPart}`
        const keyPrefix = fullKey.substring(0, KIND_TAG[kind].length + 8)
        const keyHash = await bcrypt.hash(fullKey, 10)

        const supabase = createServerClient()

        // Admins and sub-admins get auto-approved — they don't need approval from themselves
        const { data: userData } = await (supabase.from('users') as any)
            .select('role')
            .eq('id', user.id)
            .single()
        const userRole = (userData as any)?.role ?? 'customer'
        const isAdmin = userRole === 'admin' || userRole === 'sub-admin'
        const keyStatus = isAdmin ? 'active' : 'pending'

        // Replace only this kind. Regenerating is how a key is rotated, so the old
        // row for the SAME kind must go — but the other kind is left alone.
        await (supabase.from('api_keys') as any)
            .delete()
            .eq('user_id', user.id)
            .eq('kind', kind)

        const { error: insertError } = await (supabase.from('api_keys') as any).insert({
            user_id:    user.id,
            key_hash:   keyHash,
            key_prefix: keyPrefix,
            name:       name || KIND_NAME[kind],
            status:     keyStatus,
            kind,
        })

        if (insertError) {
            console.error('[API Keys] Insert error:', insertError)
            return NextResponse.json({ error: 'Failed to generate key' }, { status: 500 })
        }

        const label = KIND_NAME[kind]
        const message = isAdmin
            ? `${label} generated. Copy the key now — it will not be shown again.`
            : `${label} generated. Copy the key now — it will not be shown again. Awaiting admin approval.`

        // Full key returned ONCE — never stored in plaintext
        return NextResponse.json({
            success: true,
            message,
            key: fullKey,
            prefix: keyPrefix,
            status: keyStatus,
            kind,
        })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * Set or clear the webhook endpoint for one key.
 *
 * The signing secret is rotated on every set and returned exactly once, the same way
 * the key itself is. Sending webhook_url: null clears both.
 */
export async function PATCH(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const kind = parseKind(body?.kind)
        if (!kind) {
            return NextResponse.json({ error: 'kind must be "standard" or "commission"' }, { status: 400 })
        }

        const raw = body?.webhook_url
        let webhookUrl: string | null = null

        if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
            const candidate = String(raw).trim()
            let parsed: URL
            try { parsed = new URL(candidate) } catch {
                return NextResponse.json({ error: 'webhook_url must be a valid URL' }, { status: 400 })
            }
            // https only: the payload names a customer, an account number and an amount,
            // and it travels to a host we do not control.
            if (parsed.protocol !== 'https:') {
                return NextResponse.json({ error: 'webhook_url must use https' }, { status: 400 })
            }
            webhookUrl = parsed.toString()
        }

        const secret = webhookUrl ? randomBytes(24).toString('hex') : null

        const supabase = createServerClient()
        const { data: updated, error: updateError } = await (supabase.from('api_keys') as any)
            .update({ webhook_url: webhookUrl, webhook_secret: secret, updated_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .eq('kind', kind)
            .select('kind, webhook_url')
            .maybeSingle()

        if (updateError) {
            console.error('[API Keys] Webhook update error:', updateError)
            return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
        }
        if (!updated) {
            return NextResponse.json({ error: `No ${KIND_NAME[kind]} to configure. Generate one first.` }, { status: 404 })
        }

        return NextResponse.json({
            success: true,
            message: webhookUrl
                ? 'Webhook saved. Copy the signing secret now — it will not be shown again.'
                : 'Webhook removed.',
            webhook_url: webhookUrl,
            // Returned ONCE, like the key.
            webhook_secret: secret,
            kind,
        })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // Kind arrives on the query string: DELETE bodies are not reliably forwarded.
        const kind = parseKind(new URL(request.url).searchParams.get('kind') ?? undefined)
        if (!kind) {
            return NextResponse.json({ error: 'kind must be "standard" or "commission"' }, { status: 400 })
        }

        const supabase = createServerClient()
        await (supabase.from('api_keys') as any)
            .delete()
            .eq('user_id', user.id)
            .eq('kind', kind)

        return NextResponse.json({ success: true, message: `${KIND_NAME[kind]} revoked`, kind })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
