Service tile marks for the shop storefront (ShopStorefront.tsx).

results-checker.png is the WAEC seal (fetched from Wikimedia Commons). Only
one file lives here: DATA, AIRTIME and PAY BILLS cover every network or five
different billers, so there is no single brand to show and they keep their
lucide glyph. AFA does not need a file — it reuses the app's own MtnMark via
NetworkLogo (lib/networks.tsx), since AFA registration is an MTN product and
that mark is already drawn correctly-coloured for the network selector on
this same page.

Referenced by TILE_LOGO in app/shop/[shopSlug]/ShopStorefront.tsx. A missing
or broken file is not fatal: TileIcon falls back to the lucide glyph, so a
tile never shows an empty chip.
