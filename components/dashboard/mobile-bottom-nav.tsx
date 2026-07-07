'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Wallet, Package, ClipboardList, Store, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePageAccess } from '@/hooks/use-page-access'

const leftItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/wallet', label: 'Top Up', icon: Wallet },
]

const rightItems = [
    { href: '/dashboard/my-orders', label: 'Orders', icon: ClipboardList },
    { href: '/dashboard/shop', label: 'My Shop', icon: Store },
]

export function MobileBottomNav() {
    const pathname = usePathname()
    const { isPageAccessible } = usePageAccess()
    const showBuyData = isPageAccessible('/dashboard/data-packages')

    const isActive = (href: string) => {
        if (href === '/dashboard') return pathname === '/dashboard'
        if (href === '/dashboard/shop') return pathname?.startsWith('/dashboard/shop')
        return pathname?.startsWith(href)
    }

    const buyDataActive = pathname?.startsWith('/dashboard/data-packages')

    return (
        <div className="fixed bottom-0 left-0 right-0 z-40 md:hidden">
            {/* Floating refresh button */}
            <button
                type="button"
                onClick={() => window.location.reload()}
                className="absolute -top-12 right-4 h-10 w-10 rounded-full bg-zinc-800 flex items-center justify-center shadow-lg text-white"
                aria-label="Refresh page"
            >
                <RefreshCw className="h-4 w-4" />
            </button>

            <div className="bg-zinc-900 px-2 pb-4 pt-2">
                <div className="flex items-end justify-around max-w-xl mx-auto relative">
                    {/* Left items */}
                    {leftItems.map((item) => {
                        const active = isActive(item.href)
                        const Icon = item.icon
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="flex flex-col items-center gap-1 min-w-[60px]"
                            >
                                <span
                                    className={cn(
                                        'flex flex-col items-center gap-1 rounded-2xl px-3 py-1.5 transition-colors',
                                        active
                                            ? 'bg-amber-400/20'
                                            : ''
                                    )}
                                >
                                    <Icon
                                        className={cn(
                                            'h-5 w-5',
                                            active ? 'text-amber-400' : 'text-zinc-400'
                                        )}
                                    />
                                    <span
                                        className={cn(
                                            'text-[10px] font-semibold leading-none',
                                            active ? 'text-amber-400' : 'text-zinc-400'
                                        )}
                                    >
                                        {item.label}
                                    </span>
                                </span>
                                {active && (
                                    <span className="h-1 w-1 rounded-full bg-amber-400" />
                                )}
                            </Link>
                        )
                    })}

                    {/* Center FAB — Buy Data (hidden when Data Packages access is off) */}
                    {showBuyData && (
                        <Link
                            href="/dashboard/data-packages"
                            className="flex flex-col items-center -mt-6 min-w-[64px]"
                        >
                            <span
                                className={cn(
                                    'h-14 w-14 rounded-full flex items-center justify-center shadow-lg mb-1 transition-transform active:scale-95',
                                    buyDataActive ? 'bg-amber-500' : 'bg-amber-400'
                                )}
                            >
                                <Package className="h-6 w-6 text-black" />
                            </span>
                            <span
                                className={cn(
                                    'text-[10px] font-semibold leading-none',
                                    buyDataActive ? 'text-amber-400' : 'text-zinc-400'
                                )}
                            >
                                Buy Data
                            </span>
                        </Link>
                    )}

                    {/* Right items */}
                    {rightItems.map((item) => {
                        const active = isActive(item.href)
                        const Icon = item.icon
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="flex flex-col items-center gap-1 min-w-[60px]"
                            >
                                <span
                                    className={cn(
                                        'flex flex-col items-center gap-1 rounded-2xl px-3 py-1.5 transition-colors',
                                        active ? 'bg-amber-400/20' : ''
                                    )}
                                >
                                    <Icon
                                        className={cn(
                                            'h-5 w-5',
                                            active ? 'text-amber-400' : 'text-zinc-400'
                                        )}
                                    />
                                    <span
                                        className={cn(
                                            'text-[10px] font-semibold leading-none',
                                            active ? 'text-amber-400' : 'text-zinc-400'
                                        )}
                                    >
                                        {item.label}
                                    </span>
                                </span>
                                {active && (
                                    <span className="h-1 w-1 rounded-full bg-amber-400" />
                                )}
                            </Link>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
