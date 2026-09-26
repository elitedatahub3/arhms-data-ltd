# Performance baseline

Reference point for the low-bandwidth work described in the sitewide performance plan.
Everything here was measured on `origin/main` at `0c820e8`, before any optimisation.

Regenerate with:

```bash
npm run build
node scripts/measure-bundles.js --top 25 --json baseline.json
```

Sizes are **gzipped** (what a 2G link actually transfers) with raw parse size alongside
(what a low-end Android CPU actually spends time on — the two constrain different things).

## Client JS, before

Shared by every route: **105.6 KB gz** / 370.2 KB raw, across 4 chunks. This is the floor
no route can get below without changing the shared bundle itself.

| Route | GZ KB | Raw KB | Tier |
|---|---|---|---|
| `/dashboard/layout` | 384.0 | 1316.7 | reseller |
| `/dashboard/data-packages/page` | 371.5 | 1272.9 | reseller |
| `/admin/layout` | 368.3 | 1262.8 | staff |
| `/layout` (root) | 367.3 | 1395.8 | all |
| `/page` (landing) | 364.0 | 1257.5 | **guest** |
| `/admin/profits-history/page` | 364.0 | 1253.1 | staff |
| `/dashboard/page` | 350.0 | 1227.7 | reseller |
| `/auth/signup/page` | 326.8 | 1132.4 | **guest** |
| `/auth/login/page` | 326.1 | 1128.9 | **guest** |
| `/admin/fulfillment/page` | 324.9 | 1150.7 | staff |
| `/shop/[shopSlug]/page` | 317.8 | 1072.2 | **guest** |

All unique client chunks: **1687.2 KB gz** (5598.7 KB raw), 351 routes measured.

The guest routes — the ones a customer on 2G hits with a cold cache — are 318–364 KB gz of
JavaScript *before* HTML, CSS, fonts or images. The 300 KB total-transfer target is therefore
not reachable by trimming images alone; the JS has to come down too.

## Static assets, before

`public/` totals **4.9 MB**. Everything under `public/` lands in the generated
service-worker precache manifest (`public/sw.js`, 465 entries), so every PWA install
downloads all of it whether or not a page ever renders it.

An earlier draft of this table called ~3.1 MB "dead — referenced nowhere". That was
wrong for three of the five files, and the correction matters, because deleting them
outright would have broken a build script. Only the two network icons had no referrer
at all. The rest were referenced from places a `--include=*.tsx` search does not reach:
plain `.html` files under `public/`, and a `.mjs` build script.

| File | Size | Actual status |
|---|---|---|
| `images/networks/mtn.png` | 944 KB | genuinely dead — `components/network-icon.tsx` short-circuits MTN to inline SVG before the image branch |
| `logo.png` | 745 KB | **live**: the master source for `scripts/generate-pwa-icons.mjs`, and the logo in `public/offline.html` |
| `images/person_happy.png` | 616 KB | **live**: rendered by `public/marketing-ad.html` (JPEG data behind a `.png` extension) |
| `images/person_stressed.png` | 463 KB | **live**: same page, same extension mismatch |
| `images/networks/at.png` | 333 KB | genuinely dead — same inline-SVG short-circuit as MTN |

Still live, but far larger than needed:

| File | Actual | Rendered at | Note |
|---|---|---|---|
| `images/networks/telecel.png` | 2048×2048, 640 KB | 24–48 px | the only network icon still served as an image |
| `arhms-logo.png` | 1254×1254, 745 KB | small containers | loaded with `priority` on several routes |

## Static assets, after

| File | Before | After | How |
|---|---|---|---|
| `images/networks/mtn.png` | 944 KB | — | deleted, unreferenced |
| `logo.png` | 745 KB | — | moved to `assets/logo-source.png`, outside `public/` so it is no longer served or precached. It is a build-time input, not a runtime asset. `offline.html` now points at `arhms-logo.png` (512×512, already precached) |
| `images/person_happy.png` | 616 KB | 28 KB | → `person_happy.webp`, 1024×1024 → 480×480 (the page caps it at `max-height: 240px`) |
| `images/person_stressed.png` | 463 KB | 16 KB | → `person_stressed.webp`, same treatment |
| `images/networks/at.png` | 333 KB | — | deleted, unreferenced |
| `images/networks/telecel.png` | 640 KB | 9 KB | 2048×2048 → 256×256 |
| `arhms-logo.png` | 745 KB | 71 KB | 1254×1254 → 512×512 |

`public/` drops from **4.9 MB to 596 KB** — an 88% cut, all of it off the precache
manifest, so it comes out of the install cost of every PWA install on a metered
connection. Re-checked after the build: the deleted files no longer appear in
`public/sw.js`, and the two `.webp` replacements do.

Moving the logo master out of `public/` is checked by regenerating the icons: the
192×192 and 512×512 outputs are byte-identical before and after the move.

## Client JS, after phase 1 — no change, and why

| Metric | Before | After |
|---|---|---|
| Shared by all routes | 105.6 KB gz | 105.6 KB gz |
| `/page` (landing, guest) | 364.0 KB gz | 364.0 KB gz |
| `/dashboard/layout` | 384.0 KB gz | 384.2 KB gz |
| All unique client chunks | 1687.2 KB gz | 1691.3 KB gz |

Phase 1 moved JS by **nothing**. Recording that plainly, because two of the changes
were made expecting a win and did not deliver one:

- `experimental.optimizePackageImports: ['lucide-react', 'date-fns', 'recharts']` —
  all three are already in **Next 15's default list**. Verified in
  `node_modules/next/dist/server/config.js`. The setting is a no-op here and was
  never going to shrink the barrel imports. It stays only as a pin against a future
  default change.
- Dropping `@tanstack/react-table` from `package.json` removed a genuinely unused
  dependency (no import of it survives anywhere in `app/`, `components/`, `lib/`,
  `hooks/`), but nothing was bundling it, so nothing left the bundle.

The image/config work was worth doing on its own terms — it is 4.3 MB off every PWA
install. But the JS problem is untouched: guest routes are still **318–364 KB gz**
against a 300 KB *total transfer* target. Every remaining kilobyte has to come from
route-level code, not configuration. That is phase 2, and the analyzer
(`npm run analyze`) is now wired up to find it.

## How to compare

`scripts/measure-bundles.js` reads the manifests `next build` leaves behind, so it can be
re-run against any existing build without rebuilding, and its `--json` output diffs cleanly
between branches. Re-run it after each phase and record the delta here.
