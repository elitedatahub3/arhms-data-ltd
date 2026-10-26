import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'

/** Admin or sub-admin, same gate as /api/admin/airtime/*. */
export async function verifyBundlesAdmin(): Promise<{ userId: string } | null> {
    const userClient = await createRouteHandlerClient()
    const { data: { user }, error } = await userClient.auth.getUser()
    if (error || !user) return null
    const supabase = createServerClient() as any
    const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'sub-admin'].includes(data?.role)) return null
    return { userId: user.id }
}
