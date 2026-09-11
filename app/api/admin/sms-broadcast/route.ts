import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { sendSMS } from '@/lib/sms-service'
import { fetchAllRows } from '@/lib/supabase-pagination'
import { z } from 'zod'
import { adminLongTextSchema } from '@/lib/validation'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Lazy-init so a missing env var or exhausted Redis limit does not crash the module
let broadcastRateLimit: Ratelimit | null = null
try {
    broadcastRateLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(5, '1 h'),
        prefix: 'rl:sms-broadcast',
    })
} catch (e) {
    console.error('[SMSBroadcast] Redis init failed — broadcast rate limit disabled:', e)
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if user is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!userData || (userData as any).role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin only' }, { status: 403 })
        }

        // Fail-open: if Redis is exhausted or unavailable, allow the broadcast through
        // rather than showing a confusing ERR max requests error to the admin.
        try {
            if (broadcastRateLimit) {
                const { success: rlOk } = await broadcastRateLimit.limit(authUser.id)
                if (!rlOk) {
                    return NextResponse.json({ error: 'Rate limit: max 5 broadcasts per hour' }, { status: 429 })
                }
            }
        } catch (rlErr) {
            // Redis limit exhausted or unavailable — log and continue (fail-open)
            console.error('[SMSBroadcast] Rate limit check failed (Redis exhausted?), proceeding:', rlErr)
        }

        const body = await request.json()
        const broadcastSchema = z.object({
            message: adminLongTextSchema,
            userIds: z.array(z.string()).max(20000).optional(),
            roleFilter: z.enum(['all', 'customer', 'sub-admin', 'admin', 'agent', 'dealer', 'shop_owner']).optional(),
        })
        
        const validation = broadcastSchema.safeParse(body)
        if (!validation.success) {
            return NextResponse.json({ error: 'Invalid input', details: validation.error.errors }, { status: 400 })
        }
        
        const { userIds, roleFilter, message } = validation.data

        if (!userIds && !roleFilter) {
            return NextResponse.json({ error: 'Either userIds or roleFilter is required' }, { status: 400 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Extract real user UUIDs vs shop IDs
        const realUserIds = userIds ? userIds.filter(id => !id.startsWith('shop_')) : []
        const shopIds = userIds ? userIds.filter(id => id.startsWith('shop_')).map(id => id.replace('shop_', '')) : []

        let recipients: any[] = []

        // Fetch from users table
        if (!userIds || realUserIds.length > 0 || (roleFilter && roleFilter !== 'all')) {
            let usersData: any[] = []
            
            if (userIds && realUserIds.length > 0) {
                // Chunk queries to avoid URI Too Long error
                const CHUNK_SIZE = 150
                for (let i = 0; i < realUserIds.length; i += CHUNK_SIZE) {
                    const chunk = realUserIds.slice(i, i + CHUNK_SIZE)
                    const { data, error } = await supabase
                        .from('users')
                        .select('id, first_name, phone_number, role')
                        .not('phone_number', 'is', null)
                        .in('id', chunk)
                    
                    if (error) {
                        console.error('[SMSBroadcast] Error fetching users chunk:', error)
                        return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 })
                    }
                    if (data) usersData.push(...(data as any[]))
                }
            } else {
                // Paged: an unbounded select stops at PostgREST's 1000-row cap, which would
                // silently drop every recipient past the first thousand from the broadcast.
                const { data, error } = await fetchAllRows<any>(() => {
                    let query = supabase
                        .from('users')
                        .select('id, first_name, phone_number, role')
                        .not('phone_number', 'is', null)
                        .order('id', { ascending: true })

                    if (roleFilter && roleFilter !== 'all' && roleFilter !== 'shop_owner') {
                        query = query.eq('role', roleFilter)
                    }

                    return query
                })
                if (error) {
                    console.error('[SMSBroadcast] Error fetching users:', error)
                    return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 })
                }
                if (data) usersData = data
            }
            
            if (usersData.length > 0 && roleFilter !== 'shop_owner') {
                recipients = [...recipients, ...usersData]
            }
        }

        // Fetch from shops table
        if ((userIds && shopIds.length > 0) || roleFilter === 'shop_owner' || roleFilter === 'all') {
            let shopsData: any[] = []
            
            if (userIds && shopIds.length > 0) {
                const CHUNK_SIZE = 150
                for (let i = 0; i < shopIds.length; i += CHUNK_SIZE) {
                    const chunk = shopIds.slice(i, i + CHUNK_SIZE)
                    const { data, error } = await supabase
                        .from('shop_profiles')
                        .select('id, shop_name, owner_phone')
                        .not('owner_phone', 'is', null)
                        .in('id', chunk)
                        
                    if (error) console.error('[SMSBroadcast] Error fetching shops chunk:', error)
                    if (data) shopsData.push(...(data as any[]))
                }
            } else {
                const { data, error } = await fetchAllRows<any>(() => supabase
                    .from('shop_profiles')
                    .select('id, shop_name, owner_phone')
                    .not('owner_phone', 'is', null)
                    .order('id', { ascending: true }))

                if (error) console.error('[SMSBroadcast] Error fetching shops:', error)
                if (data) shopsData = data
            }

            if (shopsData) {
                const mappedShops = (shopsData as any[]).map(s => ({
                    id: `shop_${s.id}`,
                    first_name: `Shop Owner (${s.shop_name})`,
                    phone_number: s.owner_phone,
                    role: 'shop_owner'
                }))
                
                // Deduplicate phones
                const existingPhones = new Set(recipients.map(r => r.phone_number.replace(/\s+/g, '')))
                const uniqueShops = mappedShops.filter(s => !existingPhones.has(s.phone_number.replace(/\s+/g, '')))
                
                recipients = [...recipients, ...uniqueShops]
            }
        }

        if (!recipients || recipients.length === 0) {
            return NextResponse.json({ error: 'No recipients found with valid phone numbers' }, { status: 400 })
        }

        // Send SMS to recipients

        // Send SMS in parallel batches of 10 to avoid Vercel timeout
        const results = {
            total: recipients.length,
            success: 0,
            failed: 0,
            errors: [] as string[]
        }

        const trimmedMessage = message.trim()
        const BATCH_SIZE = 10

        for (let i = 0; i < (recipients as any[]).length; i += BATCH_SIZE) {
            const batch = (recipients as any[]).slice(i, i + BATCH_SIZE)
            await Promise.allSettled(
                batch.map(async (recipient: any) => {
                    if (!recipient.phone_number) {
                        results.failed++
                        results.errors.push(`${recipient.first_name || 'Unknown'}: No phone number`)
                        return
                    }
                    try {
                        const result = await sendSMS({ recipient: recipient.phone_number, message: trimmedMessage })
                        if (result.success) {
                            results.success++
                        } else {
                            results.failed++
                            results.errors.push(`${recipient.first_name || 'Unknown'}: ${result.error}`)
                        }
                    } catch (err: any) {
                        results.failed++
                        results.errors.push(`${recipient.first_name || 'Unknown'}: ${err.message}`)
                    }
                })
            )
        }

        return NextResponse.json({
            success: true,
            results
        })
    } catch (error: any) {
        console.error('[SMSBroadcast] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
