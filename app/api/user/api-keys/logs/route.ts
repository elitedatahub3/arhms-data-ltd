import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()

        const { data: logs } = await (supabase.from('api_logs') as any)
            .select('id, endpoint, method, status_code, response_time_ms, ip_address, error_message, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(20)

        // Counted server-side rather than derived from the 20 rows above: a success
        // rate computed from one page of recent calls is not the account's success rate,
        // and the header-only count costs nothing to fetch.
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const countOf = async (build: (q: any) => any) => {
            const { count } = await build(
                (supabase.from('api_logs') as any)
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', user.id)
            )
            return count ?? 0
        }

        const [total, failed, last24h] = await Promise.all([
            countOf((q: any) => q),
            countOf((q: any) => q.gte('status_code', 400)),
            countOf((q: any) => q.gte('created_at', since)),
        ])

        return NextResponse.json({
            success: true,
            data: {
                logs: logs || [],
                usage: {
                    total,
                    failed,
                    succeeded: total - failed,
                    last24h,
                    // null rather than 100% when nothing has been called: a success rate
                    // with no calls behind it reads as a green light that was never earned.
                    successRate: total > 0 ? Math.round(((total - failed) / total) * 1000) / 10 : null,
                    lastCallAt: (logs as any[])?.[0]?.created_at ?? null,
                },
            },
        })
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
