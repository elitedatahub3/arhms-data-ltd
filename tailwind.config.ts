import type { Config } from "tailwindcss"
import defaultTheme from "tailwindcss/defaultTheme"

const config = {
    darkMode: ["class"],
    content: [
        './pages/**/*.{ts,tsx}',
        './components/**/*.{ts,tsx}',
        './app/**/*.{ts,tsx}',
        './src/**/*.{ts,tsx}',
        './lib/**/*.{ts,tsx}',       // ← ensures roleConfig classes are never purged
        './contexts/**/*.{ts,tsx}',  // ← covers any context-level class strings
    ],
    safelist: [
        // Dealer sidebar – arbitrary hex gradient stops
        'from-[#6b21a8]',
        'to-[#4c1d95]',
        // Shared gradient directions used in roleConfig
        'bg-gradient-to-b',
        'bg-gradient-to-r',
        'bg-gradient-to-br',
        // Dealer
        'from-purple-800', 'to-indigo-900',
        'from-purple-600', 'to-indigo-800', 'to-indigo-700',
        'text-purple-100', 'text-purple-200',
        'border-r-purple-700/30', 'border-purple-700/30',
        'hover:bg-white/10', 'bg-white/15', 'bg-white/20',
        'text-white/95', 'text-white/85', 'text-purple-200/80', 'text-purple-200/90',
        'border-white/5', 'border-white/10', 'border-white/30',
        'bg-black/25', 'bg-black/10',
        // Agent — deep navy (#0A2A4A base / #123A63 lift / #061C33 deep).
        // These are arbitrary-value classes built at runtime in lib/roles.ts,
        // so the production purge cannot see them without this list.
        'from-[#123A63]', 'to-[#061C33]', 'from-[#0A2A4A]', 'to-[#0A2A4A]',
        'bg-[#0A2A4A]/15', 'text-[#0A2A4A]', 'bg-[#070C14]',
        'text-sky-100', 'text-sky-200', 'text-sky-200/80', 'text-sky-200/90',
        'dark:text-sky-300',
        'border-r-sky-900/40', 'border-sky-900/40',
        // Bottom nav gradient mid-stops (the from/to ends are listed elsewhere).
        'from-brand-gold-light', 'via-brand-gold', 'via-[#0E3255]',
        // Customer — white surfaces, gold-ink text, bright-gold fills
        'bg-white', 'bg-white/85', 'dark:bg-slate-950', 'dark:bg-slate-900/80',
        'border-r-slate-200', 'dark:border-r-slate-800',
        'border-slate-200', 'dark:border-b-slate-800', 'dark:border-slate-800',
        'bg-slate-50', 'dark:bg-slate-800/50', 'border-slate-200/80', 'dark:border-slate-700/60',
        'from-brand-gold', 'to-brand-gold-dark',
        'hover:text-brand-gold-ink', 'dark:hover:text-brand-gold',
        'hover:bg-brand-gold/[0.07]', 'bg-brand-gold/[0.12]', 'bg-brand-gold/15',
        'bg-brand-gold/[0.06]', 'dark:bg-brand-gold/[0.08]',
        'text-brand-gold-ink', 'dark:text-brand-gold',
        'border-brand-gold/25', 'border-brand-gold/20', 'dark:border-brand-gold/20',
        'ring-1', 'ring-inset', 'ring-brand-gold/20', 'ring-brand-gold/25',
        'shadow-soft', 'hover:shadow-soft-lg', 'shadow-nav', 'shadow-gold-fab',
        // Badges / pills
        'bg-violet-500/15', 'text-violet-600', 'dark:text-violet-400',
        'bg-blue-500/15', 'text-blue-600', 'dark:text-blue-400',
        'bg-amber-500/15', 'text-amber-600', 'dark:text-amber-400',
        'bg-rose-500/15', 'text-rose-600', 'dark:text-rose-400',
        'bg-emerald-500/15', 'text-emerald-600', 'dark:text-emerald-400',
    ],
    prefix: "",
    theme: {
        container: {
            center: true,
            padding: "2rem",
            screens: {
                "2xl": "1400px",
            },
        },
        extend: {
            colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                // The 50-900 gold ramp that used to live here contradicted
                // --primary (blue) and had zero usages across the codebase.
                primary: {
                    DEFAULT: 'hsl(var(--primary))',
                    foreground: 'hsl(var(--primary-foreground))',
                },
                // Now on the vars. These were hardcoded #7B68EE / #06B6D4, which
                // meant every shadcn hover surface (dropdown, select, sheet) was
                // painting bright purple or cyan instead of a neutral, and made
                // the --secondary / --accent declarations in the sub-themes
                // dead code. Both are fixed by the indirection.
                secondary: {
                    DEFAULT: "hsl(var(--secondary))",
                    foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive))",
                    foreground: "hsl(var(--destructive-foreground))",
                },
                muted: {
                    DEFAULT: "hsl(var(--muted))",
                    foreground: "hsl(var(--muted-foreground))",
                },
                // shadcn's `accent` stays the SOFT surface so the 25 components/ui
                // files keep working. The accent channel proper is exposed
                // separately below as bg-accent-solid / text-accent-contrast etc.
                accent: {
                    DEFAULT: "hsl(var(--accent))",
                    foreground: "hsl(var(--accent-foreground))",
                    solid: "hsl(var(--accent-solid))",
                    strong: "hsl(var(--accent-strong))",
                    soft: "hsl(var(--accent-soft))",
                    softer: "hsl(var(--accent-softer))",
                    contrast: "hsl(var(--accent-contrast))",
                    ring: "hsl(var(--accent-ring))",
                },
                surface: {
                    0: "hsl(var(--surface-0))",
                    1: "hsl(var(--surface-1))",
                    2: "hsl(var(--surface-2))",
                    3: "hsl(var(--surface-3))",
                },
                "border-strong": "hsl(var(--border-strong))",
                popover: {
                    DEFAULT: "hsl(var(--popover))",
                    foreground: "hsl(var(--popover-foreground))",
                },
                card: {
                    DEFAULT: "hsl(var(--card))",
                    foreground: "hsl(var(--card-foreground))",
                },
                brand: {
                    dark: '#0A0A0A',
                    surface: '#1a1a1a',
                    'surface-light': '#252525',
                    border: '#2d2d2d',
                    light: '#F8FAFC',
                    'light-surface': '#ffffff',
                    'light-border': '#e2e8f0',
                    gold: '#D4AF37',
                    'gold-light': '#E6C547',
                    'gold-dark': '#B89D2E',
                    // Deep bronze-gold for accent TEXT on white surfaces.
                    // #D4AF37 is only 2.1:1 on white and #B89D2E is 2.7:1 — both
                    // fail WCAG AA. This is 6.0:1, so gold-family text stays legible.
                    // Bright gold is still the right choice for fills, where the
                    // near-black label sitting on it carries the contrast.
                    'gold-ink': '#7A5F22',
                },
                network: {
                    mtn: '#FFCC00',
                    telecel: '#E30613',
                    airteltigo: '#ED1C24',
                },
                mtn: {
                    DEFAULT: "#FFCC00",
                    dark: "#E6B800",
                },
                telecel: {
                    DEFAULT: "#E30613",
                    dark: "#CC0511",
                },
                airteltigo: {
                    DEFAULT: "#ED1C24",
                    dark: "#D41920",
                },
                success: {
                    DEFAULT: "hsl(var(--success))",
                    foreground: "hsl(var(--success-foreground))",
                },
                warning: {
                    DEFAULT: "hsl(var(--warning))",
                    foreground: "hsl(var(--warning-foreground))",
                },
                info: {
                    DEFAULT: "hsl(var(--info))",
                    foreground: "hsl(var(--info-foreground))",
                },
            },
            // These must point at next/font's generated CSS vars, not the raw
            // family names. Naming the family directly bypassed next/font
            // entirely, so `font-heading`/`font-body` fell back to whatever
            // "Outfit"/"Inter" the device happened to have installed.
            fontFamily: {
                sans: ['var(--font-body)', ...defaultTheme.fontFamily.sans],
                body: ['var(--font-body)', ...defaultTheme.fontFamily.sans],
                heading: ['var(--font-heading)', ...defaultTheme.fontFamily.sans],
            },
            borderRadius: {
                xs: "var(--radius-xs)",   /* 6px  — dots, count badges */
                sm: "var(--radius-sm)",   /* 10px — all text inputs */
                md: "var(--radius-md)",   /* 14px — buttons, list rows */
                lg: "var(--radius-lg)",   /* 20px — cards */
                xl: "var(--radius-xl)",   /* 28px — sheets, modals */
                "2xl": "var(--radius-xl)",
            },
            fontSize: {
                xs: ['0.75rem', { lineHeight: '1rem' }],
                sm: ['0.875rem', { lineHeight: '1.25rem' }],
                base: ['1rem', { lineHeight: '1.5rem' }],
                lg: ['1.125rem', { lineHeight: '1.75rem' }],
                xl: ['1.25rem', { lineHeight: '1.75rem' }],
                '2xl': ['1.5rem', { lineHeight: '2rem' }],
                '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
                '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
                '5xl': ['3rem', { lineHeight: '1' }],
                '6xl': ['3.75rem', { lineHeight: '1' }],
                '7xl': ['4.5rem', { lineHeight: '1' }],
            },
            // Elevation is semantic, not a size ramp: e1 resting card, e2
            // hover/sticky header, e3 popover/sticky action bar, e4 modal+sheet.
            // Because the page and cards are both pure white, e1 plus the border
            // is what gives a card its edge.
            boxShadow: {
                e1: 'var(--elev-1)',
                e2: 'var(--elev-2)',
                e3: 'var(--elev-3)',
                e4: 'var(--elev-4)',
                glow: 'var(--glow-accent)',
                'glow-lg': 'var(--glow-accent-lg)',
                'inset-top': 'inset 0 1px 0 hsl(0 0% 100% / 0.08)',
                // Compatibility aliases so nothing silently loses its shadow
                // mid-migration. `gold`/`gold-lg` are still referenced by three
                // components/ui/button.tsx variants and go away in Phase 2 with
                // the variant rewrite; the rest follow the role safelist in
                // Phase 4 and are deleted in Phase 7.
                soft: 'var(--elev-1)',
                'soft-lg': 'var(--elev-2)',
                nav: 'var(--elev-3)',
                'gold-fab': 'var(--glow-accent)',
                gold: 'var(--glow-accent)',
                'gold-lg': 'var(--glow-accent-lg)',
                glass: 'var(--elev-3)',
            },
            backgroundImage: {
                'gradient-brand': 'var(--gradient-brand)',
                'gradient-brand-soft': 'var(--gradient-brand-soft)',
                'gradient-accent': 'var(--gradient-accent)',
                'gradient-wash': 'var(--gradient-wash)',
            },
            // 300ms on every hover was a large part of why the UI felt sluggish.
            transitionDuration: {
                DEFAULT: '150ms',
            },
            backdropBlur: {
                xs: '2px',
                sm: '4px',
                base: '8px',
                md: '12px',
                lg: '16px',
                xl: '24px',
            },
            keyframes: {
                "accordion-down": {
                    from: { height: "0" },
                    to: { height: "var(--radix-accordion-content-height)" },
                },
                "accordion-up": {
                    from: { height: "var(--radix-accordion-content-height)" },
                    to: { height: "0" },
                },
                shimmer: {
                    "100%": {
                        transform: "translateX(100%)",
                    },
                },
                fadeIn: {
                    from: { opacity: "0" },
                    to: { opacity: "1" },
                },
                slideIn: {
                    from: { transform: "translateY(-10px)", opacity: "0" },
                    to: { transform: "translateY(0)", opacity: "1" },
                },
                // One compositor-only transform. Replaces the stacked
                // `animate-in slide-in-from-bottom duration-300` on the checkout
                // sheet, which animated more properties than it needed to.
                "sheet-up": {
                    from: { transform: "translateY(100%)" },
                    to: { transform: "translateY(0)" },
                },
            },
            animation: {
                "accordion-down": "accordion-down 0.2s ease-out",
                "accordion-up": "accordion-up 0.2s ease-out",
                shimmer: "shimmer 2s infinite",
                // `pulse` is deliberately NOT redefined: the old override was
                // identical to Tailwind's built-in, and shadowing it meant
                // components/ui/skeleton.tsx depended on our copy.
                fadeIn: "fadeIn 0.3s ease-out",
                slideIn: "slideIn 0.3s ease-out",
                "sheet-up": "sheet-up 220ms cubic-bezier(.32,.72,0,1)",
            },
        },
    },
    plugins: [require("tailwindcss-animate")],
} satisfies Config

export default config
