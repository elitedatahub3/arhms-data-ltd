'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'

interface Contact {
    name: string | null
    phone: string | null
}

/**
 * "Need help? Contact your Lead" for sub-agents. Renders nothing for anyone
 * else. The phone only arrives when it is a real number — the API drops the
 * placeholder Google signups carry.
 */
export function SubAgentHelpCard() {
    const { isSubAgent } = useAuth()
    const [contact, setContact] = useState<Contact | null>(null)

    useEffect(() => {
        if (!isSubAgent) return
        let active = true
        fetch('/api/dashboard/sub/data')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!active || !d?.uplineShop) return
                setContact({
                    name: d.uplineShop.contactName || d.uplineShop.shopName || null,
                    phone: d.uplineShop.contactPhone || null,
                })
            })
            .catch(() => {})
        return () => { active = false }
    }, [isSubAgent])

    if (!isSubAgent || !contact || (!contact.name && !contact.phone)) return null

    return (
        <div className="rounded-xl bg-secondary/40 border border-border/60 p-4 text-center text-sm text-muted-foreground">
            <p>Need help? Contact your Lead</p>
            {contact.name && <p className="font-semibold text-foreground">{contact.name}</p>}
            {contact.phone && <p className="font-semibold text-foreground">{contact.phone}</p>}
        </div>
    )
}
