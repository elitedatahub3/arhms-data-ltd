/**
 * BrandContext: Server-side de-branding resolver for sub-agent dashboards
 *
 * When a sub views their dashboard, they see their own brand (or their Lead's brand),
 * not the platform brand. This resolver:
 *   1. Detects if the user is a sub
 *   2. Resolves the appropriate brand from the sub's shop_profiles or Lead's shop_profiles
 *   3. Returns a BrandConfig used by UI to swap logo, app name, colors, and hide platform menus
 */

export interface BrandConfig {
  // Branding
  appName: string
  logo: string | null
  brandColor: string
  brandAccent: string

  // De-brand flags
  isBranded: boolean // true = show platform branding, false = show custom/Lead branding
  isPlatform: boolean // true = ARHMS branding, false = custom/sub branding

  // Shop identity (for subs to know their upline)
  shopId: string | null
  shopName: string | null
  uplineShopId: string | null
  // Storefront slugs — the public /shop/[shopSlug] route resolves by slug, NOT id.
  shopSlug: string | null
  uplineShopSlug: string | null
}

/**
 * Resolve the brand context for a user.
 * If the user is a sub, returns their upline's brand (or a placeholder if sub has their own storefront).
 * Otherwise returns the platform brand.
 *
 * @param userId - The authenticated user ID
 * @param supabase - Supabase client
 * @returns BrandConfig for the user's context
 */
export async function resolveBrandContext(
  userId: string,
  supabase: any
): Promise<BrandConfig> {
  // Default platform branding
  const platformBrand: BrandConfig = {
    appName: 'ARHMS',
    logo: null,
    brandColor: '#2563eb',
    brandAccent: '#1e40af',
    isBranded: true,
    isPlatform: true,
    shopId: null,
    shopName: null,
    uplineShopId: null,
    shopSlug: null,
    uplineShopSlug: null,
  }

  try {
    // 1. Check if user is a sub-agent
    const { data: subAgent } = await supabase
      .from('sub_agents')
      .select(`
        id,
        status,
        upline_shop_id,
        shop_profiles!upline_shop_id(
          id,
          shop_slug,
          shop_name,
          logo_url,
          brand_color,
          brand_accent
        )
      `)
      .eq('user_id', userId)
      .single()

    if (!subAgent) {
      // Not a sub — check if they're a shop owner
      const { data: shopOwner } = await supabase
        .from('shop_profiles')
        .select('id, shop_slug, shop_name, logo_url, brand_color, brand_accent')
        .eq('owner_id', userId)
        .single()

      if (shopOwner) {
        // They own a shop — use their branding
        return {
          appName: shopOwner.shop_name || 'ARHMS',
          logo: shopOwner.logo_url,
          brandColor: shopOwner.brand_color || '#2563eb',
          brandAccent: shopOwner.brand_accent || '#1e40af',
          isBranded: false,
          isPlatform: false,
          shopId: shopOwner.id,
          shopName: shopOwner.shop_name,
          uplineShopId: null,
          shopSlug: shopOwner.shop_slug || null,
          uplineShopSlug: null,
        }
      }

      // Regular user — platform brand
      return platformBrand
    }

    // User is a sub-agent — the portal wears their upline's brand.
    const uplineShop = (subAgent.shop_profiles as any)
    if (uplineShop) {
      // A sub can own a shop of their own, and once the network runs three
      // levels they can be an upline themselves. shopId/shopSlug used to be
      // hardcoded null here — "a sub doesn't own their upline's shop", which is
      // true but answered the wrong question — so their own storefront was
      // invisible to anything reading BrandConfig, and every caller needing it
      // went round through /api/dashboard/sub/data's ownShopSlug instead.
      const { data: ownShop } = await supabase
        .from('shop_profiles')
        .select('id, shop_slug')
        .eq('owner_id', userId)
        .maybeSingle()

      return {
        appName: uplineShop.shop_name || 'ARHMS',
        logo: uplineShop.logo_url,
        brandColor: uplineShop.brand_color || '#2563eb',
        brandAccent: uplineShop.brand_accent || '#1e40af',
        isBranded: false,
        isPlatform: false,
        shopId: (ownShop as any)?.id || null,
        shopName: uplineShop.shop_name,
        uplineShopId: uplineShop.id,
        shopSlug: (ownShop as any)?.shop_slug || null,
        uplineShopSlug: uplineShop.shop_slug || null,
      }
    }

    // Fallback (shouldn't reach here if sub_agents FK is valid)
    return platformBrand
  } catch (err) {
    console.error('[BrandContext] Resolution error:', err)
    return platformBrand
  }
}

/**
 * Get visible menu items for a user based on their role and sub status.
 * Hides platform-only menus for subs and their uplines.
 *
 * @param userId - The authenticated user ID
 * @param supabase - Supabase client
 * @returns MenuVisibility object
 */
export async function resolveMenuVisibility(
  userId: string,
  supabase: any
): Promise<{
  showBecomeDealer: boolean
  showPlatformPromos: boolean
  showGetApp: boolean
  showShopAsGuest: boolean
}> {
  // Default: show all menus (for regular users)
  const defaultVisibility = {
    showBecomeDealer: true,
    showPlatformPromos: true,
    showGetApp: true,
    showShopAsGuest: true,
  }

  try {
    // If user is a sub, hide platform menus
    const { data: subAgent } = await supabase
      .from('sub_agents')
      .select('id')
      .eq('user_id', userId)
      .single()

    if (subAgent) {
      return {
        showBecomeDealer: false,
        showPlatformPromos: false,
        showGetApp: false,
        showShopAsGuest: false,
      }
    }

    // Otherwise, show all (shop owners and regular users see platform menus)
    return defaultVisibility
  } catch (err) {
    console.error('[MenuVisibility] Resolution error:', err)
    return defaultVisibility
  }
}
