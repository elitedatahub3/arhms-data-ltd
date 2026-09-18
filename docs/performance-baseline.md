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
| `/classifieds/page` | 371.1 | 1265.1 | secondary |
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

`scripts/perf-gates.js` (`npm run perf:gates`) covers the two things bundle size does not:
how much HTML is prerendered, and what the service worker precaches. `npm run perf` runs both.

---

# Phase 2 — service worker precache, and static rendering

Measured on `perf/2g-phase-0-1`, branched from `origin/main` at `2339a3a0`.

## The precache was 7.79 MB, and the exclusion that was meant to control it never ran

`next.config.ts` carried `workboxOptions.exclude: [/^\//]` with a comment explaining it
kept the root HTML document out of the cache. It did not. Workbox tests `exclude`
against **webpack asset names** — `static/chunks/foo.js`, with no leading slash — so
`/^\//` matched nothing. The root document was not excluded, and neither was anything
else. The result:

| | Entries | Bytes |
|---|---|---|
| Before | 502 | **7.79 MB** |
| After | 15 | **0.28 MB** |

488 of the 502 entries were `/_next/static` chunks. All of it downloaded in the
background on a user's **first** visit, competing with the page they were waiting for
over the same ~2.5–7.5 KB/s pipe. At 50 kbps that install is roughly 21 minutes of
contention — on the one visit where the user has nothing cached and is deciding whether
the site works at all.

## Why dropping chunks from the precache does not un-cache them

This is the part worth being precise about, because "stop precaching the app" sounds
like it should make repeat visits slower. It does not, because the plugin's *default*
`runtimeCaching` already contains:

```js
{ urlPattern: /\/_next\/static.+\.js$/i, handler: "CacheFirst",
  options: { cacheName: "next-static-js-assets", ... } }
```

Verified in `node_modules/@ducanh2912/next-pwa/dist/index.cjs`. So a chunk is still
cached — on the first request that actually *needs* it, rather than speculatively. The
chunks are content-hashed and already served `max-age=31536000, immutable` by the
`headers()` block, so a repeat visit is served from cache either way. The only thing
that changed is that nothing is fetched before it is needed.

Because the default list is replaced wholesale if `runtimeCaching` is specified, it is
deliberately **not** specified here — overriding it to re-add one rule would silently
drop the other 18.

`exclude` only filters webpack assets. `public/` reaches the manifest through
`additionalManifestEntries`, which `exclude` does not touch — which is why
`offline.html`, `manifest.json` and the icons are still precached, as they should be.

`cacheOnFrontEndNav` and `aggressiveFrontEndNavCaching` were also turned off: both
prefetch pages on hover/proximity, which on 2G competes with the navigation the user
actually asked for.

## Icons

`icon-512x512.png` was 220 KB and was listed in `metadata.icons.icon`, which renders
`<link rel="icon">` — a favicon candidate a browser may fetch on a cold load, for
something displayed at 16–32px. It is now declared only in `manifest.json`, which is
where an installable PWA needs it and which is read at install time.

All four icons were re-encoded with palette quantisation (they are flat-ish brand marks,
and the gradients survive it — checked visually at full size):

| File | Before | After |
|---|---|---|
| `icon-512x512.png` | 220.5 KB | 75.5 KB |
| `icon-192x192.png` | 37.7 KB | 12.8 KB |
| `apple-touch-icon.png` | 33.7 KB | 11.8 KB |
| `icon-maskable-192x192.png` | 24.9 KB | 8.8 KB |

## Client JS, after phase 2 — unchanged, as expected

This phase moved no JavaScript, which is correct: it is entirely about what is fetched
and when, not what is bundled. Current figures on `origin/main` (note these are *higher*
than the phase-1 table above — main has moved since, and the shared chunk is unchanged):

| Route | GZ KB | Raw KB | Tier |
|---|---|---|---|
| `/dashboard/layout` | 389.5 | 1331.7 | reseller |
| `/layout` (root) | 377.4 | 1440.2 | all |
| `/page` (landing) | 364.9 | 1258.1 | **guest** |
| `/auth/login/page` | 329.1 | 1137.2 | **guest** |
| `/shop/[shopSlug]/page` | 332.8 | 1121.1 | **guest** |
| Shared by all routes | 105.5 | 370.0 | floor |

## Static rendering: inverting the dynamic default

`app/layout.tsx` called a bare `noStore()`. Because the root layout is part of every
route, that one line made **every route in the app** render on demand: `perf:gates`
reported 0 prerendered files and there was no `prerender-manifest.json`. Every first
byte cost a Ghana → `dub1` round trip.

That `noStore()` was deliberate, not accidental — the comment there argued that removing
it would let Next try to prerender ~370 pages, many of which were never written to be
static. That concern was legitimate, so the fix was not to delete the line and hope, but
to **invert the default**: make dynamic rendering something a subtree opts into, rather
than something the whole app is forced into.

| Segment | Pages | How it declares itself dynamic |
|---|---|---|
| `dashboard` | 40 | new server `layout.tsx` wrapping `dashboard-shell.tsx` |
| `admin` | 35 | new server `layout.tsx` wrapping `admin-shell.tsx` |
| `classifieds` | 27 | `force-dynamic` on the existing server layout |
| `marketplace-domain` | 17 | `force-dynamic` on the existing server layout |
| `auth` | 7 | new transparent server layout |
| `(portal)/join/[code]` | 1 | per-page — resolves an invite code against live data |

The `dashboard` and `admin` layouts were `'use client'`, and route segment config cannot
be exported from a client module, so each got a thin server `layout.tsx` that renders the
existing client shell. That is not scaffolding for its own sake: putting the
server/client boundary at that file is also what later allows the profile to be read
server-side and passed down, instead of the shell fetching it after hydration.

Result — the build reported **no errors**, so nothing turned out to be unsafe to
prerender:

| | Before | After |
|---|---|---|
| Prerendered HTML files | 0 | **5** |
| `prerender-manifest.json` | absent | present |

Now static: `/` (the landing page, and the highest-volume guest entry point), `/docs`,
`/portal/login`, `/shop/status`, `/_not-found`.

Two things this does **not** yet fix, both deliberate follow-ups:

- **`/shop/[shopSlug]` is still dynamic.** It reads cookies (`createRouteHandlerClient`,
  then `auth.getUser()`) to decide whether an admin is previewing a disabled storefront,
  and reading cookies opts a route out of static generation no matter what `revalidate`
  says. Splitting the admin path onto its own route is what makes the guest storefront
  cacheable.
- **The CDN cannot serve the static `/` yet.** `middleware.ts` calls
  `addNoCacheHeaders(...)` on essentially every matched response, including the
  pass-through for `/`. Prerendering already removes the per-request render at the
  origin, but the round trip itself remains until that header is narrowed.

One behaviour change worth knowing: `/` is ISR with `revalidate = 600`, so an admin
toggle such as `landing_rc_only_enabled` is no longer reflected instantly. It still
propagates promptly in practice, because the landing data comes from
`getCachedPublicConfig()` and admin saves call `revalidateTag(PUBLIC_CONFIG_CACHE_TAG)`,
which invalidates the routes built from it; 600s is the worst case if that path fails.
