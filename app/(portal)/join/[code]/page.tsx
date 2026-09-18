/**
 * De-Branded Sub-Agent Signup Portal
 *
 * URL: /join/[code]
 * - [code] is the invite code from the Lead
 * - Displays the Lead's brand (logo, colors, name)
 * - Signup form (email + password + phone OTP)
 * - Reuses existing auth engine (Supabase)
 * - On success, creates sub_agents row with status='pending' (awaits Lead approval)
 *
 * Security:
 *   - Validate invite code exists, not revoked, not expired, within use cap
 *   - Rate-limit redemption per code
 *   - Phone OTP verified before account creation
 */

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { normalizeWhatsAppNumber } from '@/lib/utils'
import { SubAgentSignupForm } from './signup-form'

interface Props {
  params: Promise<{ code: string }>
}

// Per request: this page resolves an invite code to the Lead's live branding and
// validity, and an invite can be revoked at any time. The root layout no longer
// forces the whole app dynamic, so this route declares it for itself.
export const dynamic = 'force-dynamic'

export default async function JoinPage({ params }: Props) {
  const { code } = await params
  const supabase: any = createServerClient()

  // 1. Validate invite code
  const { data: invite, error: inviteError } = await supabase
    .from('shop_invites')
    .select(`
      id,
      shop_id,
      code,
      max_uses,
      used_count,
      expires_at,
      revoked_at,
      shop_profiles(
        id,
        shop_name,
        logo_url,
        brand_color,
        brand_accent,
        owner_id,
        owner_phone,
        whatsapp_number
      )
    `)
    .eq('code', code)
    .single()

  if (inviteError || !invite) {
    console.warn(`[Join Portal] Invite not found: ${code}`)
    notFound()
  }

  // 2. Validate invite state
  const now = new Date()

  if (invite.revoked_at) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Invite Revoked</h1>
          <p className="text-gray-600 mt-2">
            This invite link has been revoked by the shop owner.
          </p>
        </div>
      </div>
    )
  }

  if (invite.expires_at && new Date(invite.expires_at) < now) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Invite Expired</h1>
          <p className="text-gray-600 mt-2">
            This invite link has expired. Please request a new one from your Lead.
          </p>
        </div>
      </div>
    )
  }

  if (invite.max_uses && invite.used_count >= invite.max_uses) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Invite Limit Reached</h1>
          <p className="text-gray-600 mt-2">
            This invite link has reached its usage limit. Please request a new one from your Lead.
          </p>
        </div>
      </div>
    )
  }

  // 3. Extract shop branding
  const shop = (invite.shop_profiles as any)
  const brandConfig = {
    shopName: shop?.shop_name || 'Shop',
    logo: shop?.logo_url,
    brandColor: shop?.brand_color || '#2563eb',
    brandAccent: shop?.brand_accent || '#1e40af',
  }

  // Owner's WhatsApp number so a pending sub can message them for approval.
  // Prefer the dedicated (already 233-normalized) whatsapp_number, else fall
  // back to the required owner_phone (raw) run through the shared normalizer.
  const ownerWhatsApp =
    shop?.whatsapp_number || (shop?.owner_phone ? normalizeWhatsAppNumber(shop.owner_phone) : '')

  // 4. Render signup form with branding
  return (
    <div
      className="flex items-center justify-center min-h-screen"
      style={{ backgroundColor: `${brandConfig.brandColor}15` }}
    >
      <div className="w-full max-w-md">
        {/* Header with shop branding */}
        <div className="text-center mb-8">
          {brandConfig.logo ? (
            <img
              src={brandConfig.logo}
              alt={brandConfig.shopName}
              className="h-16 mx-auto mb-4"
            />
          ) : (
            <div
              className="h-16 w-16 rounded-full mx-auto mb-4 flex items-center justify-center text-white text-2xl font-bold"
              style={{ backgroundColor: brandConfig.brandColor }}
            >
              {brandConfig.shopName.charAt(0).toUpperCase()}
            </div>
          )}
          <h1 className="text-3xl font-bold text-gray-900">
            Join {brandConfig.shopName}
          </h1>
          <p className="text-gray-600 mt-2">
            Sign up to become a sub-agent and start selling
          </p>
        </div>

        {/* Signup form */}
        <div className="bg-white rounded-lg shadow-lg p-8">
          <SubAgentSignupForm
            inviteId={invite.id}
            shopId={invite.shop_id}
            shopName={brandConfig.shopName}
            brandColor={brandConfig.brandColor}
            ownerWhatsApp={ownerWhatsApp}
          />

          {/* Footer with shop attribution */}
          <div className="text-center mt-6 text-xs text-gray-500">
            <p>Powered by {brandConfig.shopName}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
