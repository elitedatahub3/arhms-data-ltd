import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { kickSmsBroadcast, SMS_BROADCAST_STALL_MS } from '@/lib/sms-broadcast-kick'

/**
 * The batch chain has no supervisor of its own: one lost hop and the job sits
 * still forever. The admin page polls here every 2s while a broadcast runs, so
 * this is where a stall gets noticed and the processor restarted. Safe to call
 * repeatedly — the processor claims each batch, so a restart racing a live hop
 * backs off instead of texting anyone twice.
 */
function restartIfStalled(request: NextRequest, job: any): void {
    if (job.status !== 'pending' && job.status !== 'processing') return
    const lastMove = new Date(job.updated_at || job.created_at).getTime()
    if (!Number.isFinite(lastMove) || Date.now() - lastMove < SMS_BROADCAST_STALL_MS) return
    console.warn('[SMSBroadcastStatus] Job stalled, restarting:', job.id, `${job.sent_count}/${job.total}`)
    kickSmsBroadcast(request.nextUrl.origin, job.id, 'status-restart')
}

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!userData || (userData as any).role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin only' }, { status: 403 })
        }

        const supabase = createServerClient()
        const columns = 'id, status, total, sent_count, success_count, failed_count, errors, created_at, completed_at, updated_at'

        // ?active=1 — the most recent unfinished broadcast, so the page can offer
        // to resume or cancel it. Report only: the page asks this every time it
        // opens, and restarting here texted people from a page visit nobody meant
        // as a send. Restarts happen on the ?jobId= poll, which the page runs only
        // after the admin presses Send or Resume.
        if (request.nextUrl.searchParams.get('active') === '1') {
            const { data: active } = await (supabase
                .from('sms_broadcast_jobs') as any)
                .select(columns)
                .in('status', ['pending', 'processing'])
                .order('created_at', { ascending: false })
                .limit(1)
            const job = active?.[0] ?? null
            return NextResponse.json({ job })
        }

        const jobId = request.nextUrl.searchParams.get('jobId')
        if (!jobId) {
            return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
        }

        const { data: job, error } = await (supabase
            .from('sms_broadcast_jobs') as any)
            .select(columns)
            .eq('id', jobId)
            .single()

        if (error || !job) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 })
        }

        restartIfStalled(request, job)
        return NextResponse.json({ job })
    } catch (error: any) {
        console.error('[SMSBroadcastStatus] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
