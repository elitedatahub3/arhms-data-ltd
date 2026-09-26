import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { DATA_NETWORKS } from '@/lib/api-v2-networks'

/**
 * Discovery endpoint: what can be bought, and at what price for THIS caller.
 *
 * v1 had no equivalent, so an integrator's only way to learn a valid
 * network/size pair was to guess and read the 404. Prices are role-resolved here for
 * the same reason /data/purchase resolves them server-side — an agent and a customer
 * pay different amounts for the same package.
 */
const ENDPOINT = '/api/v2/packages'

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'standard' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'balance')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth
    const { searchParams } = new URL(request.url)

    const network = searchParams.get('network')
    const sizeGb = searchParams.get('size_gb')

    if (network && !(DATA_NETWORKS as readonly string[]).includes(network)) {
        return apiError(400, `Invalid network filter. Must be one of: ${DATA_NETWORKS.join(', ')}`)
    }

    let query = (supabase.from('data_packages') as any)
        .select('id, network, size, price, agent_price')
        .eq('is_available', true)
        .order('network', { ascending: true })

    if (network) query = query.eq('network', network)

    const { data: packages, error } = await query

    if (error) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: error.message })
        return apiError(500, 'Failed to load packages')
    }

    // Same rule as /data/purchase: agent pricing only while the agent subscription
    // is live, so a lapsed agent is quoted what they will actually be charged.
    const { data: userExpiry } = await supabase
        .from('users')
        .select('agent_expires_at')
        .eq('id', userId)
        .single()

    const agentExpired = (userExpiry as any)?.agent_expires_at
        && new Date((userExpiry as any).agent_expires_at) < new Date()
    const isActiveAgent = userRole === 'agent' && !agentExpired

    const parseVolume = (size: string): number | null => {
        const match = String(size).match(/([\d.]+)/)
        if (!match) return null
        const n = Number(match[1])
        return Number.isFinite(n) ? n : null
    }

    let rows = ((packages as any[]) || []).map((p: any) => ({
        id:        p.id,
        network:   p.network,
        size:      p.size,
        volume_gb: parseVolume(p.size),
        price:     isActiveAgent && p.agent_price > 0 ? p.agent_price : p.price,
        currency:  'GHS',
    }))

    // Filtered after mapping because volume_gb is derived from the size string; there
    // is no numeric column on data_packages to filter on in SQL.
    if (sizeGb !== null && sizeGb !== '') {
        const wanted = Number(sizeGb)
        if (!Number.isFinite(wanted)) return apiError(400, 'size_gb must be a number')
        rows = rows.filter(r => r.volume_gb === wanted)
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({ packages: rows, total: rows.length })
}
