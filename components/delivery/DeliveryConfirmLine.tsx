'use client'

import { Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDeliveryStatus } from '@/hooks/use-delivery-status'
import { channelForNetwork, confirmText, isConfirmWorthy } from '@/lib/delivery-estimate'

/**
 * One muted line on a buy-confirm step. Renders nothing at all — no spinner,
 * no placeholder — unless the channel is live, fast and healthy.
 */
export function DeliveryConfirmLine({ network, className }: { network: string | null | undefined; className?: string }) {
    const channel = channelForNetwork(network)
    const { channels } = useDeliveryStatus({ enabled: !!channel })
    const est = channels?.find((c) => c.channel === channel)
    if (!channel || !isConfirmWorthy(est)) return null
    return (
        <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
            <Zap className="h-3.5 w-3.5 text-green-500" />
            {confirmText(est)}
        </p>
    )
}
