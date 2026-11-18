/**
 * Static help text ARHMS AI quotes from (get_help tool). Written from the old
 * keyword bot (app/api/support-chat/route.ts), the dashboard tutorials and the
 * MTN registration gate. Keep it factual: the assistant repeats it to users.
 */
import { REGISTRATION_WAIT_TEXT } from '@/lib/mtn-registration-gate'

export const HELP_TOPICS = [
    'buy_data',
    'fund_wallet',
    'failed_order',
    'refund',
    'delivery_time',
    'mtn_registration',
    'become_agent',
    'airtime',
    'afa',
    'results_checker',
    'shop',
    'contact_support',
] as const

export type HelpTopic = (typeof HELP_TOPICS)[number]

const HELP: Record<HelpTopic, string> = {
    buy_data:
        "Open Data Packages from the menu, pick the network, tap a bundle, enter the recipient's number and pay from your wallet or with Mobile Money (Direct Pay). You can also buy for many numbers at once with Bulk Order on the same page.",
    fund_wallet:
        'Open Wallet, tap Fund Wallet / Top Up, enter the amount and approve the Mobile Money prompt on your phone. The balance updates once the payment is confirmed; MTN MoMo can take a few minutes to confirm.',
    failed_order:
        'An order can fail when the network is having issues, the number is wrong or not eligible, or the supplier refuses it. A failed order that was paid from the wallet is refunded to the wallet. Check the status in My Orders.',
    refund:
        'Failed wallet orders are refunded to your ARHMS wallet automatically. If an order shows Failed but the money is not back after a few minutes, contact support on WhatsApp with the order reference.',
    delivery_time:
        'Most bundles arrive within minutes. At busy times, or when a network is slow, it can take longer. The live Delivery Status on the dashboard shows current delivery times per network. If it has been much longer than usual, contact support with the order reference.',
    mtn_registration:
        `Some MTN numbers are not yet registered for data bundles. When that happens the buy page warns you before paying; you can still continue, but the bundle may only arrive once the number is registered, which can take ${REGISTRATION_WAIT_TEXT}.`,
    become_agent:
        'Agents and dealers buy at lower prices. Look for the Upgrade / Become an Agent option on the dashboard to see the current plans and prices.',
    airtime:
        'Open Airtime from the menu, choose the network, enter the number and amount, and pay from your wallet. A small fee is taken out of the amount.',
    afa:
        'MTN AFA registration is under AFA in the menu. Fill in the details from the Ghana Card and pay; the registration is processed by the team.',
    results_checker:
        'WASSCE/BECE results checker vouchers are sold under Results Checker in the menu. Pay from your wallet and the voucher appears on the page and in your orders.',
    shop:
        'Agents and dealers can open their own shop (storefront) with their own prices under Shop in the menu, and share the link with customers.',
    contact_support:
        'For anything ARHMS AI cannot solve, contact the ARHMS support team on WhatsApp.',
}

export function helpText(topic: HelpTopic): string {
    return HELP[topic]
}
