import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { handleCreate, handleQuote, internalTokenValid } from '@/lib/ussd-utilities-server'

/**
 * Utility bills over USSD: the Node-side route the edge USSD route calls.
 *
 * Not a public API. The only caller is app/api/hubtel/interact, which proves itself with a
 * token derived from the service-role key (internalTokenValid), and which names a SESSION —
 * never a user or a wallet — so a request cannot reach anyone's account but the caller's.
 * See lib/ussd-utilities-server.ts for what each action does and lib/ussd-utilities.ts for
 * why this is split from the edge route at all.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// The provider is given ~5s on a keypress; this leaves room around it.
export const maxDuration = 15

export async function POST(request: NextRequest) {
    if (!internalTokenValid(request.headers.get('x-ussd-internal'))) {
        return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
    }

    try {
        const db = createServerClient() as any
        if (body?.action === 'quote') return NextResponse.json(await handleQuote(db, body))
        if (body?.action === 'create') return NextResponse.json(await handleCreate(db, body))
        return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
    } catch (error: any) {
        console.error('[UssdUtilities] Unhandled error:', error)
        return NextResponse.json({ ok: false, field: 'fatal', error: 'System busy. Please try again.' })
    }
}
