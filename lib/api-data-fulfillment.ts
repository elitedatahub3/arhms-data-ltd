/**
 * Auto-fulfilment for a data order placed over the developer API.
 *
 * Lifted verbatim out of app/api/v1/data/purchase/route.ts when v2 arrived, because
 * the alternative was two copies of the supplier matrix below — and the moment a
 * seventh supplier is added, one of them is wrong. Same reasoning as
 * lib/airtime-order-completion.ts: one implementation, several callers.
 *
 * MUST be awaited by the route, not fired and forgotten. Vercel kills async work the
 * instant the HTTP response is sent, so a backgrounded dispatch here silently leaves
 * every API order sitting at 'pending'.
 */
import type { createServerClient } from '@/lib/supabase'

type Supabase = ReturnType<typeof createServerClient>

type FulfillFn = (
    network: string, recipient: string, size: string, orderId: string
) => Promise<{ success: boolean; transactionId?: string; reference?: string; error?: string }>

/**
 * The admin_settings flag naming each supplier's per-network opt-in, paired with the
 * loader for its service module.
 *
 * `load` is a thunk holding a literal import specifier rather than a module path in
 * the data: webpack resolves dynamic imports statically, and `import(someVariable)`
 * silently fails to bundle the target. The lazy loading is what keeps seven supplier
 * SDKs off the cold-start path of every route that touches this file.
 */
const SUPPLIERS: ReadonlyArray<{
    flag: string
    label: string
    refColumn: string
    load: () => Promise<{ fulfillOrder: FulfillFn }>
}> = [
    { flag: 'networks',             label: 'datakazina',  refColumn: 'dakazina_reference',    load: () => import('@/lib/fulfillment-service')  },
    { flag: 'codecraft_networks',   label: 'codecraft',   refColumn: 'codecraft_reference',   load: () => import('@/lib/codecraft-service')    },
    { flag: 'kingflexy_networks',   label: 'kingflexy',   refColumn: 'kingflexy_reference',   load: () => import('@/lib/kingflexy-service')    },
    { flag: 'eazydata_networks',    label: 'eazydata',    refColumn: 'eazydata_reference',    load: () => import('@/lib/eazydata-service')     },
    { flag: 'agentportal_networks', label: 'agentportal', refColumn: 'agentportal_reference', load: () => import('@/lib/agentportal-service')  },
    { flag: 'netpulse_networks',    label: 'netpulse',    refColumn: 'netpulse_reference',    load: () => import('@/lib/netpulse-service')     },
    { flag: 'hendylinks_networks',  label: 'hendylinks',  refColumn: 'hendylinks_reference',  load: () => import('@/lib/hendylinks-service')   },
]

export interface FulfillApiDataOrderParams {
    supabase: Supabase
    orderId: string
    network: string
    recipient: string
    size: string
    /** Tag for the console line, e.g. 'v2/purchase'. */
    logPrefix: string
}

/**
 * @returns 'processing' when a supplier accepted the order, 'pending' otherwise.
 *          Never throws — a fulfilment problem leaves the order in the admin queue,
 *          it does not fail a request the customer has already paid for.
 */
export async function fulfillApiDataOrder(
    params: FulfillApiDataOrderParams
): Promise<'pending' | 'processing'> {
    const { supabase, orderId, network, recipient, size, logPrefix } = params

    try {
        const { data: settingsData } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = ((settingsData as any[]) || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value; return acc
        }, {})

        if (String(settingsMap.auto_fulfillment_enabled) === 'false') return 'pending'

        let parsed: any = {}
        if (settingsMap.fulfillment_settings) {
            try {
                parsed = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
            } catch {
                // Malformed JSON leaves every flag unset, so nothing dispatches and the
                // order waits for an admin. Better than guessing a supplier.
                return 'pending'
            }
        }

        const active = SUPPLIERS.filter(s => (parsed?.[s.flag] || {})[network] === true)

        // Exactly one, or nothing. Two suppliers enabled for one network is a
        // misconfiguration, and picking one arbitrarily would send the bundle twice
        // the moment the admin notices and disables the wrong one.
        if (active.length !== 1) return 'pending'

        const supplier = active[0]
        const { fulfillOrder } = await supplier.load()
        const result = await fulfillOrder(network, recipient, size, orderId)

        if (!result.success) {
            console.error(`[${logPrefix}] Fulfillment failed for ${orderId}: ${result.error}`)
            return 'pending'
        }

        const orderUpdate: Record<string, any> = {
            status: 'processing',
            fulfillment_method: supplier.label,
            updated_at: new Date().toISOString(),
        }
        const ref = result.transactionId || result.reference
        if (ref) orderUpdate[supplier.refColumn] = ref

        await (supabase.from('orders') as any).update(orderUpdate).eq('id', orderId)
        return 'processing'
    } catch (e) {
        console.error(`[${logPrefix}] Fulfillment error:`, e)
        return 'pending'
    }
}
