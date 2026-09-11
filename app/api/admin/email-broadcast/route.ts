import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { sendEmail, generatePremiumTemplate } from '@/lib/email-service'
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
        prefix: 'rl:email-broadcast',
    })
} catch (e) {
    console.error('[EmailBroadcast] Redis init failed — broadcast rate limit disabled:', e)
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
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
        try {
            if (broadcastRateLimit) {
                const { success: rlOk } = await broadcastRateLimit.limit(authUser.id)
                if (!rlOk) {
                    return NextResponse.json({ error: 'Rate limit: max 5 broadcasts per hour' }, { status: 429 })
                }
            }
        } catch (rlErr) {
            console.error('[EmailBroadcast] Rate limit check failed (Redis exhausted?), proceeding:', rlErr)
        }

        const body = await request.json()
        const broadcastSchema = z.object({
            subject: z.string().min(1).max(255),
            message: adminLongTextSchema,
            userIds: z.array(z.string().uuid()).max(20000).optional(),
            roleFilter: z.enum(['all', 'customer', 'sub-admin', 'admin', 'agent', 'dealer']).optional(),
        })
        
        const validation = broadcastSchema.safeParse(body)
        if (!validation.success) {
            return NextResponse.json({ error: 'Invalid input', details: validation.error.errors }, { status: 400 })
        }
        
        const { userIds, roleFilter, subject, message } = validation.data

        if (!userIds && !roleFilter) {
            return NextResponse.json({ error: 'Either userIds or roleFilter is required' }, { status: 400 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Fetch recipients based on selection
        let recipientsRaw: any[] = []

        if (userIds && userIds.length > 0) {
            // Specific users selected (chunked to avoid URI Too Long errors on 1000+ users)
            const CHUNK_SIZE = 150
            for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
                const chunk = userIds.slice(i, i + CHUNK_SIZE)
                const { data, error } = await supabase
                    .from('users')
                    .select('id, first_name, email, role')
                    .not('email', 'is', null)
                    .in('id', chunk)
                    
                if (error) {
                    console.error('[EmailBroadcast] Error fetching recipients chunk:', error)
                    return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 })
                }
                if (data) recipientsRaw.push(...(data as any[]))
            }
        } else {
            // Paged: an unbounded select stops at PostgREST's 1000-row cap, which would
            // silently drop every recipient past the first thousand from the broadcast.
            const { data, error } = await fetchAllRows<any>(() => {
                let query = supabase
                    .from('users')
                    .select('id, first_name, email, role')
                    .not('email', 'is', null)
                    .order('id', { ascending: true })

                if (roleFilter && roleFilter !== 'all') {
                    // Filter by role
                    query = query.eq('role', roleFilter)
                }

                return query
            })
            if (error) {
                console.error('[EmailBroadcast] Error fetching recipients:', error)
                return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 })
            }
            if (data) recipientsRaw = data
        }

        const recipients = recipientsRaw as any[] | null

        if (!recipients || recipients.length === 0) {
            return NextResponse.json({ error: 'No recipients found with valid email addresses' }, { status: 400 })
        }

        // Create the email template content
        const emailContent = `
            <h1 class="greeting">${subject}</h1>
            <p class="message-text">
                ${message.replace(/\\n/g, '<br/>')}
            </p>
        `

        // Wrap with premium template
        const htmlContent = generatePremiumTemplate(subject, emailContent)

        // Send Email to each recipient
        const results = {
            total: recipients.length,
            success: 0,
            failed: 0,
            errors: [] as string[]
        }

        // To avoid rate limits, we could do this in chunks, but for < 500 we can just use Promise.all or a loop.
        // Let's use a loop to avoid hitting Brevo's concurrency limit too hard, or we can use Promise.all with chunks.
        for (const recipient of recipients as any[]) {
            if (!recipient.email) {
                results.failed++
                results.errors.push(`${recipient.first_name || 'Unknown'}: No email`)
                console.warn(`[EmailBroadcast] Skipping user ${recipient.first_name} - no email`)
                continue
            }

            try {
                const result = await sendEmail({
                    to: recipient.email,
                    toName: recipient.first_name || 'User',
                    subject: subject,
                    htmlContent: htmlContent
                })

                if (result.success) {
                    results.success++
                } else {
                    results.failed++
                    results.errors.push(`${recipient.first_name || 'Unknown'}: ${result.error}`)
                    console.error(`[EmailBroadcast] ❌ Failed for ${recipient.first_name}: ${result.error}`)
                }
            } catch (err: any) {
                results.failed++
                results.errors.push(`${recipient.first_name || 'Unknown'}: ${err.message}`)
                console.error(`[EmailBroadcast] ❌ Exception for ${recipient.first_name}:`, err)
            }
            
            // Sleep briefly to avoid rate limiting
            await new Promise(r => setTimeout(r, 50))
        }

        return NextResponse.json({
            success: true,
            results
        })
    } catch (error: any) {
        console.error('[EmailBroadcast] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
