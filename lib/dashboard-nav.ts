import {
    LayoutDashboard,
    Settings,
    Tag,
    ShoppingCart,
    ClipboardList,
    Smartphone,
    Banknote,
    Receipt,
    Crown,
    type LucideIcon,
} from 'lucide-react'

export interface NavItem {
    href: string
    label: string
    icon: LucideIcon
}

/**
 * Shop section links. Shared by the desktop sidebar and the mobile bottom nav's
 * Shop sub-menu so the two surfaces cannot drift apart.
 */
export const shopNavItems: NavItem[] = [
    { href: '/dashboard/shop', label: 'Overview', icon: LayoutDashboard },
    { href: '/dashboard/shop/setup', label: 'Shop Setup', icon: Settings },
    { href: '/dashboard/shop/pricing', label: 'Pricing', icon: Tag },
    { href: '/dashboard/shop/orders', label: 'Orders', icon: ShoppingCart },
    { href: '/dashboard/shop/utilities', label: 'Bill Payments', icon: Receipt },
    { href: '/dashboard/shop/ussd', label: 'USSD Code', icon: Smartphone },
    { href: '/dashboard/shop/withdraw', label: 'Withdraw', icon: Banknote },
]

/**
 * My Shop links for a sub-agent. A sub-agent's storefront lives under
 * /dashboard/sub/* (owner-approved withdrawals, upline-resolved pricing floor)
 * rather than the shop-owner model behind `shopNavItems`, so the hrefs differ —
 * there is no self-serve Setup or Withdraw page here; withdrawals are requested
 * from the sub's own dashboard home (/dashboard/sub).
 */
export const subShopNavItems: NavItem[] = [
    { href: '/dashboard/sub/shop', label: 'Overview', icon: LayoutDashboard },
    { href: '/dashboard/sub/pricing', label: 'Pricing', icon: Tag },
    { href: '/dashboard/sub/storefront-orders', label: 'Store Orders', icon: ClipboardList },
    { href: '/dashboard/sub/ussd', label: 'USSD Code', icon: Smartphone },
    { href: '/dashboard/sub/sub-agents', label: 'My Sub-Agents', icon: Crown },
]
