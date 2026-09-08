Service tile marks for the shop storefront (ShopStorefront.tsx).

Drop these four files in, exactly these names (PNG, white or transparent
background, roughly square, 128-256px):

    airtime.png
    results-checker.png
    afa.png
    utility-bills.png

DATA has no logo of its own — it always shows the Zap glyph. Referenced by
TILE_LOGO in app/shop/[shopSlug]/ShopStorefront.tsx. A missing or broken file
is not fatal: TileIcon falls back to the lucide glyph, so a tile never shows
an empty chip.
