'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { normalizeWhatsAppNumber } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
    resolveProviderForScope,
    SCOPE_PROVIDERS,
    PROVIDER_LABEL,
    type PaymentProvider,
} from '@/lib/payment-provider'

export default function AdminSettingsPage() {
    const [settings, setSettings] = useState<any>({})
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    // Form states
    const [paystackFee, setPaystackFee] = useState('1.95')
    const [agentPaystackFee, setAgentPaystackFee] = useState('1.95')
    const [paystackMomoFee, setPaystackMomoFee] = useState('1.95')
    const [agentPaystackMomoFee, setAgentPaystackMomoFee] = useState('1.95')
    const [mtnAdjustment, setMtnAdjustment] = useState('0')
    const [agentUpgradePrice, setAgentUpgradePrice] = useState('100')
    const [afaPriceCustomer, setAfaPriceCustomer] = useState('15')
    const [afaPriceAgent, setAfaPriceAgent] = useState('15')
    const [afaPriceDealer, setAfaPriceDealer] = useState('15')
    const [storefrontAfaEnabled, setStorefrontAfaEnabled] = useState(false)
    const [dealerPromoEnabled, setDealerPromoEnabled] = useState(false)
    const [landingRcOnlyEnabled, setLandingRcOnlyEnabled] = useState(false)
    const [supportEmail, setSupportEmail] = useState('')
    const [guestStorefrontUrl, setGuestStorefrontUrl] = useState('')
    const [whatsappGroupLink, setWhatsappGroupLink] = useState('')
    const [whatsappChannelLink, setWhatsappChannelLink] = useState('')
    const [whatsappAdminNumber, setWhatsappAdminNumber] = useState('')
    const [whatsappCommunityLink, setWhatsappCommunityLink] = useState('')
    const [footerCopyrightText, setFooterCopyrightText] = useState('')
    const [footerBrandingText, setFooterBrandingText] = useState('')
    const [autoFulfillment, setAutoFulfillment] = useState(true)
    const [smsProvider, setSmsProvider] = useState<'moolre' | 'hubtel'>('moolre')
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')
    const [shopPaymentProvider, setShopPaymentProvider] = useState<PaymentProvider>('moolre')
    // Seeded with the USSD scope's own fallback, not Moolre — Moolre has no USSD
    // branch, so showing it here would offer a gateway that cannot take the money.
    const [ussdPaymentProvider, setUssdPaymentProvider] = useState<PaymentProvider>('paystack_momo')
    const [rcWalletPaymentEnabled, setRcWalletPaymentEnabled] = useState(true)
    // Referral programme
    const [referralEnabled, setReferralEnabled] = useState(false)
    const [referralPercentOfSale, setReferralPercentOfSale] = useState('5')
    const [referralMaxMarginShare, setReferralMaxMarginShare] = useState('50')
    const [referralMinPlatformKeep, setReferralMinPlatformKeep] = useState('0.01')
    const [referralMaxClaimsPerDay, setReferralMaxClaimsPerDay] = useState('25')
    const [referralClawbackOnRefund, setReferralClawbackOnRefund] = useState(true)
    const [skipGoogleOauthOtp, setSkipGoogleOauthOtp] = useState(false)
    // Master switch. Starts closed to match isUssdEnabled(): if the row is
    // missing the service is off, and the toggle should say so.
    const [ussdEnabled, setUssdEnabled] = useState(false)
    const [ussdDialCode, setUssdDialCode] = useState('')
    const [ussdActivationPriceCustomer, setUssdActivationPriceCustomer] = useState('50')
    const [ussdActivationPriceAgent, setUssdActivationPriceAgent] = useState('40')
    const [ussdActivationPriceDealer, setUssdActivationPriceDealer] = useState('30')
    const [ussdActivationPriceSub, setUssdActivationPriceSub] = useState('40')
    const [storefrontUssdCard, setStorefrontUssdCard] = useState(true)

    // Page access states
    const [pageAccessDashboard, setPageAccessDashboard] = useState(true)
    const [pageAccessDataPackages, setPageAccessDataPackages] = useState(true)
    const [pageAccessOrders, setPageAccessOrders] = useState(true)
    const [pageAccessWallet, setPageAccessWallet] = useState(true)
    const [pageAccessComplaints, setPageAccessComplaints] = useState(true)
    const [pageAccessNotifications, setPageAccessNotifications] = useState(true)
    const [pageAccessProfile, setPageAccessProfile] = useState(true)
    const [pageAccessShop, setPageAccessShop] = useState(true)
    const [pageAccessStorefront, setPageAccessStorefront] = useState(true)
    const [pageAccessAirtime, setPageAccessAirtime] = useState(true)
    const [pageAccessUtilities, setPageAccessUtilities] = useState(true)
    const [hideMashup, setHideMashup] = useState(false)
    const [hideExpressMtn, setHideExpressMtn] = useState(false)
    const [hideStandardMtn, setHideStandardMtn] = useState(false)
    const [resultsCheckerOnly, setResultsCheckerOnly] = useState(false)

    useEffect(() => {
        fetchSettings()
    }, [])

    const fetchSettings = async () => {
        try {
            const { data, error } = await (supabase
                .from('admin_settings') as any)
                .select('*')

            if (error) throw error

            const settingsMap = data.reduce((acc: any, curr: any) => {
                acc[curr.key] = curr.value
                return acc
            }, {})

            setSettings(settingsMap)

            // Initialize form values
            setPaystackFee(settingsMap.paystack_fee_percent || '1.95')
            setAgentPaystackFee(settingsMap.agent_paystack_fee_percent || '1.95')
            // Fall back to the hosted-checkout figure rather than to 1.95, so the box
            // shows what the MoMo rail would actually charge today — lib/gateway-fees
            // resolves it the same way when the momo key is unset.
            setPaystackMomoFee(settingsMap.paystack_momo_fee_percent || settingsMap.paystack_fee_percent || '1.95')
            setAgentPaystackMomoFee(settingsMap.agent_paystack_momo_fee_percent || settingsMap.agent_paystack_fee_percent || '1.95')
            setMtnAdjustment(settingsMap.mtn_price_adjustment || '0')
            setAgentUpgradePrice(settingsMap.agent_upgrade_price || '100')
            setAfaPriceCustomer(settingsMap.afa_price_customer || '15')
            setAfaPriceAgent(settingsMap.afa_price_agent || '15')
            setAfaPriceDealer(settingsMap.afa_price_dealer || '15')
            setStorefrontAfaEnabled(settingsMap.storefront_afa_enabled === 'true')
            setUssdEnabled(settingsMap.ussd_enabled === 'true')
            setUssdDialCode(settingsMap.ussd_dial_code || '')
            setUssdActivationPriceCustomer(settingsMap.ussd_activation_price_customer || '50')
            setUssdActivationPriceAgent(settingsMap.ussd_activation_price_agent || '40')
            setUssdActivationPriceDealer(settingsMap.ussd_activation_price_dealer || '30')
            setUssdActivationPriceSub(settingsMap.ussd_activation_price_sub || '40')
            setStorefrontUssdCard(settingsMap.storefront_ussd_card_enabled !== 'false')
            setDealerPromoEnabled(settingsMap.dealer_promo_enabled === 'true')
            setLandingRcOnlyEnabled(settingsMap.landing_rc_only_enabled === 'true')
            setSupportEmail(settingsMap.support_email || '')
            setGuestStorefrontUrl(settingsMap.guest_storefront_url || `${process.env.NEXT_PUBLIC_APP_URL || ''}/shop/demo`)
            setWhatsappGroupLink(settingsMap.whatsapp_group_link || '')
            setWhatsappChannelLink(settingsMap.whatsapp_channel_link || '')
            setWhatsappAdminNumber(settingsMap.whatsapp_admin_number || '')
            setWhatsappCommunityLink(settingsMap.whatsapp_community_link || '')
            setFooterCopyrightText(settingsMap.footer_copyright_text || `2025 ARHMS TECHNOLOGIES`)
            setFooterBrandingText(settingsMap.footer_branding_text || 'ARHMS')
            setAutoFulfillment(String(settingsMap.auto_fulfillment_enabled) !== 'false')
            setSmsProvider(settingsMap.active_sms_provider === 'hubtel' ? 'hubtel' : 'moolre')
            setWebPaymentProvider(resolveProviderForScope(settingsMap.active_payment_provider_web, 'web'))
            setShopPaymentProvider(resolveProviderForScope(settingsMap.active_payment_provider_shop, 'shop'))
            setUssdPaymentProvider(resolveProviderForScope(settingsMap.active_payment_provider_ussd, 'ussd'))
            setSkipGoogleOauthOtp(settingsMap.skip_google_oauth_otp === 'true')
            setRcWalletPaymentEnabled(settingsMap.rc_wallet_payment_enabled !== 'false')

            // Referral programme. Defaults OFF — the kill switch is what makes the
            // rollout safe, so an unset value must never read as enabled.
            setReferralEnabled(settingsMap.referral_bonus_enabled === 'true')
            setReferralPercentOfSale(settingsMap.referral_bonus_percent_of_sale || '5')
            setReferralMaxMarginShare(settingsMap.referral_max_margin_share_percent || '50')
            setReferralMinPlatformKeep(settingsMap.referral_min_platform_keep || '0.01')
            setReferralMaxClaimsPerDay(settingsMap.referral_max_claims_per_day || '25')
            setReferralClawbackOnRefund(settingsMap.referral_clawback_on_refund !== 'false')

            // Initialize page access values
            setPageAccessDashboard(settingsMap.page_access_dashboard !== 'false')
            setPageAccessDataPackages(settingsMap.page_access_data_packages !== 'false')
            setPageAccessOrders(settingsMap.page_access_orders !== 'false')
            setPageAccessWallet(settingsMap.page_access_wallet !== 'false')
            setPageAccessComplaints(settingsMap.page_access_complaints !== 'false')
            setPageAccessNotifications(settingsMap.page_access_notifications !== 'false')
            setPageAccessProfile(settingsMap.page_access_profile !== 'false')
            setPageAccessShop(settingsMap.page_access_shop !== 'false')
            setPageAccessStorefront(settingsMap.page_access_storefront !== 'false')
            setPageAccessAirtime(settingsMap.page_access_airtime !== 'false')
            setPageAccessUtilities(settingsMap.page_access_utilities !== 'false')
            setHideMashup(settingsMap.special_mtn_mashup_hidden === 'true')
            setHideExpressMtn(settingsMap.express_mtn_hidden === 'true')
            setHideStandardMtn(settingsMap.standard_mtn_hidden === 'true')
            setResultsCheckerOnly(settingsMap.results_checker_only_mode === 'true')

        } catch (error) {
            console.error('Error fetching settings:', error)
            toast.error('Failed to load settings')
        } finally {
            setLoading(false)
        }
    }

    const saveSettings = async () => {
        setSaving(true)
        try {
            const updates = [
                { key: 'referral_bonus_enabled', value: String(referralEnabled) },
                { key: 'referral_bonus_percent_of_sale', value: referralPercentOfSale },
                { key: 'referral_max_margin_share_percent', value: referralMaxMarginShare },
                { key: 'referral_min_platform_keep', value: referralMinPlatformKeep },
                { key: 'referral_max_claims_per_day', value: referralMaxClaimsPerDay },
                { key: 'referral_clawback_on_refund', value: String(referralClawbackOnRefund) },
                { key: 'paystack_fee_percent', value: paystackFee },
                { key: 'agent_paystack_fee_percent', value: agentPaystackFee },
                { key: 'paystack_momo_fee_percent', value: paystackMomoFee },
                { key: 'agent_paystack_momo_fee_percent', value: agentPaystackMomoFee },
                { key: 'mtn_price_adjustment', value: mtnAdjustment },
                { key: 'agent_upgrade_price', value: agentUpgradePrice },
                { key: 'afa_price_customer', value: afaPriceCustomer },
                { key: 'afa_price_agent', value: afaPriceAgent },
                { key: 'afa_price_dealer', value: afaPriceDealer },
                { key: 'storefront_afa_enabled', value: String(storefrontAfaEnabled) },
                { key: 'dealer_promo_enabled', value: String(dealerPromoEnabled) },
                { key: 'landing_rc_only_enabled', value: String(landingRcOnlyEnabled) },
                { key: 'support_email', value: supportEmail },
                { key: 'guest_storefront_url', value: guestStorefrontUrl },
                { key: 'whatsapp_group_link', value: whatsappGroupLink },
                { key: 'whatsapp_channel_link', value: whatsappChannelLink },
                { key: 'whatsapp_admin_number', value: normalizeWhatsAppNumber(whatsappAdminNumber) },
                { key: 'whatsapp_community_link', value: whatsappCommunityLink },
                { key: 'footer_copyright_text', value: footerCopyrightText },
                { key: 'footer_branding_text', value: footerBrandingText },
                { key: 'auto_fulfillment_enabled', value: String(autoFulfillment) },
                { key: 'active_sms_provider', value: smsProvider },
                { key: 'active_payment_provider_web', value: webPaymentProvider },
                { key: 'active_payment_provider_shop', value: shopPaymentProvider },
                { key: 'active_payment_provider_ussd', value: ussdPaymentProvider },
                { key: 'rc_wallet_payment_enabled', value: String(rcWalletPaymentEnabled) },
                { key: 'skip_google_oauth_otp', value: String(skipGoogleOauthOtp) },
                // Page access settings
                { key: 'page_access_dashboard', value: String(pageAccessDashboard) },
                { key: 'page_access_data_packages', value: String(pageAccessDataPackages) },
                { key: 'page_access_orders', value: String(pageAccessOrders) },
                { key: 'page_access_wallet', value: String(pageAccessWallet) },
                { key: 'page_access_complaints', value: String(pageAccessComplaints) },
                { key: 'page_access_notifications', value: String(pageAccessNotifications) },
                { key: 'page_access_profile', value: String(pageAccessProfile) },
                { key: 'page_access_shop', value: String(pageAccessShop) },
                { key: 'page_access_storefront', value: String(pageAccessStorefront) },
                { key: 'page_access_airtime', value: String(pageAccessAirtime) },
                { key: 'page_access_utilities', value: String(pageAccessUtilities) },
                { key: 'special_mtn_mashup_hidden', value: String(hideMashup) },
                { key: 'express_mtn_hidden', value: String(hideExpressMtn) },
                { key: 'standard_mtn_hidden', value: String(hideStandardMtn) },
                { key: 'results_checker_only_mode', value: String(resultsCheckerOnly) },
                // USSD short codes
                { key: 'ussd_enabled', value: String(ussdEnabled) },
                { key: 'ussd_dial_code', value: ussdDialCode },
                { key: 'ussd_activation_price_customer', value: ussdActivationPriceCustomer },
                { key: 'ussd_activation_price_agent', value: ussdActivationPriceAgent },
                { key: 'ussd_activation_price_dealer', value: ussdActivationPriceDealer },
                { key: 'ussd_activation_price_sub', value: ussdActivationPriceSub },
                { key: 'storefront_ussd_card_enabled', value: String(storefrontUssdCard) },
            ]

            const response = await fetch('/api/admin-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates }),
            })

            if (!response.ok) {
                const data = await response.json().catch(() => null)
                throw new Error(data?.error || 'Failed to save settings')
            }
            toast.success('Settings saved successfully')
        } catch (error) {
            console.error('Error saving settings:', error)
            toast.error('Failed to save settings')
        } finally {
            setSaving(false)
        }
    }

    if (loading) {
        return <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>
    }

    return (
        <div className="space-y-6 max-w-4xl">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">System Settings</h1>
                    <p className="text-muted-foreground">Configure detailed platform parameters</p>
                </div>
                <Button onClick={saveSettings} disabled={saving}>
                    {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    <Save className="w-4 h-4 mr-2" />
                    Save Changes
                </Button>
            </div>

            <Tabs defaultValue="general">
                <TabsList>
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="fees">Fees &amp; Pricing</TabsTrigger>
                    <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
                    <TabsTrigger value="referrals">Referrals</TabsTrigger>
                    <TabsTrigger value="access">Page Access</TabsTrigger>
                </TabsList>

                <TabsContent value="general" className="space-y-4 mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Support Information</CardTitle>
                            <CardDescription>Contact details displayed to users</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Support Email</Label>
                                <Input
                                    value={supportEmail}
                                    onChange={(e) => setSupportEmail(e.target.value)}
                                    placeholder="support@ARHMSdataltd.com"
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Social Media & Community</CardTitle>
                            <CardDescription>Configure WhatsApp links and support contacts</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>WhatsApp Admin Number</Label>
                                <Input
                                    value={whatsappAdminNumber}
                                    onChange={(e) => setWhatsappAdminNumber(e.target.value)}
                                    placeholder="e.g. 0555123456 or 233555123456"
                                />
                                <p className="text-xs text-muted-foreground">This number will be used for direct support chats. It will be automatically normalized to international format (233...).</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>WhatsApp Group Link</Label>
                                    <Input
                                        value={whatsappGroupLink}
                                        onChange={(e) => setWhatsappGroupLink(e.target.value)}
                                        placeholder="https://chat.whatsapp.com/..."
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>WhatsApp Channel Link</Label>
                                    <Input
                                        value={whatsappChannelLink}
                                        onChange={(e) => setWhatsappChannelLink(e.target.value)}
                                        placeholder="https://whatsapp.com/channel/..."
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label>WhatsApp Community Link (Sidebar)</Label>
                                <Input
                                    value={whatsappCommunityLink}
                                    onChange={(e) => setWhatsappCommunityLink(e.target.value)}
                                    placeholder="https://chat.whatsapp.com/..."
                                />
                                <p className="text-xs text-muted-foreground">The "Join Community" link shown in the dashboard sidebar.</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Guest Storefront Configuration</CardTitle>
                            <CardDescription>Default shop users are directed to when buying as a guest without creating an account.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Guest Store URL</Label>
                                <Input
                                    value={guestStorefrontUrl}
                                    onChange={(e) => setGuestStorefrontUrl(e.target.value)}
                                    placeholder={`${process.env.NEXT_PUBLIC_APP_URL || ''}/shop/your-shop`}
                                />
                                <p className="text-xs text-muted-foreground">Changes to this link will instantly update the unauthenticated app pages.</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Homepage Mode</CardTitle>
                            <CardDescription>Control which landing page visitors see at the site root.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Results-Checker-only homepage</Label>
                                    <p className="text-sm text-muted-foreground">When ON, the homepage advertises only the Results Checker product. When OFF, the full ARHMS landing page is shown.</p>
                                </div>
                                <Switch checked={landingRcOnlyEnabled} onCheckedChange={setLandingRcOnlyEnabled} />
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Copyright & Branding</CardTitle>
                            <CardDescription>Configure the copyright text and "Powered by" labels used in footers.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Platform Copyright Text</Label>
                                <Input
                                    value={footerCopyrightText}
                                    onChange={(e) => setFooterCopyrightText(e.target.value)}
                                    placeholder="e.g. 2025 ARHMS DATA LIMITED"
                                />
                                <p className="text-xs text-muted-foreground">Used on Dashboard and Admin footer: © [Text]. All rights reserved.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Storefront Branding Label (Powered by)</Label>
                                <Input
                                    value={footerBrandingText}
                                    onChange={(e) => setFooterBrandingText(e.target.value)}
                                    placeholder="e.g. ARHMS"
                                />
                                <p className="text-xs text-muted-foreground">Plain text label shown on shop footers: Powered by [Text].</p>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="fees" className="space-y-4 mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Payment & Fees</CardTitle>
                            <CardDescription>Configure transaction fees</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Paystack Fee Percentage (%)</Label>
                                <Input
                                    type="number"
                                    value={paystackFee}
                                    onChange={(e) => setPaystackFee(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">Fee passed on to regular users during wallet top-up</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Paystack Fee Percentage (%)</Label>
                                <Input
                                    type="number"
                                    value={agentPaystackFee}
                                    onChange={(e) => setAgentPaystackFee(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">Fee passed on to AGENTS during wallet top-up</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Paystack MoMo Fee Percentage (%)</Label>
                                <Input
                                    type="number"
                                    value={paystackMomoFee}
                                    onChange={(e) => setPaystackMomoFee(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">Used when a scope is set to Paystack MoMo (the direct prompt). Leave blank to reuse the Paystack fee above.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Paystack MoMo Fee Percentage (%)</Label>
                                <Input
                                    type="number"
                                    value={agentPaystackMomoFee}
                                    onChange={(e) => setAgentPaystackMomoFee(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">The same, for AGENTS. Leave blank to reuse the Agent Paystack fee above.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>MTN Price Adjustment (GHS)</Label>
                                <Input
                                    type="number"
                                    value={mtnAdjustment}
                                    onChange={(e) => setMtnAdjustment(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">Additional markup fee for all MTN packages</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>USSD Short Codes</CardTitle>
                            <CardDescription>
                                Shops buy a one-time short code so customers can shop their storefront over USSD with no internet.
                                Prices are charged once, per role, and the code is theirs for life.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between rounded-lg border p-3">
                                <div className="space-y-0.5">
                                    <Label>USSD service enabled</Label>
                                    <p className="text-xs text-muted-foreground">
                                        Master switch. Off means callers who dial the code are told the service is
                                        unavailable and hung up on, no shop can buy a short code, and every USSD link
                                        and card disappears. Existing codes are kept, not cancelled — turning this back
                                        on restores them. Takes up to a minute to reach the dial-in service.
                                    </p>
                                </div>
                                <Switch checked={ussdEnabled} onCheckedChange={setUssdEnabled} />
                            </div>
                            <div className="space-y-2">
                                <Label>USSD Dial Code</Label>
                                <Input
                                    value={ussdDialCode}
                                    onChange={(e) => setUssdDialCode(e.target.value)}
                                    placeholder="*713*9863#"
                                />
                                <p className="text-xs text-muted-foreground">The number customers dial. Shown on every activated storefront.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Activation Price — Customer (GHS)</Label>
                                <Input
                                    type="number"
                                    value={ussdActivationPriceCustomer}
                                    onChange={(e) => setUssdActivationPriceCustomer(e.target.value)}
                                    step="0.01"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Activation Price — Agent (GHS)</Label>
                                <Input
                                    type="number"
                                    value={ussdActivationPriceAgent}
                                    onChange={(e) => setUssdActivationPriceAgent(e.target.value)}
                                    step="0.01"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Activation Price — Dealer (GHS)</Label>
                                <Input
                                    type="number"
                                    value={ussdActivationPriceDealer}
                                    onChange={(e) => setUssdActivationPriceDealer(e.target.value)}
                                    step="0.01"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Activation Price — Sub-Agent (GHS)</Label>
                                <Input
                                    type="number"
                                    value={ussdActivationPriceSub}
                                    onChange={(e) => setUssdActivationPriceSub(e.target.value)}
                                    step="0.01"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Charged to sub-agents instead of the customer price — a sub&apos;s account role is
                                    &quot;customer&quot;, so without this they would pay the top tier.
                                </p>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border p-3">
                                <div className="space-y-0.5">
                                    <Label>Show USSD card on storefronts</Label>
                                    <p className="text-xs text-muted-foreground">Hides the card everywhere without deactivating any shop&apos;s short code.</p>
                                </div>
                                <Switch checked={storefrontUssdCard} onCheckedChange={setStorefrontUssdCard} />
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Payment Gateway</CardTitle>
                            <CardDescription>Select the active payment provider for each transaction context. Changes take effect immediately — no redeployment needed.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Main Site Payments</Label>
                                    <p className="text-sm text-muted-foreground">Wallet top-ups, agent upgrades &amp; RC vouchers</p>
                                </div>
                                {/* Rendered from SCOPE_PROVIDERS so adding a gateway needs no
                                    change here — and so a scope can never offer a provider it
                                    has no branch for. */}
                                <div className="flex rounded-lg border overflow-hidden">
                                    {SCOPE_PROVIDERS.web.map((id, index) => (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setWebPaymentProvider(id)}
                                            className={cn(
                                                'px-4 py-2 text-sm font-medium transition-colors',
                                                index > 0 && 'border-l',
                                                webPaymentProvider === id
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-background hover:bg-muted text-foreground'
                                            )}
                                        >
                                            {PROVIDER_LABEL[id]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Results Checker — Allow Wallet Payment</Label>
                                    <p className="text-sm text-muted-foreground">When OFF, the wallet option is hidden on the Results Checker checkout page and users must pay directly via the active gateway.</p>
                                </div>
                                <Switch checked={rcWalletPaymentEnabled} onCheckedChange={setRcWalletPaymentEnabled} />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Shop Payments</Label>
                                    <p className="text-sm text-muted-foreground">Public storefront guest checkout orders</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    {SCOPE_PROVIDERS.shop.map((id, index) => (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setShopPaymentProvider(id)}
                                            className={cn(
                                                'px-4 py-2 text-sm font-medium transition-colors',
                                                index > 0 && 'border-l',
                                                shopPaymentProvider === id
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-background hover:bg-muted text-foreground'
                                            )}
                                        >
                                            {PROVIDER_LABEL[id]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* USSD offers only the two gateways that can complete a
                                dial-in sale. A hosted redirect cannot: there is no
                                browser on a USSD session. SCOPE_PROVIDERS.ussd is what
                                keeps that honest, and this control renders from it.
                                Selecting Hubtel here is the rollback to the AddToCart
                                path — it used to require editing the database by hand. */}
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">USSD Payments</Label>
                                    <p className="text-sm text-muted-foreground">Short-code dial-in sales and short-code activations</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    {SCOPE_PROVIDERS.ussd.map((id, index) => (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setUssdPaymentProvider(id)}
                                            className={cn(
                                                'px-4 py-2 text-sm font-medium transition-colors',
                                                index > 0 && 'border-l',
                                                ussdPaymentProvider === id
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-background hover:bg-muted text-foreground'
                                            )}
                                        >
                                            {PROVIDER_LABEL[id]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>AFA Application Pricing</CardTitle>
                            <CardDescription>Set application fees for Authorized Field Agent registrations</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Customer Application Fee (GHS)</Label>
                                <Input
                                    type="number"
                                    value={afaPriceCustomer}
                                    onChange={(e) => setAfaPriceCustomer(e.target.value)}
                                    step="0.01"
                                    min="0"
                                />
                                <p className="text-xs text-muted-foreground">Fee charged to customers for AFA application</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Application Fee (GHS)</Label>
                                <Input
                                    type="number"
                                    value={afaPriceAgent}
                                    onChange={(e) => setAfaPriceAgent(e.target.value)}
                                    step="0.01"
                                    min="0"
                                />
                                <p className="text-xs text-muted-foreground">Fee charged to agents for AFA application</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Dealer Application Fee (GHS)</Label>
                                <Input
                                    type="number"
                                    value={afaPriceDealer}
                                    onChange={(e) => setAfaPriceDealer(e.target.value)}
                                    step="0.01"
                                    min="0"
                                />
                                <p className="text-xs text-muted-foreground">Fee charged to dealers for AFA application</p>
                            </div>
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Sell AFA on Storefronts</Label>
                                    <p className="text-sm text-muted-foreground">
                                        When ON, shop owners can price AFA registration and sell it to guests on their storefront.
                                        Their cost is the role fee above; they keep the markup.
                                    </p>
                                </div>
                                <Switch checked={storefrontAfaEnabled} onCheckedChange={setStorefrontAfaEnabled} />
                            </div>
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Free Dealer Trial Promo</Label>
                                    <p className="text-sm text-muted-foreground">When ON, new users (registered after May 29 2026) can claim a free 1-month dealer trial</p>
                                </div>
                                <Switch checked={dealerPromoEnabled} onCheckedChange={setDealerPromoEnabled} />
                            </div>
                        </CardContent>
                    </Card>

                </TabsContent>

                <TabsContent value="fulfillment" className="space-y-4 mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Auto Fulfillment</CardTitle>
                            <CardDescription>Control automated order processing</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Enable Auto-Fulfillment</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Automatically process orders via APIs
                                    </p>
                                </div>
                                <Switch
                                    checked={autoFulfillment}
                                    onCheckedChange={setAutoFulfillment}
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>SMS Provider</CardTitle>
                            <CardDescription>Select the SMS gateway for all system notifications. Changes take effect immediately.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Active SMS Gateway</Label>
                                    <p className="text-sm text-muted-foreground">Order confirmations, wallet top-ups, upgrades, etc.</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setSmsProvider('moolre')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors',
                                            smsProvider === 'moolre'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Moolre
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSmsProvider('hubtel')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors border-l',
                                            smsProvider === 'hubtel'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Hubtel
                                    </button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Authentication</CardTitle>
                            <CardDescription>Manage user authentication flows</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Skip OTP for Google Sign-ins</Label>
                                    <p className="text-sm text-muted-foreground">
                                        When ON, users signing in with Google will still provide their phone number but bypass the SMS OTP verification step.
                                    </p>
                                </div>
                                <Switch
                                    checked={skipGoogleOauthOtp}
                                    onCheckedChange={setSkipGoogleOauthOtp}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="referrals" className="space-y-4 mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Referral Bonus Programme</CardTitle>
                            <CardDescription>
                                Users earn a share of every data purchase made by someone who signed up
                                through their referral link.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Referral Bonuses Enabled</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Master kill switch. Turning this OFF stops all new accruals immediately;
                                        bonuses already paid stay in users&apos; wallets.
                                    </p>
                                </div>
                                <Switch checked={referralEnabled} onCheckedChange={setReferralEnabled} />
                            </div>

                            <div className="space-y-2">
                                <Label>Bonus Rate (% of sale)</Label>
                                <Input
                                    type="number"
                                    value={referralPercentOfSale}
                                    onChange={(e) => setReferralPercentOfSale(e.target.value)}
                                    step="0.5"
                                    min="0"
                                    max="20"
                                />
                                <p className="text-xs text-muted-foreground">
                                    % of the amount the referred user pays. Advertised to users as
                                    &quot;up to&quot;, because the margin cap below can reduce it. Clamped to 0-20.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label>Maximum Share of Margin (%)</Label>
                                <Input
                                    type="number"
                                    value={referralMaxMarginShare}
                                    onChange={(e) => setReferralMaxMarginShare(e.target.value)}
                                    step="1"
                                    min="0"
                                    max="99"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Hard ceiling: a bonus can never exceed this share of an order&apos;s profit.
                                    This is what keeps the platform net-positive on every bonus it pays.
                                    <strong> Never set this to 100</strong> — see the migration header.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label>Minimum Platform Keep (GHS)</Label>
                                <Input
                                    type="number"
                                    value={referralMinPlatformKeep}
                                    onChange={(e) => setReferralMinPlatformKeep(e.target.value)}
                                    step="0.01"
                                    min="0"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Final backstop, applied after the margin cap. Normally inert.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label>Max New Referrals Per Day (per user)</Label>
                                <Input
                                    type="number"
                                    value={referralMaxClaimsPerDay}
                                    onChange={(e) => setReferralMaxClaimsPerDay(e.target.value)}
                                    step="1"
                                    min="0"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Signups beyond this are attributed but flagged for review. This caps
                                    sign-ups only — it never caps how much an existing referral can earn.
                                </p>
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Claw Back On Refund</Label>
                                    <p className="text-sm text-muted-foreground">
                                        When an order is refunded, reverse the bonus it paid. A referrer who
                                        already spent it is never pushed negative.
                                    </p>
                                </div>
                                <Switch
                                    checked={referralClawbackOnRefund}
                                    onCheckedChange={setReferralClawbackOnRefund}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="access" className="space-y-4 mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Page Access Control</CardTitle>
                            <CardDescription>
                                Control which pages are accessible to non-admin users (customers, agents, sub-admins).
                                Admins always have full access. Disabled pages will be hidden from navigation and blocked if accessed directly.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Dashboard/Home</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Main dashboard page
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessDashboard}
                                    onCheckedChange={setPageAccessDashboard}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Data Packages</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Browse and purchase data packages
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessDataPackages}
                                    onCheckedChange={setPageAccessDataPackages}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Orders</Label>
                                    <p className="text-sm text-muted-foreground">
                                        View order history and status
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessOrders}
                                    onCheckedChange={setPageAccessOrders}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Wallet</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Wallet balance and top-up functionality
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessWallet}
                                    onCheckedChange={setPageAccessWallet}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Complaints</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Submit and view complaints
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessComplaints}
                                    onCheckedChange={setPageAccessComplaints}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Notifications</Label>
                                    <p className="text-sm text-muted-foreground">
                                        View system notifications
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessNotifications}
                                    onCheckedChange={setPageAccessNotifications}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Profile</Label>
                                    <p className="text-sm text-muted-foreground">
                                        User profile and settings
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessProfile}
                                    onCheckedChange={setPageAccessProfile}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-emerald-600 dark:text-emerald-500 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-store"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" /><path d="M4 12v8a2 2 0 0 0 2 2h2" /><path d="M20 12v8a2 2 0 0 1-2 2h-2" /><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" /><path d="M2 7h20" /><path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7" /></svg>
                                        Dashboard Shop Management
                                    </Label>
                                    <p className="text-sm text-muted-foreground">
                                        Agent access to their shop settings, pricing, and orders dashboard
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessShop}
                                    onCheckedChange={setPageAccessShop}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.63 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.53 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6 6l.72-.72a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21 15.29"/></svg>
                                        Buy Airtime
                                    </Label>
                                    <p className="text-sm text-muted-foreground">
                                        Allow users to purchase airtime for MTN, Telecel, and AT networks
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessAirtime}
                                    onCheckedChange={setPageAccessAirtime}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/></svg>
                                        Pay Bills (Utilities)
                                    </Label>
                                    <p className="text-sm text-muted-foreground">
                                        Allow users to pay DSTV, GOtv, StarTimes, ECG and Ghana Water bills
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessUtilities}
                                    onCheckedChange={setPageAccessUtilities}
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg border-yellow-100 dark:border-yellow-900 bg-yellow-50/50 dark:bg-yellow-900/10">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-yellow-700 dark:text-yellow-400 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                                        Hide Special MTN Mashup
                                    </Label>
                                    <p className="text-sm text-yellow-700/60 dark:text-yellow-300/60 font-medium">
                                        When ON, the "Special MTN Mashup" category is hidden from both the main site and all storefronts
                                    </p>
                                </div>
                                <Switch
                                    checked={hideMashup}
                                    onCheckedChange={setHideMashup}
                                    className="data-[state=checked]:bg-yellow-500"
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg border-orange-100 dark:border-orange-900 bg-orange-50/50 dark:bg-orange-900/10">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-orange-700 dark:text-orange-400 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                        Hide EXPRESS MTN
                                    </Label>
                                    <p className="text-sm text-orange-700/60 dark:text-orange-300/60 font-medium">
                                        When ON, the "EXPRESS MTN" category is hidden from both the main site and all storefronts
                                    </p>
                                </div>
                                <Switch
                                    checked={hideExpressMtn}
                                    onCheckedChange={setHideExpressMtn}
                                    className="data-[state=checked]:bg-orange-500"
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg border-blue-100 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-900/10">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-blue-700 dark:text-blue-400 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                                        Hide Standard MTN
                                    </Label>
                                    <p className="text-sm text-blue-700/60 dark:text-blue-300/60 font-medium">
                                        When ON, the standard "MTN" category is hidden from both the main site and all storefronts
                                    </p>
                                </div>
                                <Switch
                                    checked={hideStandardMtn}
                                    onCheckedChange={setHideStandardMtn}
                                    className="data-[state=checked]:bg-blue-500"
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg border-purple-100 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-900/10">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-purple-700 dark:text-purple-400 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                                        Results Checker Only Mode
                                    </Label>
                                    <p className="text-sm text-purple-700/60 dark:text-purple-300/60 font-medium">
                                        When ON, every user's dashboard sidebar shows only the Results Checker link — all other menus (profile, My Shop, admin) are hidden
                                    </p>
                                </div>
                                <Switch
                                    checked={resultsCheckerOnly}
                                    onCheckedChange={setResultsCheckerOnly}
                                    className="data-[state=checked]:bg-purple-500"
                                />
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg border-emerald-100 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-900/10">
                                <div className="space-y-0.5">
                                    <Label className="text-base text-emerald-600 dark:text-emerald-500 font-bold flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-store"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" /><path d="M4 12v8a2 2 0 0 0 2 2h2" /><path d="M20 12v8a2 2 0 0 1-2 2h-2" /><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" /><path d="M2 7h20" /><path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7" /></svg>
                                        Public Shop Storefront
                                    </Label>
                                    <p className="text-sm text-emerald-700/70 dark:text-emerald-300/70 font-medium">
                                        Public access to visit shop links and purchase data (disabling this takes shops offline)
                                    </p>
                                </div>
                                <Switch
                                    checked={pageAccessStorefront}
                                    onCheckedChange={setPageAccessStorefront}
                                    className="data-[state=checked]:bg-emerald-500"
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
