import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { z } from 'zod'

const cancelSchema = z.object({
    jobId: z.string().uuid(),
})

/**
 * Stops an unfinished broadcast. The job is marked 'failed' (the status CHECK
 * has no 'cancelled'), and the processor's claim only takes pending/processing
 * jobs, so it stops before the next batch. A batch already in flight still
 * finishes — at most one batch (100 on Moolre) goes out after this.
 */
export async function POST(request: NextRequest) {
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

        const parsed = cancelSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) {
            return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
        }
        const { jobId } = parsed.data

        const supabase = createServerClient()
        const { data: job } = await (supabase
            .from('sms_broadcast_jobs') as any)
            .select('id, status, errors')
            .eq('id', jobId)
            .single()

        if (!job) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 })
        }
        if (job.status !== 'pending' && job.status !== 'processing') {
            return NextResponse.json({ success: true, alreadyFinished: true })
        }

        const now = new Date().toISOString()
        const { error } = await (supabase.from('sms_broadcast_jobs') as any)
            .update({
                status: 'failed',
                completed_at: now,
                updated_at: now,
                errors: [...(job.errors || []), 'Admin: Cancelled by admin'],
            })
            .eq('id', jobId)
            .in('status', ['pending', 'processing'])

        if (error) {
            console.error('[SMSBroadcastCancel] Failed to cancel job:', jobId, error)
            return NextResponse.json({ error: 'Failed to cancel broadcast' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[SMSBroadcastCancel] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
