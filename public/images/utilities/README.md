Brand marks for the Pay Bills service picker.

Drop these five files in, exactly these names (PNG, transparent or white
background, roughly square, 128-256px):

    dstv.png
    gotv.png
    startimes.png
    ecg.png
    ghanawater.png

They are referenced by SERVICE_STYLE in app/dashboard/utilities/page.tsx. A
missing or broken file is not fatal: ServiceLogo falls back to the service's
gradient icon, so the grid never shows an empty square.
