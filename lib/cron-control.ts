import { NextResponse } from 'next/server'

export function areCronJobsEnabled() {
    return process.env.CRON_JOBS_ENABLED === 'true'
}

export function cronDisabledResponse() {
    return NextResponse.json(
        {
            disabled: true,
            message: 'Cron jobs are disabled by CRON_JOBS_ENABLED=false.',
        },
        {
            status: 200,
            headers: {
                'Cache-Control': 'private, no-store',
            },
        }
    )
}

/**
 * Validates that CRON_SECRET is set and has sufficient entropy.
 * Call this at the top of every cron route handler.
 * Throws an error (which produces a 500) if the secret is missing or too short.
 */
export function validateCronSecret(): void {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.trim().length < 32) {
        throw new Error(
            '[CronControl] CRON_SECRET must be at least 32 characters. ' +
            'Set a strong secret in your environment variables.'
        )
    }
}

/**
 * Validates authorization for a cron route.
 * Supports:
 *   - Header `Authorization: Bearer <CRON_SECRET>`
 *   - Query parameter `?secret=<CRON_SECRET>` or `?key=<CRON_SECRET>` (for cron-job.org and monitors)
 * Supports CRON_SECRET or UPSTASH_CRON_SECRET.
 */
export function isCronAuthorized(request: any): boolean {
    const secret = process.env.CRON_SECRET || process.env.UPSTASH_CRON_SECRET
    if (!secret) return false

    const authHeader = request.headers.get('authorization')
    if (authHeader === `Bearer ${secret}`) return true

    try {
        const url = request.nextUrl || new URL(request.url)
        const querySecret = url.searchParams.get('secret') || url.searchParams.get('key')
        if (querySecret && querySecret === secret) return true
    } catch {
        // url parsing fallback
    }

    return false
}

export function cronUnauthorizedResponse() {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

