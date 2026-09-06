import {
    LayoutDashboard,
    Settings,
    Tag,
    ShoppingCart,
    Smartphone,
    Banknote,
    Receipt,
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
