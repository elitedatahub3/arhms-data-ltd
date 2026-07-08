'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { SellButton } from '@/components/classifieds/sell-button'
import {
    User as UserIcon,
    Bookmark,
    MessageSquare,
    ShoppingBag,
    Store,
    LogOut,
    ChevronRight,
    Phone,
    Mail,
    Loader2,
} from 'lucide-react'

/**
 * Profile tab (bottom-nav "Profile").
 *
 * Mobile-first account hub: identity card, quick links to the other buyer
 * surfaces, seller entry point, theme toggle, and sign-out. Standalone page
 * (no sidebar) so the marketplace bottom nav owns navigation.
 */
export default function ProfilePage() {
    const router = useRouter()
    const { dbUser, isLoading, isSeller, signOut } = useAuth()

    const fullName =
        [dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ').trim() || 'Guest'
    const initials =
        (dbUser?.first_name?.[0] ?? '') + (dbUser?.last_name?.[0] ?? '') || 'G'

    const handleSignOut = async () => {
        await signOut()
        router.push('/classifieds')
    }

    if (isLoading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" />
            </div>
        )
    }

    // Logged-out state.
    if (!dbUser) {
        return (
            <div className="mx-auto min-h-screen max-w-3xl px-4 py-6">
                <div className="rounded-2xl border border-gray-100 bg-white p-12 text-center dark:border-gray-800 dark:bg-[#151c2c]">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20">
                        <UserIcon className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h2 className="mb-2 text-xl font-bold text-gray-900 dark:text-white">
                        You&apos;re not signed in
                    </h2>
                    <p className="mx-auto mb-6 max-w-sm text-gray-600 dark:text-gray-400">
                        Log in to manage your saved items, messages and listings.
                    </p>
                    <div className="flex items-center justify-center gap-3">
                        <Link href="/classifieds/auth/login?redirect=/classifieds/buyer/profile">
                            <Button className="bg-emerald-600 hover:bg-emerald-700">Log in</Button>
                        </Link>
                        <ThemeToggle />
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="mx-auto min-h-screen max-w-3xl px-4 py-6">
            {/* Identity card */}
            <div className="mb-6 flex items-center gap-4 rounded-2xl border border-gray-100 bg-white p-5 dark:border-gray-800 dark:bg-[#151c2c]">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-xl font-black uppercase text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    {initials}
                </span>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-xl font-black text-gray-900 dark:text-white">
                        {fullName}
                    </h1>
                    {dbUser.phone_number && (
                        <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-gray-500 dark:text-gray-400">
                            <Phone className="h-3.5 w-3.5 flex-shrink-0" />
                            {dbUser.phone_number}
                        </p>
                    )}
                    {dbUser.email && (
                        <p className="flex items-center gap-1.5 truncate text-sm text-gray-500 dark:text-gray-400">
                            <Mail className="h-3.5 w-3.5 flex-shrink-0" />
                            {dbUser.email}
                        </p>
                    )}
                </div>
                <ThemeToggle />
            </div>

            {/* Seller entry point */}
            <div className="mb-6">
                {isSeller ? (
                    <Link
                        href="/classifieds/seller/dashboard"
                        className="flex items-center gap-3 rounded-2xl bg-emerald-600 p-4 text-white transition-transform active:scale-[0.98]"
                    >
                        <Store className="h-5 w-5" />
                        <span className="flex-1 font-bold">Go to Seller Dashboard</span>
                        <ChevronRight className="h-5 w-5" />
                    </Link>
                ) : (
                    <SellButton className="flex w-full items-center gap-3 rounded-2xl bg-emerald-600 p-4 font-bold text-white hover:bg-emerald-700 active:scale-[0.98]">
                        <Store className="h-5 w-5" />
                        <span className="flex-1 text-left">Start selling</span>
                        <ChevronRight className="h-5 w-5" />
                    </SellButton>
                )}
            </div>

            {/* Quick links */}
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-[#151c2c]">
                <ProfileLink href="/classifieds/buyer/favorites" icon={Bookmark} label="Saved items" />
                <ProfileLink href="/classifieds/buyer/messages" icon={MessageSquare} label="Messages" />
                <ProfileLink
                    href="/classifieds/buyer/dashboard/purchases"
                    icon={ShoppingBag}
                    label="Purchases"
                    last
                />
            </div>

            {/* Sign out */}
            <button
                type="button"
                onClick={handleSignOut}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl border border-red-200 bg-red-50 py-3.5 font-semibold text-red-600 transition-colors hover:bg-red-100 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30"
            >
                <LogOut className="h-4 w-4" />
                Sign out
            </button>
        </div>
    )
}

function ProfileLink({
    href,
    icon: Icon,
    label,
    last,
}: {
    href: string
    icon: typeof Bookmark
    label: string
    last?: boolean
}) {
    return (
        <Link
            href={href}
            className={`flex items-center gap-3 px-5 py-4 transition-colors hover:bg-gray-50 dark:hover:bg-white/5 ${
                last ? '' : 'border-b border-gray-100 dark:border-gray-800'
            }`}
        >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
                <Icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </span>
            <span className="flex-1 font-medium text-gray-800 dark:text-gray-200">{label}</span>
            <ChevronRight className="h-5 w-5 text-gray-300 dark:text-gray-600" />
        </Link>
    )
}
