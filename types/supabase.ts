export type Json =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Json | undefined }
    | Json[]

export interface Database {
    public: {
        Tables: {
            users: {
                Row: {
                    id: string
                    email: string
                    first_name: string
                    last_name: string
                    phone_number: string
                    phone_verified: boolean
                    role: 'customer' | 'agent' | 'admin' | 'sub-admin' | 'dealer'
                    status: 'active' | 'suspended' | 'inactive'
                    agent_expires_at: string | null
                    dealer_claimed_at: string | null
                    dealer_expires_at: string | null
                    is_seller: boolean
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id: string
                    email: string
                    first_name: string
                    last_name: string
                    phone_number: string
                    phone_verified?: boolean
                    role?: 'customer' | 'agent' | 'admin' | 'sub-admin' | 'dealer'
                    status?: 'active' | 'suspended' | 'inactive'
                    agent_expires_at?: string | null
                    dealer_claimed_at?: string | null
                    dealer_expires_at?: string | null
                    is_seller?: boolean
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    id?: string
                    email?: string
                    first_name?: string
                    last_name?: string
                    phone_number?: string
                    phone_verified?: boolean
                    role?: 'customer' | 'agent' | 'admin' | 'sub-admin' | 'dealer'
                    status?: 'active' | 'suspended' | 'inactive'
                    agent_expires_at?: string | null
                    dealer_claimed_at?: string | null
                    dealer_expires_at?: string | null
                    is_seller?: boolean
                    updated_at?: string
                }
            }
            wallets: {
                Row: {
                    id: string
                    user_id: string
                    balance: number
                    total_credited: number
                    total_spent: number
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    balance?: number
                    total_credited?: number
                    total_spent?: number
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    balance?: number
                    total_credited?: number
                    total_spent?: number
                    updated_at?: string
                }
            }
            wallet_transactions: {
                Row: {
                    id: string
                    wallet_id: string
                    user_id: string
                    type: 'credit' | 'debit'
                    amount: number
                    description: string
                    reference: string | null
                    source: 'payment' | 'refund' | 'admin' | 'purchase'
                    status: 'pending' | 'completed' | 'failed'
                    created_at: string
                }
                Insert: {
                    id?: string
                    wallet_id: string
                    user_id: string
                    type: 'credit' | 'debit'
                    amount: number
                    description: string
                    reference?: string | null
                    source: 'payment' | 'refund' | 'admin' | 'purchase'
                    status?: 'pending' | 'completed' | 'failed'
                    created_at?: string
                }
                Update: {
                    status?: 'pending' | 'completed' | 'failed'
                }
            }
            wallet_payments: {
                Row: {
                    id: string
                    user_id: string
                    wallet_id: string
                    amount: number
                    fee: number
                    total_amount: number
                    reference: string
                    // The gateways from PaymentProvider (lib/payment-provider.ts), plus
                    // 'wallet' for purchases settled from the ARHMS balance with no
                    // gateway involved. Inlined rather than imported so this types file
                    // stays dependency-free.
                    provider: 'moolre' | 'hubtel' | 'paystack' | 'paystack_momo' | 'payswitch' | 'wallet'
                    status: 'pending' | 'completed' | 'failed'
                    provider_reference: string | null
                    metadata: Json | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    wallet_id: string
                    amount: number
                    fee: number
                    total_amount: number
                    reference: string
                    provider?: 'moolre' | 'hubtel' | 'paystack' | 'paystack_momo' | 'payswitch' | 'wallet'
                    status?: 'pending' | 'completed' | 'failed'
                    provider_reference?: string | null
                    metadata?: Json | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'completed' | 'failed'
                    provider_reference?: string | null
                    metadata?: Json | null
                    updated_at?: string
                }
            }
            data_packages: {
                Row: {
                    id: string
                    network: 'MTN' | 'Telecel' | 'AT-iShare' | 'AT-BigTime' | 'Special MTN Mashup' | 'EXPRESS MTN'
                    size: string
                    price: number
                    agent_price?: number | null
                    dealer_price?: number | null
                    cost_price?: number
                    description: string | null
                    is_available: boolean
                    sort_order: number
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    network: 'MTN' | 'Telecel' | 'AT-iShare' | 'AT-BigTime' | 'Special MTN Mashup' | 'EXPRESS MTN'
                    size: string
                    price: number
                    agent_price?: number | null
                    dealer_price?: number | null
                    description?: string | null
                    is_available?: boolean
                    sort_order?: number
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    network?: 'MTN' | 'Telecel' | 'AT-iShare' | 'AT-BigTime' | 'Special MTN Mashup' | 'EXPRESS MTN'
                    size?: string
                    price?: number
                    agent_price?: number | null
                    dealer_price?: number | null
                    description?: string | null
                    is_available?: boolean
                    sort_order?: number
                    updated_at?: string
                }
            }
            orders: {
                Row: {
                    id: string
                    user_id: string
                    phone_number: string
                    network: string
                    size: string
                    price: number
                    cost_price?: number
                    status: 'pending' | 'processing' | 'completed' | 'failed'
                    payment_status: 'paid' | 'refunded'
                    reference_code: string
                    fulfillment_method: 'auto' | 'manual'
                    codecraft_reference: string | null
                    eazydata_reference: string | null
                    agentportal_reference: string | null
                    netpulse_reference: string | null
                    hendylinks_reference: string | null
                    error_message: string | null
                    download_batch_id: string | null
                    shop_order_id: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    phone_number: string
                    network: string
                    size: string
                    price: number
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    payment_status?: 'paid' | 'refunded'
                    reference_code: string
                    fulfillment_method?: 'auto' | 'manual'
                    codecraft_reference?: string | null
                    eazydata_reference?: string | null
                    agentportal_reference?: string | null
                    netpulse_reference?: string | null
                    hendylinks_reference?: string | null
                    error_message?: string | null
                    download_batch_id?: string | null
                    shop_order_id?: string | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    payment_status?: 'paid' | 'refunded'
                    codecraft_reference?: string | null
                    eazydata_reference?: string | null
                    agentportal_reference?: string | null
                    netpulse_reference?: string | null
                    hendylinks_reference?: string | null
                    error_message?: string | null
                    download_batch_id?: string | null
                    shop_order_id?: string | null
                    updated_at?: string
                }
            }
            notifications: {
                Row: {
                    id: string
                    user_id: string
                    title: string
                    message: string
                    type: 'order_update' | 'complaint_resolved' | 'payment_success' | 'balance_updated' | 'system'
                    is_read: boolean
                    action_url: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    title: string
                    message: string
                    type: 'order_update' | 'complaint_resolved' | 'payment_success' | 'balance_updated' | 'system'
                    is_read?: boolean
                    action_url?: string | null
                    created_at?: string
                }
                Update: {
                    is_read?: boolean
                }
            }
            complaints: {
                Row: {
                    id: string
                    user_id: string
                    order_id: string
                    title: string
                    description: string
                    status: 'pending' | 'in_review' | 'resolved' | 'rejected'
                    priority: 'low' | 'medium' | 'high'
                    resolution_notes: string | null
                    evidence: Json | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    order_id: string
                    title: string
                    description: string
                    status?: 'pending' | 'in_review' | 'resolved' | 'rejected'
                    priority?: 'low' | 'medium' | 'high'
                    resolution_notes?: string | null
                    evidence?: Json | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'in_review' | 'resolved' | 'rejected'
                    priority?: 'low' | 'medium' | 'high'
                    resolution_notes?: string | null
                    updated_at?: string
                }
            }
            mtn_fulfillment_tracking: {
                Row: {
                    id: string
                    order_id: string
                    status: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response: Json | null
                    retry_count: number
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    order_id: string
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response?: Json | null
                    retry_count?: number
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response?: Json | null
                    retry_count?: number
                    updated_at?: string
                }
            }
            fulfillment_logs: {
                Row: {
                    id: string
                    order_id: string
                    status: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response: Json | null
                    codecraft_reference: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    order_id: string
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response?: Json | null
                    codecraft_reference?: string | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'processing' | 'completed' | 'failed'
                    api_response?: Json | null
                    codecraft_reference?: string | null
                    updated_at?: string
                }
            }
            admin_settings: {
                Row: {
                    key: string
                    value: Json
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    key: string
                    value: Json
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    value?: Json
                    updated_at?: string
                }
            }
            phone_blacklist: {
                Row: {
                    id: string
                    phone_number: string
                    reason: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    phone_number: string
                    reason?: string | null
                    created_at?: string
                }
                Update: {
                    reason?: string | null
                }
            }
            afa_orders: {
                Row: {
                    id: string
                    /** Null for guest applications submitted through a storefront. */
                    user_id: string | null
                    full_name: string
                    phone: string
                    ghana_card: string
                    id_type: string | null
                    id_number: string | null
                    location: string
                    region: string
                    occupation: string
                    date_of_birth?: string | null
                    status: 'pending' | 'processing' | 'completed' | 'cancelled'
                    notes: string | null
                    payment_amount: number | null
                    reference_code: string
                    transaction_id: string | null
                    // Storefront columns — null on dashboard applications.
                    shop_id: string | null
                    shop_name: string | null
                    shop_markup: number | null
                    cost_price: number | null
                    customer_email: string | null
                    source: 'dashboard' | 'storefront' | 'sub' | null
                    payment_status: 'pending_payment' | 'completed' | 'failed' | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    user_id?: string | null
                    full_name: string
                    phone: string
                    ghana_card: string
                    id_type?: string | null
                    id_number?: string | null
                    location: string
                    region: string
                    occupation: string
                    date_of_birth?: string | null
                    status?: 'pending' | 'processing' | 'completed' | 'cancelled'
                    notes?: string | null
                    payment_amount?: number | null
                    reference_code: string
                    transaction_id?: string | null
                    shop_id?: string | null
                    shop_name?: string | null
                    shop_markup?: number | null
                    cost_price?: number | null
                    customer_email?: string | null
                    source?: 'dashboard' | 'storefront' | 'sub' | null
                    payment_status?: 'pending_payment' | 'completed' | 'failed' | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    status?: 'pending' | 'processing' | 'completed' | 'cancelled'
                    notes?: string | null
                    payment_status?: 'pending_payment' | 'completed' | 'failed' | null
                    updated_at?: string
                }
            }
            customer_purchases: {
                Row: {
                    id: string
                    user_id: string
                    customer_phone: string
                    total_purchases: number
                    total_spent: number
                    first_purchase_at: string
                    last_purchase_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    customer_phone: string
                    total_purchases?: number
                    total_spent?: number
                    first_purchase_at?: string
                    last_purchase_at?: string
                }
                Update: {
                    total_purchases?: number
                    total_spent?: number
                    last_purchase_at?: string
                }
            }
            download_batches: {
                Row: {
                    id: string
                    filename: string
                    network: string
                    order_count: number
                    created_at: string
                }
                Insert: {
                    id?: string
                    filename: string
                    network: string
                    order_count: number
                    created_at?: string
                }
                Update: {
                    filename?: string
                    network?: string
                    order_count?: number
                }
            }
            system_announcements: {
                Row: {
                    id: string
                    title: string
                    message: string
                    is_active: boolean
                    visible_on: 'main_site' | 'storefronts' | 'both'
                    /** Drives every colour in the modal. See lib/announcement-tones.ts. */
                    tone: 'official' | 'shop' | 'success' | 'alert' | null
                    /** Overrides the tone's default badge copy. */
                    badge_label: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    title: string
                    message: string
                    is_active?: boolean
                    visible_on?: 'main_site' | 'storefronts' | 'both'
                    tone?: 'official' | 'shop' | 'success' | 'alert' | null
                    badge_label?: string | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    title?: string
                    message?: string
                    is_active?: boolean
                    visible_on?: 'main_site' | 'storefronts' | 'both'
                    tone?: 'official' | 'shop' | 'success' | 'alert' | null
                    badge_label?: string | null
                    updated_at?: string
                }
            }
            shop_announcements: {
                Row: {
                    id: string
                    shop_id: string
                    /** Optional headline. Null on rows written before titles existed. */
                    title: string | null
                    message: string
                    /** Owner-chosen colour; 'official' is reserved for the platform. */
                    tone: 'official' | 'shop' | 'success' | 'alert' | null
                    is_active: boolean
                    created_at: string
                }
                Insert: {
                    id?: string
                    shop_id: string
                    title?: string | null
                    message: string
                    tone?: 'official' | 'shop' | 'success' | 'alert' | null
                    is_active?: boolean
                    created_at?: string
                }
                Update: {
                    title?: string | null
                    message?: string
                    tone?: 'official' | 'shop' | 'success' | 'alert' | null
                    is_active?: boolean
                }
            }
            pending_settlements: {
                Row: {
                    id: string
                    user_id: string
                    wallet_transaction_id: string | null
                    amount_owed: number
                    amount_settled: number
                    status: 'pending' | 'partially_settled' | 'settled'
                    payment_method: string | null
                    notes: string | null
                    created_at: string
                    settled_at: string | null
                }
                Insert: {
                    id?: string
                    user_id: string
                    wallet_transaction_id?: string | null
                    amount_owed: number
                    amount_settled?: number
                    status?: 'pending' | 'partially_settled' | 'settled'
                    payment_method?: string | null
                    notes?: string | null
                    created_at?: string
                    settled_at?: string | null
                }
                Update: {
                    amount_settled?: number
                    status?: 'pending' | 'partially_settled' | 'settled'
                    payment_method?: string | null
                    notes?: string | null
                    settled_at?: string | null
                }
            }
            classified_categories: {
                Row: {
                    id: string
                    name: string
                    slug: string
                    description: string | null
                    icon_emoji: string | null
                    icon: string | null
                    image_url: string | null
                    parent_id: string | null
                    display_order: number
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    name: string
                    slug: string
                    description?: string | null
                    icon_emoji?: string | null
                    icon?: string | null
                    image_url?: string | null
                    parent_id?: string | null
                    display_order?: number
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    name?: string
                    slug?: string
                    description?: string | null
                    icon_emoji?: string | null
                    icon?: string | null
                    image_url?: string | null
                    parent_id?: string | null
                    display_order?: number
                    updated_at?: string
                }
            }
            classified_listings: {
                Row: {
                    id: string
                    seller_id: string
                    title: string
                    description: string
                    category_id: string
                    price: number
                    status: 'active' | 'sold' | 'expired' | 'archived'
                    location: string | null
                    condition: 'new' | 'like-new' | 'used' | 'refurbished'
                    contact_phone: string | null
                    contact_email: string | null
                    whatsapp_number: string | null
                    facebook_url: string | null
                    twitter_url: string | null
                    instagram_url: string | null
                    view_count: number
                    is_boosted: boolean
                    boosted_until: string | null
                    boost_tier: string | null
                    created_at: string
                    updated_at: string
                    expires_at: string | null
                }
                Insert: {
                    id?: string
                    seller_id: string
                    title: string
                    description: string
                    category_id: string
                    price: number
                    status?: 'active' | 'sold' | 'expired' | 'archived'
                    location?: string | null
                    condition?: 'new' | 'like-new' | 'used' | 'refurbished'
                    contact_phone?: string | null
                    contact_email?: string | null
                    whatsapp_number?: string | null
                    facebook_url?: string | null
                    twitter_url?: string | null
                    instagram_url?: string | null
                    view_count?: number
                    is_boosted?: boolean
                    boosted_until?: string | null
                    boost_tier?: string | null
                    created_at?: string
                    updated_at?: string
                    expires_at?: string | null
                }
                Update: {
                    title?: string
                    description?: string
                    category_id?: string
                    price?: number
                    status?: 'active' | 'sold' | 'expired' | 'archived'
                    location?: string | null
                    condition?: 'new' | 'like-new' | 'used' | 'refurbished'
                    contact_phone?: string | null
                    contact_email?: string | null
                    whatsapp_number?: string | null
                    facebook_url?: string | null
                    twitter_url?: string | null
                    instagram_url?: string | null
                    view_count?: number
                    is_boosted?: boolean
                    boosted_until?: string | null
                    boost_tier?: string | null
                    updated_at?: string
                    expires_at?: string | null
                }
            }
            classified_boosts: {
                Row: {
                    id: string
                    listing_id: string
                    seller_id: string
                    tier: string
                    amount_paid: number
                    starts_at: string
                    ends_at: string
                    created_at: string
                }
                Insert: {
                    id?: string
                    listing_id: string
                    seller_id: string
                    tier: string
                    amount_paid: number
                    starts_at?: string
                    ends_at: string
                    created_at?: string
                }
                Update: {
                    tier?: string
                    amount_paid?: number
                    starts_at?: string
                    ends_at?: string
                }
            }
            classified_listing_images: {
                Row: {
                    id: string
                    listing_id: string
                    storage_path: string
                    display_order: number
                    created_at: string
                }
                Insert: {
                    id?: string
                    listing_id: string
                    storage_path: string
                    display_order?: number
                    created_at?: string
                }
                Update: {
                    storage_path?: string
                    display_order?: number
                }
            }
            classified_contact_reveals: {
                Row: {
                    id: string
                    listing_id: string
                    buyer_id: string
                    revealed_at: string
                    acknowledged_safety_tips_at: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    listing_id: string
                    buyer_id: string
                    revealed_at?: string
                    acknowledged_safety_tips_at?: string | null
                    created_at?: string
                }
                Update: {
                    revealed_at?: string
                    acknowledged_safety_tips_at?: string | null
                }
            }
            classified_favorites: {
                Row: {
                    id: string
                    user_id: string
                    listing_id: string
                    created_at: string
                }
                Insert: {
                    id?: string
                    user_id: string
                    listing_id: string
                    created_at?: string
                }
                Update: {
                    created_at?: string
                }
            }
            hubtel_payment_logs: {
                Row: {
                    id: string
                    client_reference: string
                    flow: string | null
                    status: 'pending' | 'success' | 'failed'
                    stage: 'initiate' | 'callback' | 'status_check' | 'fulfill'
                    amount: number | null
                    channel: string | null
                    payer_msisdn: string | null
                    customer_name: string | null
                    transaction_id: string | null
                    response_code: string | null
                    message: string | null
                    user_id: string | null
                    raw_initiate: Json | null
                    raw_callback: Json | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    client_reference: string
                    flow?: string | null
                    status?: 'pending' | 'success' | 'failed'
                    stage?: 'initiate' | 'callback' | 'status_check' | 'fulfill'
                    amount?: number | null
                    channel?: string | null
                    payer_msisdn?: string | null
                    customer_name?: string | null
                    transaction_id?: string | null
                    response_code?: string | null
                    message?: string | null
                    user_id?: string | null
                    raw_initiate?: Json | null
                    raw_callback?: Json | null
                    created_at?: string
                    updated_at?: string
                }
                Update: {
                    flow?: string | null
                    status?: 'pending' | 'success' | 'failed'
                    stage?: 'initiate' | 'callback' | 'status_check' | 'fulfill'
                    amount?: number | null
                    channel?: string | null
                    payer_msisdn?: string | null
                    customer_name?: string | null
                    transaction_id?: string | null
                    response_code?: string | null
                    message?: string | null
                    user_id?: string | null
                    raw_initiate?: Json | null
                    raw_callback?: Json | null
                    updated_at?: string
                }
            }
        }
    }
}

export type User = Database['public']['Tables']['users']['Row']
export type Wallet = Database['public']['Tables']['wallets']['Row']
export type WalletTransaction = Database['public']['Tables']['wallet_transactions']['Row']
export type WalletPayment = Database['public']['Tables']['wallet_payments']['Row']
export type DataPackage = Database['public']['Tables']['data_packages']['Row']
export type Order = Database['public']['Tables']['orders']['Row']
export type Notification = Database['public']['Tables']['notifications']['Row']
export type Complaint = Database['public']['Tables']['complaints']['Row']
export type AdminSetting = Database['public']['Tables']['admin_settings']['Row']
export type AFAOrder = Database['public']['Tables']['afa_orders']['Row']
export type CustomerPurchase = Database['public']['Tables']['customer_purchases']['Row']
export type DownloadBatch = Database['public']['Tables']['download_batches']['Row']
export type SystemAnnouncement = Database['public']['Tables']['system_announcements']['Row']
export type ShopAnnouncement = Database['public']['Tables']['shop_announcements']['Row']
export type PendingSettlement = Database['public']['Tables']['pending_settlements']['Row']
export type HubtelPaymentLog = Database['public']['Tables']['hubtel_payment_logs']['Row']

export type ClassifiedCategory = Database['public']['Tables']['classified_categories']['Row']
export type ClassifiedListing = Database['public']['Tables']['classified_listings']['Row']
export type ClassifiedListingImage = Database['public']['Tables']['classified_listing_images']['Row']
export type ClassifiedContactReveal = Database['public']['Tables']['classified_contact_reveals']['Row']
export type ClassifiedFavorite = Database['public']['Tables']['classified_favorites']['Row']
export type ClassifiedBoost = Database['public']['Tables']['classified_boosts']['Row']
