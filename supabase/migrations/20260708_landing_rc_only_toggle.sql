-- Seed landing_rc_only_enabled toggle (default OFF).
-- When ON, the homepage ("/") renders the Results-Checker-only landing page
-- instead of the full ARHMS landing page.
INSERT INTO admin_settings (key, value)
VALUES ('landing_rc_only_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- Recreate the public-safe settings view with the new key added so the
-- landing page (anon client, via getPublicConfig) can read the flag.
create or replace view public.public_admin_settings as
select key, value
from public.admin_settings
where key in (
  'guest_storefront_url',
  'whatsapp_group_link',
  'whatsapp_channel_link',
  'whatsapp_admin_number',
  'whatsapp_community_link',
  'support_email',
  'footer_copyright_text',
  'footer_branding_text',
  'announcement_enabled',
  'announcement_title',
  'announcement_message',
  'agent_upgrade_price_3d',
  'agent_upgrade_price_14d',
  'agent_upgrade_price_30d',
  'agent_upgrade_price_permanent',
  'agent_upgrade_price_3d_old',
  'agent_upgrade_price_14d_old',
  'agent_upgrade_price_30d_old',
  'agent_upgrade_price_permanent_old',
  'show_price_strikethrough',
  'page_access_dashboard',
  'page_access_data_packages',
  'page_access_orders',
  'page_access_wallet',
  'page_access_complaints',
  'page_access_notifications',
  'page_access_profile',
  'page_access_shop',
  'page_access_storefront',
  'page_access_airtime',
  'storefront_airtime_enabled',
  'airtime_fee_mtn_customer',
  'airtime_fee_mtn_agent',
  'airtime_fee_telecel_customer',
  'airtime_fee_telecel_agent',
  'airtime_fee_at_customer',
  'airtime_fee_at_agent',
  'airtime_min_amount',
  'airtime_max_amount',
  'airtime_enabled_mtn',
  'airtime_enabled_telecel',
  'airtime_enabled_at',
  'landing_rc_only_enabled'
);

grant select on public.public_admin_settings to anon, authenticated;
