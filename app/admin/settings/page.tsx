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

export default function AdminSettingsPage() {
    const [settings, setSettings] = useState<any>({})
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    // Form states
    const [paystackFee, setPaystackFee] = useState('1.95')
    const [agentPaystackFee, setAgentPaystackFee] = useState('1.95')
    const [mtnAdjustment, setMtnAdjustment] = useState('0')
    const [agentUpgradePrice, setAgentUpgradePrice] = useState('100')
    const [afaPriceCustomer, setAfaPriceCustomer] = useState('15')
    const [afaPriceAgent, setAfaPriceAgent] = useState('15')
    const [afaPriceDealer, setAfaPriceDealer] = useState('15')
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
    const [webPaymentProvider, setWebPaymentProvider] = useState<'moolre' | 'paystack'>('moolre')
    const [shopPaymentProvider, setShopPaymentProvider] = useState<'moolre' | 'paystack'>('moolre')
    const [classifiedsPaymentProvider, setClassifiedsPaymentProvider] = useState<'moolre' | 'paystack'>('moolre')
    const [skipGoogleOauthOtp, setSkipGoogleOauthOtp] = useState(false)

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
            setMtnAdjustment(settingsMap.mtn_price_adjustment || '0')
            setAgentUpgradePrice(settingsMap.agent_upgrade_price || '100')
            setAfaPriceCustomer(settingsMap.afa_price_customer || '15')
            setAfaPriceAgent(settingsMap.afa_price_agent || '15')
            setAfaPriceDealer(settingsMap.afa_price_dealer || '15')
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
            const webProvider = String(settingsMap.active_payment_provider_web || 'moolre')
            const shopProvider = String(settingsMap.active_payment_provider_shop || 'moolre')
            const classifiedsProvider = String(settingsMap.active_payment_provider_classifieds || 'moolre')
            setWebPaymentProvider(webProvider === 'paystack' ? 'paystack' : 'moolre')
            setShopPaymentProvider(shopProvider === 'paystack' ? 'paystack' : 'moolre')
            setClassifiedsPaymentProvider(classifiedsProvider === 'paystack' ? 'paystack' : 'moolre')
            setSkipGoogleOauthOtp(settingsMap.skip_google_oauth_otp === 'true')

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
                { key: 'paystack_fee_percent', value: paystackFee },
                { key: 'agent_paystack_fee_percent', value: agentPaystackFee },
                { key: 'mtn_price_adjustment', value: mtnAdjustment },
                { key: 'agent_upgrade_price', value: agentUpgradePrice },
                { key: 'afa_price_customer', value: afaPriceCustomer },
                { key: 'afa_price_agent', value: afaPriceAgent },
                { key: 'afa_price_dealer', value: afaPriceDealer },
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
                { key: 'active_payment_provider_web', value: webPaymentProvider },
                { key: 'active_payment_provider_shop', value: shopPaymentProvider },
                { key: 'active_payment_provider_classifieds', value: classifiedsPaymentProvider },
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
                { key: 'special_mtn_mashup_hidden', value: String(hideMashup) },
                { key: 'express_mtn_hidden', value: String(hideExpressMtn) },
                { key: 'standard_mtn_hidden', value: String(hideStandardMtn) },
                { key: 'results_checker_only_mode', value: String(resultsCheckerOnly) },
                // Classifieds boost fees
                { key: 'classifieds_boost_fee_7d', value: settings['classifieds_boost_fee_7d'] || '' },
                { key: 'classifieds_boost_fee_14d', value: settings['classifieds_boost_fee_14d'] || '' },
                { key: 'classifieds_boost_fee_21d', value: settings['classifieds_boost_fee_21d'] || '' },
                { key: 'classifieds_boost_fee_30d', value: settings['classifieds_boost_fee_30d'] || '' },
                { key: 'classifieds_boost_fee_60d', value: settings['classifieds_boost_fee_60d'] || '' },
                { key: 'classifieds_boost_fee_90d', value: settings['classifieds_boost_fee_90d'] || '' },
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
                    <TabsTrigger value="classifieds">Classifieds</TabsTrigger>
                    <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
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
                            <CardTitle>Payment Gateway</CardTitle>
                            <CardDescription>Select the active payment provider for each transaction context. Changes take effect immediately — no redeployment needed.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Main Site Payments</Label>
                                    <p className="text-sm text-muted-foreground">Wallet top-ups, agent upgrades &amp; RC vouchers</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setWebPaymentProvider('moolre')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors',
                                            webPaymentProvider === 'moolre'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Moolre
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setWebPaymentProvider('paystack')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors border-l',
                                            webPaymentProvider === 'paystack'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Paystack
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Shop Payments</Label>
                                    <p className="text-sm text-muted-foreground">Public storefront guest checkout orders</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShopPaymentProvider('moolre')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors',
                                            shopPaymentProvider === 'moolre'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Moolre
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShopPaymentProvider('paystack')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors border-l',
                                            shopPaymentProvider === 'paystack'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Paystack
                                    </button>
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
                                    <Label className="text-base">Free Dealer Trial Promo</Label>
                                    <p className="text-sm text-muted-foreground">When ON, new users (registered after May 29 2026) can claim a free 1-month dealer trial</p>
                                </div>
                                <Switch checked={dealerPromoEnabled} onCheckedChange={setDealerPromoEnabled} />
                            </div>
                        </CardContent>
                    </Card>

                </TabsContent>

                {/* ── Classifieds Tab ── */}
                <TabsContent value="classifieds" className="space-y-4 mt-4">

                    {/* Boost Payment Gateway */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Boost Payment Gateway</CardTitle>
                            <CardDescription>Select the payment provider sellers use when paying to boost a listing. Changes take effect immediately — sellers will be charged directly (no wallet needed).</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 border rounded-lg">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Classifieds Boost Payments</Label>
                                    <p className="text-sm text-muted-foreground">Gateway used when sellers pay to boost their listings</p>
                                </div>
                                <div className="flex rounded-lg border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setClassifiedsPaymentProvider('moolre')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors',
                                            classifiedsPaymentProvider === 'moolre'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Moolre
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setClassifiedsPaymentProvider('paystack')}
                                        className={cn(
                                            'px-4 py-2 text-sm font-medium transition-colors border-l',
                                            classifiedsPaymentProvider === 'paystack'
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted text-foreground'
                                        )}
                                    >
                                        Paystack
                                    </button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Boost Fees */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Promotion Boost Fees</CardTitle>
                            <CardDescription>Set the GHS price sellers pay to boost a listing to the top of the marketplace. Changes take effect immediately after saving.</CardDescription>
                        </CardHeader>
                        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {[
                                { key: 'classifieds_boost_fee_7d',  label: '1 Week (7 days)' },
                                { key: 'classifieds_boost_fee_14d', label: '2 Weeks (14 days)' },
                                { key: 'classifieds_boost_fee_21d', label: '3 Weeks (21 days)' },
                                { key: 'classifieds_boost_fee_30d', label: '1 Month (30 days)' },
                                { key: 'classifieds_boost_fee_60d', label: '2 Months (60 days)' },
                                { key: 'classifieds_boost_fee_90d', label: '3 Months (90 days)' },
                            ].map(({ key, label }) => (
                                <div key={key} className="space-y-1.5 p-4 border rounded-lg">
                                    <Label className="font-semibold">{label}</Label>
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-medium">GHS</span>
                                        <Input
                                            type="number"
                                            value={settings[key] || ''}
                                            onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                                            step="0.01"
                                            min="0"
                                            placeholder="0.00"
                                            className="pl-12"
                                        />
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </Card>

                    {/* Seller Verification */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Seller Verification</CardTitle>
                            <CardDescription>Review and approve seller identity verification requests submitted through the marketplace.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 border rounded-lg bg-muted/30">
                                <div className="space-y-1">
                                    <p className="font-semibold text-sm">Manage Verification Queue</p>
                                    <p className="text-xs text-muted-foreground">Approve or reject seller verification requests, view applicant details, and add rejection notes.</p>
                                </div>
                                <a
                                    href="/classifieds/admin/sellers"
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors whitespace-nowrap ml-4 flex-shrink-0"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
                                    Open Verification Queue
                                </a>
                            </div>
                            <p className="text-xs text-muted-foreground mt-3">
                                You can also access this from the sidebar: <strong>Classifieds → Seller Verification</strong>.
                            </p>
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
