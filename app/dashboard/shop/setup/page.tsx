'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Store, Upload, Phone, Mail, MessageCircle, Palette, Eye, Save,
    Loader2, ExternalLink, ArrowLeft, ChevronDown, ChevronUp, Users,
    X, Trash2, CheckCircle2, XCircle, AlertTriangle, ImageIcon, RefreshCw
} from 'lucide-react'
import { cn, normalizeWhatsAppNumber } from '@/lib/utils'
import { toast } from 'sonner'


// ─── Brand Presets ────────────────────────────────────────────────────────────
const BRAND_PRESETS = [
    { name: 'Gold', color: '#FFCE00', accent: '#e6b800' },
    { name: 'Green', color: '#25D366', accent: '#1ebc57' },
    { name: 'Red', color: '#E60000', accent: '#cc0000' },
    { name: 'Ocean Blue', color: '#2563eb', accent: '#1e40af' },
    { name: 'Emerald', color: '#059669', accent: '#065f46' },
    { name: 'Purple', color: '#7c3aed', accent: '#5b21b6' },
    { name: 'Orange', color: '#ea580c', accent: '#c2410c' },
    { name: 'Rose', color: '#e11d48', accent: '#be123c' },
    { name: 'Teal', color: '#0d9488', accent: '#0f766e' },
    { name: 'Slate', color: '#475569', accent: '#334155' },
    { name: 'Amber', color: '#d97706', accent: '#b45309' },
]

// ─── Divider Presets ──────────────────────────────────────────────────────────
const DIVIDER_PRESETS: { id: string; label: string; path: string; popular?: boolean }[] = [
    {
        id: 'asymmetric-curve', label: 'Asymmetrical Curve', popular: true,
        path: 'M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V120H0V0C0,0,0,0,0,0c0,0,0,0,0,0Q160.69,78,321.39,56.44Z'
    },
    {
        id: 'angled', label: 'Angled Divider', popular: true,
        path: 'M0,0 L1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'zigzag', label: 'Geometric Zig-Zag', popular: true,
        path: 'M0,60 L100,0 L200,60 L300,0 L400,60 L500,0 L600,60 L700,0 L800,60 L900,0 L1000,60 L1100,0 L1200,60 L1200,120 L0,120 Z'
    },
    {
        id: 'concave', label: 'Concave Curve', popular: true,
        path: 'M0,0 Q600,120 1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'animated-wave', label: 'Animated Wave', popular: true,
        path: 'M0,64 C150,100 350,0 600,60 C850,120 1050,20 1200,64 L1200,120 L0,120 Z'
    },
    {
        id: 'layered-waves', label: 'Layered Waves',
        path: 'M0,80 C200,20 400,100 600,60 C800,20 1000,100 1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'tilt', label: 'Tilt Divider',
        path: 'M0,40 L1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'organic-blob', label: 'Organic Blob',
        path: 'M0,80 C100,20 300,100 500,70 C700,40 900,110 1100,60 C1150,45 1180,50 1200,60 L1200,120 L0,120 Z'
    },
    {
        id: 'paper-cut', label: 'Paper Cut',
        path: 'M0,80 L120,40 L240,80 L360,40 L480,80 L600,40 L720,80 L840,40 L960,80 L1080,40 L1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'torn-edge', label: 'Torn Edge',
        path: 'M0,90 L30,70 L60,95 L90,65 L130,85 L170,60 L210,90 L260,55 L310,80 L370,50 L430,85 L490,58 L560,90 L640,55 L720,85 L800,50 L880,80 L960,45 L1040,75 L1120,50 L1200,70 L1200,120 L0,120 Z'
    },
    {
        id: 'convex', label: 'Convex Curve',
        path: 'M0,120 Q600,0 1200,120 L1200,120 L0,120 Z'
    },
    {
        id: 'slant', label: 'Slant Transition',
        path: 'M0,80 L1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'skewed', label: 'Skewed Transition',
        path: 'M0,0 L900,0 L1200,120 L0,120 Z'
    },
    {
        id: 'glassmorphic', label: 'Glassmorphic Glow',
        path: 'M0,100 Q600,60 1200,100 L1200,120 L0,120 Z'
    },
    {
        id: 'multi-step-wave', label: 'Multi-Step Wave',
        path: 'M0,60 C100,40 200,80 300,60 C400,40 500,80 600,60 C700,40 800,80 900,60 C1000,40 1100,80 1200,60 L1200,120 L0,120 Z'
    },
]

const POPULAR_DIVIDERS = DIVIDER_PRESETS.filter(d => d.popular)
const EXTRA_DIVIDERS = DIVIDER_PRESETS.filter(d => !d.popular)

// ─── Detect community platform ────────────────────────────────────────────────
function detectPlatform(url: string): { label: string; color: string } | null {
    if (!url) return null
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        if (hostname.includes('whatsapp.com')) return { label: 'WhatsApp', color: '#25D366' }
        if (hostname.includes('t.me') || hostname.includes('telegram')) return { label: 'Telegram', color: '#229ED9' }
        if (hostname.includes('facebook.com') || hostname.includes('fb.com')) return { label: 'Facebook', color: '#1877F2' }
        if (hostname.includes('youtube.com')) return { label: 'YouTube', color: '#FF0000' }
        if (hostname.includes('tiktok.com')) return { label: 'TikTok', color: '#000000' }
        if (hostname.includes('instagram.com')) return { label: 'Instagram', color: '#E1306C' }
        return { label: 'Link', color: '#6b7280' }
    } catch { return null }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface ShopForm {
    shop_name: string
    shop_slug: string
    description: string
    owner_phone: string
    owner_email: string
    whatsapp_number: string
    community_link: string
    brand_color: string
    brand_accent: string
    is_active: boolean
    divider_style: string
    banner_pos_x: number
    banner_pos_y: number
    banner_zoom: number
}

// ─── Progress Steps ───────────────────────────────────────────────────────────
const STEPS = ['Details', 'Contact', 'Community', 'Branding']

const SectionHeader = ({ 
    title, icon, isCollapsed, onToggle 
}: { 
    title: string; icon: React.ReactNode; isCollapsed: boolean; onToggle: () => void 
}) => (
    <CardHeader
        className="cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
        onClick={onToggle}
    >
        <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">{icon}{title}</span>
            {isCollapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
        </CardTitle>
    </CardHeader>
)

export default function ShopSetupPage() {
    const { dbUser, isSubAgent } = useAuth()
    // A sub-agent's shop dashboard lives under /dashboard/sub/shop.
    const shopHome = isSubAgent ? '/dashboard/sub/shop' : '/dashboard/shop'
    const router = useRouter()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const bannerInputRef = useRef<HTMLInputElement>(null)
    const cropCanvasRef = useRef<HTMLCanvasElement>(null)
    const pendingNavRef = useRef<string | null>(null)
    
    // Hex Color Validator
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)

    const [existingShopId, setExistingShopId] = useState<string | null>(null)
    // Non-null when we could not determine whether a shop exists — distinct from
    // "no shop yet", so a failed check never renders the create form.
    const [loadError, setLoadError] = useState<string | null>(null)
    const [savedIsActive, setSavedIsActive] = useState(true)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [uploading, setUploading] = useState(false)
    const [uploadingBanner, setUploadingBanner] = useState(false)
    const [logoUrl, setLogoUrl] = useState<string | null>(null)
    const [logoPreview, setLogoPreview] = useState<string | null>(null)
    const [bannerUrl, setBannerUrl] = useState<string | null>(null)
    const [bannerPreview, setBannerPreview] = useState<string | null>(null)
    const [cropMode, setCropMode] = useState(false)
    const [rawBannerFile, setRawBannerFile] = useState<File | null>(null)
    const [slugTaken, setSlugTaken] = useState(false)
    const [slugChecking, setSlugChecking] = useState(false)
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
    const [showUnsavedModal, setShowUnsavedModal] = useState(false)
    const [showAllDividers, setShowAllDividers] = useState(false)
    const [communityLinkError, setCommunityLinkError] = useState('')
    const [activeStep, setActiveStep] = useState(0)
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

    // Collapsible sections
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
    const toggleSection = (key: string) => setCollapsed(p => ({ ...p, [key]: !p[key] }))

    const [form, setForm] = useState<ShopForm>({
        shop_name: '',
        shop_slug: '',
        description: '',
        owner_phone: '',
        owner_email: '',
        whatsapp_number: '',
        community_link: '',
        brand_color: '#2563eb',
        brand_accent: '#1e40af',
        is_active: true,
        divider_style: 'asymmetric-curve',
        banner_pos_x: 50,
        banner_pos_y: 50,
        banner_zoom: 1,
    })

    const updateForm = useCallback((updates: Partial<ShopForm>) => {
        setForm(prev => ({ ...prev, ...updates }))
        setHasUnsavedChanges(true)
    }, [])

    // Auto-expand dividers if currently selected is in extra list
    useEffect(() => {
        if (EXTRA_DIVIDERS.some(d => d.id === form.divider_style)) {
            setShowAllDividers(true)
        }
    }, [form.divider_style])

    useEffect(() => {
        if (dbUser) fetchExistingShop()
    }, [dbUser])

    const fetchExistingShop = async () => {
        setLoadError(null)
        try {
            // Read through the API (service role) instead of the browser client:
            // a failed read here used to be swallowed, leaving an owner looking at
            // a blank "Create Your Shop" form as though their shop was gone.
            const res = await fetch('/api/shop/profile', { cache: 'no-store' })
            const payload = await res.json().catch(() => null)
            if (!res.ok) {
                setLoadError(payload?.error || 'Could not load your shop. Please try again.')
                return
            }
            const data = payload?.shop

            if (data) {
                setExistingShopId(data.id)
                setLogoUrl(data.logo_url)
                setLogoPreview(data.logo_url)
                setBannerUrl(data.banner_url || null)
                setBannerPreview(data.banner_url || null)
                const normalizedWA = normalizeWhatsAppNumber(data.whatsapp_number || '')
                setSavedIsActive(data.is_active ?? true)
                setForm({
                    shop_name: data.shop_name || '',
                    shop_slug: data.shop_slug || '',
                    description: data.description || '',
                    owner_phone: data.owner_phone || '',
                    owner_email: data.owner_email || '',
                    whatsapp_number: normalizedWA,
                    community_link: data.community_link || '',
                    brand_color: data.brand_color || '#2563eb',
                    brand_accent: data.brand_accent || '#1e40af',
                    is_active: data.is_active ?? true,
                    divider_style: data.divider_style || 'asymmetric-curve',
                    banner_pos_x: data.banner_pos_x ?? 50,
                    banner_pos_y: data.banner_pos_y ?? 50,
                    banner_zoom: data.banner_zoom ?? 1,
                })
            }
        } catch (err) {
            console.error('[ShopSetup] Failed to fetch existing shop:', err)
            setLoadError('Could not load your shop. Check your connection and try again.')
        } finally {
            setLoading(false)
        }
    }

    const generateSlug = (name: string) =>
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    const handleNameChange = (value: string) => {
        updateForm({
            shop_name: value,
            shop_slug: existingShopId ? form.shop_slug : generateSlug(value),
        })
    }

    const checkSlug = async (slug: string) => {
        if (!slug || slug.length < 3) return
        setSlugChecking(true)
        const { data } = await ((supabase as any)
            .from('shop_profiles')
            .select('id')
            .eq('shop_slug', slug)
            .neq('owner_id', dbUser!.id)
            .maybeSingle())
        setSlugTaken(!!data)
        setSlugChecking(false)
    }

    // ─── Logo Upload ─────────────────────────────────────────────────────────
    const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) { toast.error('Logo must be under 5MB'); return }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            toast.error('Only JPG, PNG, or WEBP images allowed'); return
        }
        const reader = new FileReader()
        reader.onload = (ev) => setLogoPreview(ev.target?.result as string)
        reader.readAsDataURL(file)
        setUploading(true)
        try {
            const ext = file.name.split('.').pop()
            const path = `${dbUser!.id}/logo_${Date.now()}.${ext}`
            const { error } = await supabase.storage.from('shop-logos').upload(path, file, { upsert: true })
            if (error) throw error
            const { data: urlData } = supabase.storage.from('shop-logos').getPublicUrl(path)
            setLogoUrl(urlData.publicUrl)
            setHasUnsavedChanges(true)
            toast.success('Logo uploaded!')
        } catch { toast.error('Upload failed. Please try again.'); setLogoPreview(logoUrl) }
        finally { setUploading(false) }
    }

    // ─── Banner Upload ────────────────────────────────────────────────────────────
    const handleBannerSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        if (file.size > 10 * 1024 * 1024) { toast.error('Banner must be under 10MB'); return }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            toast.error('Only JPG, PNG, or WEBP images allowed'); return
        }
        
        // Auto-upload immediately
        uploadBannerFile(file)
    }

    const uploadBannerFile = async (file: File | Blob) => {
        setUploadingBanner(true)
        try {
            const ext = (file instanceof File) ? file.name.split('.').pop() : 'webp'
            const path = `${dbUser!.id}/banner_${Date.now()}.${ext}`
            const { error } = await supabase.storage.from('shop-banners').upload(path, file, { upsert: true })
            if (error) throw error
            
            const { data: urlData } = supabase.storage.from('shop-banners').getPublicUrl(path)
            setBannerUrl(urlData.publicUrl)
            setBannerPreview(urlData.publicUrl)
            setHasUnsavedChanges(true)
            toast.success('Banner uploaded! Use the sliders to reposition.')
        } catch (err: any) { 
            toast.error(err.message || 'Banner upload failed.') 
        } finally { 
            setUploadingBanner(false) 
        }
    }

    // Draggable positioning logic
    const handleBannerDrag = (e: React.MouseEvent | React.TouchEvent) => {
        if (uploadingBanner || !bannerPreview) return
        const container = (e.currentTarget as HTMLElement).getBoundingClientRect()
        let clientX, clientY
        if ('touches' in e) {
            clientX = e.touches[0].clientX
            clientY = e.touches[0].clientY
        } else {
            clientX = e.clientX
            clientY = e.clientY
        }

        const x = ((clientX - container.left) / container.width) * 100
        const y = ((clientY - container.top) / container.height) * 100
        
        updateForm({ 
            banner_pos_x: Math.max(0, Math.min(100, Math.round(x))),
            banner_pos_y: Math.max(0, Math.min(100, Math.round(y)))
        })
    }

    // ─── WhatsApp derived state ───────────────────────────────────────────────
    const normalizedWA = normalizeWhatsAppNumber(form.whatsapp_number)
    const waValid = !normalizedWA || /^233\d{9}$/.test(normalizedWA)

    // ─── Save ─────────────────────────────────────────────────────────────────
    const handleSave = async (thenNavigate?: string) => {
        setFieldErrors({}) // clear previous errors
        
        // Basic frontend guards
        if (!form.shop_name.trim()) { setFieldErrors(prev => ({ ...prev, shop_name: 'Shop name is required' })); return }
        if (!form.shop_slug.trim() || form.shop_slug.length < 3) { setFieldErrors(prev => ({ ...prev, shop_slug: 'Slug must be at least 3 characters' })); return }
        if (!form.owner_phone.trim()) { setFieldErrors(prev => ({ ...prev, owner_phone: 'Owner phone is required' })); return }
        if (slugTaken) { setFieldErrors(prev => ({ ...prev, shop_slug: 'This slug is already taken' })); return }
        if (form.whatsapp_number && !waValid) { setFieldErrors(prev => ({ ...prev, whatsapp_number: 'Invalid WhatsApp number format' })); return }
        if (form.community_link && !form.community_link.startsWith('https://')) {
            setFieldErrors(prev => ({ ...prev, community_link: 'Community link must start with https://' })); return
        }
        if (form.owner_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.owner_email.trim())) {
            setFieldErrors(prev => ({ ...prev, owner_email: 'Must be a valid email address' }))
            return
        }

        setSaving(true)
        try {
            const finalWA = normalizeWhatsAppNumber(form.whatsapp_number)
            const payload = {
                shop_name: form.shop_name.trim(),
                shop_slug: form.shop_slug.trim(),
                description: form.description.trim().slice(0, 400),
                owner_phone: form.owner_phone.trim(),
                owner_email: form.owner_email.trim() || null,
                whatsapp_number: finalWA || null,
                community_link: form.community_link.trim() || null,
                brand_color: form.brand_color,
                brand_accent: form.brand_accent,
                logo_url: logoUrl || null,
                banner_url: bannerUrl || null,
                banner_pos_x: form.banner_pos_x,
                banner_pos_y: form.banner_pos_y,
                banner_zoom: form.banner_zoom,
                divider_style: form.divider_style,
                is_active: form.is_active,
            }

            const method = existingShopId ? 'PUT' : 'POST'
            const send = (verb: 'POST' | 'PUT') => fetch('/api/shop/profile', {
                method: verb,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })

            let res = await send(method)
            let data = await res.json()

            // "You already have a shop" on create means this form opened without
            // knowing about it — save the edit instead of dead-ending the owner.
            if (res.status === 409 && data?.alreadyExists) {
                if (data.shopId) setExistingShopId(data.shopId)
                res = await send('PUT')
                data = await res.json()
            }

            if (!res.ok) {
                if (data.details && Array.isArray(data.details)) {
                    const newErrors: Record<string, string> = {}
                    data.details.forEach((err: string) => {
                        const [field, ...rest] = err.split(':')
                        if (field && rest.length) {
                            newErrors[field.trim()] = rest.join(':').trim()
                        }
                    })
                    setFieldErrors(newErrors)
                    throw new Error(data.error || 'Please fix the highlighted fields.')
                }
                throw new Error(data.error || 'Failed to save shop')
            }

            toast.success(existingShopId ? 'Shop updated!' : 'Shop created successfully!')
            setHasUnsavedChanges(false)
            setSavedIsActive(form.is_active)
            if (thenNavigate) router.push(thenNavigate)
            else router.push(shopHome)
        } catch (err: any) {
            toast.error(err.message || 'Failed to save shop')
        } finally {
            setSaving(false)
        }
    }

    // ─── Unsaved Changes Navigation Guard ────────────────────────────────────
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = '' }
        }
        window.addEventListener('beforeunload', handleBeforeUnload)
        return () => window.removeEventListener('beforeunload', handleBeforeUnload)
    }, [hasUnsavedChanges])

    const handleNavAway = (href: string) => {
        if (hasUnsavedChanges) {
            pendingNavRef.current = href
            setShowUnsavedModal(true)
        } else {
            router.push(href)
        }
    }

    if (loading) {
        return (
            <div className="space-y-6 max-w-2xl">
                <Skeleton className="h-8 w-48" />
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
        )
    }

    if (loadError) {
        return (
            <div className="space-y-4 max-w-2xl">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Store className="w-6 h-6 text-emerald-600" /> Shop
                </h1>
                <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-900 p-4 text-sm text-amber-900 dark:text-amber-300">
                    {loadError}
                </div>
                <Button
                    onClick={() => { setLoading(true); fetchExistingShop() }}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                >
                    <RefreshCw className="w-4 h-4" /> Try again
                </Button>
            </div>
        )
    }

    const shopUrl = form.shop_slug ? `${process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')}/shop/${form.shop_slug}` : ''
    const dividerList = showAllDividers ? DIVIDER_PRESETS : POPULAR_DIVIDERS
    const platform = detectPlatform(form.community_link)

    return (
        <div className="space-y-6 max-w-2xl pb-48 md:pb-32 setup-theme">
            {/* Dynamic CSS variables with sanitization */}
            <style dangerouslySetInnerHTML={{ __html: `
                .setup-theme { 
                    --brand-color: ${isValidHex(form.brand_color) ? form.brand_color : '#2563eb'}; 
                    ${platform ? `--platform-color: ${platform.color};` : ''}
                }
                ${BRAND_PRESETS.map((p, i) => `.preset-bg-${i} { background-color: ${p.color}; }`).join('\n')}
            `}} />

            {/* Unsaved Changes Modal */}
            {showUnsavedModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full space-y-4 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                                <AlertTriangle className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 dark:text-white">You have unsaved changes</p>
                                <p className="text-xs text-muted-foreground mt-0.5">If you leave now, your changes will be lost.</p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => {
                                    setShowUnsavedModal(false)
                                    if (pendingNavRef.current) router.push(pendingNavRef.current)
                                    pendingNavRef.current = null
                                }}
                            >
                                Ignore
                            </Button>
                            <Button
                                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                disabled={saving}
                                onClick={async () => {
                                    setShowUnsavedModal(false)
                                    await handleSave(pendingNavRef.current || undefined)
                                    pendingNavRef.current = null
                                }}
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                                Save &amp; Continue
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="space-y-4">
                <button onClick={() => handleNavAway(shopHome)}>
                    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-emerald-600 transition-colors -ml-2 px-2 py-1 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/10">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Shop Dashboard
                    </span>
                </button>
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Store className="w-6 h-6 text-emerald-600" />
                        {existingShopId ? 'Edit Shop' : 'Create Your Shop'}
                    </h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        {existingShopId ? 'Update your shop details and branding.' : 'Set up your reseller storefront.'}
                    </p>
                </div>

                {/* Progress Stepper */}
                <div className="flex items-center gap-1">
                    {STEPS.map((step, i) => (
                        <div key={step} className="flex items-center gap-1 flex-1">
                            <div className={cn(
                                'h-1.5 flex-1 rounded-full transition-colors duration-300',
                                i <= activeStep ? 'bg-emerald-500' : 'bg-gray-200 dark:bg-gray-700'
                            )} />
                            {i < STEPS.length - 1 && (
                                <span className="text-[9px] font-bold text-muted-foreground whitespace-nowrap hidden sm:inline">{step}</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* ── CARD 1: Shop Details ────────────────────────────────────── */}
            <Card onFocusCapture={() => setActiveStep(0)}>
                <SectionHeader 
                    title="Shop Details" 
                    icon={<Store className="w-4 h-4 text-emerald-600" />} 
                    isCollapsed={!!collapsed['details']} 
                    onToggle={() => { toggleSection('details'); setActiveStep(0); }} 
                />
                {!collapsed['details'] && (
                    <CardContent className="space-y-4">
                        <div>
                            <Label htmlFor="shop_name">Shop Name *</Label>
                            <Input
                                id="shop_name"
                                value={form.shop_name}
                                onChange={(e) => { 
                                    handleNameChange(e.target.value) 
                                    setFieldErrors(p => ({ ...p, shop_name: '' })) 
                                }}
                                placeholder="e.g. Kofi's Data Shop"
                                className={cn("mt-1", fieldErrors.shop_name && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.shop_name && <p className="text-xs text-red-500 mt-1">{fieldErrors.shop_name}</p>}
                            <p className="text-xs text-muted-foreground mt-1">This will be the browser title on your shop page.</p>
                        </div>

                        <div>
                            <Label htmlFor="shop_slug">Shop URL Slug *</Label>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-sm text-muted-foreground whitespace-nowrap">/shop/</span>
                                <Input
                                    id="shop_slug"
                                    value={form.shop_slug}
                                    onChange={(e) => {
                                        const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                                        updateForm({ shop_slug: slug })
                                        setFieldErrors(p => ({ ...p, shop_slug: '' }))
                                        checkSlug(slug)
                                    }}
                                    placeholder="kofi-data-shop"
                                    className={cn((slugTaken || fieldErrors.shop_slug) && 'border-red-500 focus-visible:ring-red-500')}
                                />
                                {slugChecking && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                            </div>
                            {slugTaken && <p className="text-xs text-red-500 mt-1">This slug is already taken. Choose another.</p>}
                            {fieldErrors.shop_slug && !slugTaken && <p className="text-xs text-red-500 mt-1">{fieldErrors.shop_slug}</p>}
                            {form.shop_slug && !slugTaken && !fieldErrors.shop_slug && (
                                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                                    Preview: <span className="font-mono">{shopUrl}</span>
                                    <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="ml-1" title="Open storefront" aria-label="Open storefront">
                                        <ExternalLink className="w-3 h-3" />
                                    </a>
                                </p>
                            )}
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <Label htmlFor="description">Description</Label>
                                <span className={cn(
                                    'text-xs font-medium tabular-nums',
                                    form.description.length > 380 ? 'text-red-500' :
                                        form.description.length > 300 ? 'text-amber-500' : 'text-muted-foreground'
                                )}>{form.description.length}/400</span>
                            </div>
                            <Textarea
                                id="description"
                                value={form.description}
                                onChange={(e) => {
                                    updateForm({ description: e.target.value })
                                    setFieldErrors(p => ({ ...p, description: '' }))
                                }}
                                placeholder="Describe your shop (shown as subtitle and meta description)"
                                rows={3}
                                maxLength={400}
                                className={cn("mt-0", fieldErrors.description && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.description && <p className="text-xs text-red-500 mt-1">{fieldErrors.description}</p>}
                        </div>

                        {/* Open/Close Toggle */}
                        <div className="rounded-xl border p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <p className="text-sm font-semibold">Shop Status</p>
                                <span className={cn(
                                    'text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full',
                                    savedIsActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                                        'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                )}>
                                    Currently: {savedIsActive ? 'OPEN' : 'CLOSED'}
                                </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => updateForm({ is_active: true })}
                                    className={cn(
                                        'flex items-center justify-center gap-2 py-3 px-4 rounded-xl border-2 font-bold text-sm transition-all duration-200',
                                        form.is_active
                                            ? 'bg-emerald-500 border-emerald-500 text-white shadow-md shadow-emerald-200 dark:shadow-emerald-900/30'
                                            : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:border-emerald-300'
                                    )}
                                >
                                    <CheckCircle2 className="w-4 h-4" /> Open
                                </button>
                                <button
                                    type="button"
                                    onClick={() => updateForm({ is_active: false })}
                                    className={cn(
                                        'flex items-center justify-center gap-2 py-3 px-4 rounded-xl border-2 font-bold text-sm transition-all duration-200',
                                        !form.is_active
                                            ? 'bg-red-500 border-red-500 text-white shadow-md shadow-red-200 dark:shadow-red-900/30'
                                            : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:border-red-300'
                                    )}
                                >
                                    <XCircle className="w-4 h-4" /> Closed
                                </button>
                            </div>
                            <p className={cn(
                                'text-xs font-medium rounded-lg px-3 py-2',
                                form.is_active
                                    ? 'bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400'
                                    : 'bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400'
                            )}>
                                {form.is_active
                                    ? '✅ Your shop is live and visible to customers.'
                                    : "❌ Your shop is hidden. Customers will see a 'Closed' page if they visit your link."}
                            </p>
                        </div>
                    </CardContent>
                )}
            </Card>

            {/* ── CARD 2: Contact Information ─────────────────────────────── */}
            <Card onFocusCapture={() => setActiveStep(1)}>
                <SectionHeader 
                    title="Contact Information" 
                    icon={<Phone className="w-4 h-4 text-blue-500" />} 
                    isCollapsed={!!collapsed['contact']} 
                    onToggle={() => { toggleSection('contact'); setActiveStep(1); }} 
                />
                {!collapsed['contact'] && (
                    <CardContent className="space-y-4">
                        <div>
                            <Label htmlFor="owner_phone" className="flex items-center gap-1.5">
                                <Phone className="w-3.5 h-3.5" /> Owner Phone *
                            </Label>
                            <Input
                                id="owner_phone"
                                value={form.owner_phone}
                                onChange={(e) => {
                                    updateForm({ owner_phone: e.target.value })
                                    setFieldErrors(p => ({ ...p, owner_phone: '' }))
                                }}
                                placeholder="0244123456"
                                className={cn("mt-1", fieldErrors.owner_phone && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.owner_phone && <p className="text-xs text-red-500 mt-1">{fieldErrors.owner_phone}</p>}
                            <p className="text-xs text-muted-foreground mt-1">Displayed as contact on your shop page.</p>
                        </div>

                        <div>
                            <Label htmlFor="owner_email" className="flex items-center gap-1.5">
                                <Mail className="w-3.5 h-3.5" /> Email (Optional)
                            </Label>
                            <Input
                                id="owner_email"
                                type="text"
                                value={form.owner_email}
                                onChange={(e) => {
                                    updateForm({ owner_email: e.target.value })
                                    setFieldErrors(p => ({ ...p, owner_email: '' }))
                                }}
                                placeholder="yourname@email.com"
                                className={cn("mt-1", fieldErrors.owner_email && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.owner_email && <p className="text-xs text-red-500 mt-1">{fieldErrors.owner_email}</p>}
                        </div>

                        <div>
                            <Label htmlFor="whatsapp_number" className="flex items-center gap-1.5">
                                <MessageCircle className="w-3.5 h-3.5" /> WhatsApp Number (Optional)
                            </Label>
                            <Input
                                id="whatsapp_number"
                                value={form.whatsapp_number}
                                onChange={(e) => {
                                    updateForm({ whatsapp_number: e.target.value })
                                    setFieldErrors(p => ({ ...p, whatsapp_number: '' }))
                                }}
                                placeholder="0244123456 or +233244123456"
                                className={cn("mt-1", fieldErrors.whatsapp_number && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.whatsapp_number && <p className="text-xs text-red-500 mt-1">{fieldErrors.whatsapp_number}</p>}
                            {form.whatsapp_number.trim() !== '' && !fieldErrors.whatsapp_number && (
                                <p className={cn('text-xs mt-1 flex items-center gap-1', waValid ? 'text-emerald-600' : 'text-red-500')}>
                                    {waValid ? (
                                        <><CheckCircle2 className="w-3 h-3" /> Will be saved as: <span className="font-mono">{normalizedWA}</span>
                                            {' · '}
                                            <a href={`https://wa.me/${normalizedWA}`} target="_blank" rel="noopener noreferrer" className="underline">Test link</a>
                                        </>
                                    ) : (
                                        <><AlertTriangle className="w-3 h-3" /> Invalid format — must be a valid Ghana number</>
                                    )}
                                </p>
                            )}
                            {!form.whatsapp_number && !fieldErrors.whatsapp_number && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    Format: <span className="font-mono">0244123456</span> → becomes a floating WhatsApp button on your shop.
                                </p>
                            )}
                        </div>
                    </CardContent>
                )}
            </Card>

            {/* ── CARD 3: Community Link ──────────────────────────────────── */}
            <Card onFocusCapture={() => setActiveStep(2)}>
                <SectionHeader 
                    title="Community Link (Optional)" 
                    icon={<Users className="w-4 h-4 text-violet-500" />} 
                    isCollapsed={!!collapsed['community']} 
                    onToggle={() => { toggleSection('community'); setActiveStep(2); }} 
                />
                {!collapsed['community'] && (
                    <CardContent className="space-y-3">
                        <div>
                            <Label htmlFor="community_link" className="flex items-center gap-1.5">
                                <Users className="w-3.5 h-3.5" /> Community / Group Link
                                {platform && (
                                    <span className="ml-1 text-[10px] font-black px-2 py-0.5 rounded-full text-white bg-[var(--platform-color)]" title={`${platform.label} community`}>
                                        {platform.label}
                                    </span>
                                )}
                            </Label>
                            <Input
                                id="community_link"
                                type="url"
                                value={form.community_link}
                                onChange={(e) => { 
                                    updateForm({ community_link: e.target.value }); 
                                    setCommunityLinkError('');
                                    setFieldErrors(p => ({ ...p, community_link: '' }))
                                }}
                                onBlur={() => {
                                    if (form.community_link && !form.community_link.startsWith('https://')) {
                                        setCommunityLinkError('Link must start with https://')
                                    }
                                }}
                                placeholder="https://chat.whatsapp.com/... or https://t.me/... or https://fb.com/groups/..."
                                className={cn('mt-1', (communityLinkError || fieldErrors.community_link) && 'border-red-500 focus-visible:ring-red-500')}
                            />
                            {communityLinkError && <p className="text-xs text-red-500 mt-1">{communityLinkError}</p>}
                            {fieldErrors.community_link && <p className="text-xs text-red-500 mt-1">{fieldErrors.community_link}</p>}
                            <p className="text-xs text-muted-foreground mt-1">
                                Share your WhatsApp group, Telegram channel, Facebook group, or any community link where customers can follow your updates.
                            </p>
                        </div>
                    </CardContent>
                )}
            </Card>

            {/* ── CARD 4: Branding ────────────────────────────────────────── */}
            <Card onFocusCapture={() => setActiveStep(3)}>
                <SectionHeader 
                    title="Branding" 
                    icon={<Palette className="w-4 h-4 text-pink-500" />} 
                    isCollapsed={!!collapsed['branding']} 
                    onToggle={() => { toggleSection('branding'); setActiveStep(3); }} 
                />
                {!collapsed['branding'] && (
                    <CardContent className="space-y-6">

                        {/* Banner Upload */}
                        <div className="space-y-4">
                            <Label className="flex items-center gap-1.5 font-bold">
                                <ImageIcon className="w-3.5 h-3.5" /> Shop Banner (Max 10MB)
                            </Label>
                            
                            <div className="relative group">
                                <div 
                                    className="relative w-full aspect-[3/1] rounded-2xl overflow-hidden bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-200 dark:border-gray-700 transition-all hover:border-emerald-500/50"
                                    onClick={(e) => {
                                        if (!bannerPreview) bannerInputRef.current?.click()
                                        else handleBannerDrag(e)
                                    }}
                                    onMouseMove={(e) => { if (e.buttons === 1) handleBannerDrag(e) }}
                                    onTouchMove={handleBannerDrag}
                                >
                                    {bannerPreview ? (
                                        <>
                                            <Image 
                                                src={bannerPreview} 
                                                alt="Banner preview" 
                                                fill 
                                                className="object-cover transition-transform duration-300 touch-none pointer-events-none"
                                                style={{ 
                                                    objectPosition: `${form.banner_pos_x}% ${form.banner_pos_y}%`,
                                                    transform: `scale(${form.banner_zoom})`
                                                }}
                                            />
                                            {/* Reposition Overlay */}
                                            <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center pointer-events-none">
                                                <div className="bg-black/60 backdrop-blur-sm text-white px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2">
                                                    <Upload className="w-4 h-4" /> Tap/Drag to Reposition
                                                </div>
                                            </div>
                                            {uploadingBanner && (
                                                <div className="absolute inset-0 bg-white/60 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center z-20">
                                                    <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                                            {uploadingBanner ? <Loader2 className="w-8 h-8 animate-spin text-emerald-600" /> : <ImageIcon className="w-8 h-8 opacity-20" />}
                                            <div className="text-center">
                                                <p className="text-sm font-black uppercase tracking-tighter">{uploadingBanner ? 'Uploading...' : 'Click to add shop banner'}</p>
                                                <p className="text-[10px] font-bold opacity-60">Ideal aspect ratio: 3:1 (e.g. 1200x400px)</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                
                                {bannerPreview && !uploadingBanner && (
                                    <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 shadow-xl border border-gray-100 dark:border-gray-800 rounded-2xl z-20">
                                        <button 
                                            onClick={() => bannerInputRef.current?.click()}
                                            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-emerald-600 transition-colors"
                                            title="Replace Banner"
                                        >
                                            <RefreshCw className="w-4 h-4" />
                                        </button>
                                        <div className="h-4 w-[1px] bg-gray-200 dark:bg-gray-700" />
                                        <button 
                                            onClick={() => { setBannerPreview(null); setBannerUrl(null); setHasUnsavedChanges(true); }}
                                            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-red-500 transition-colors"
                                            title="Remove Banner"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                )}
                            </div>

                            {bannerPreview && (
                                <div className="space-y-4 pt-2">
                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-gray-400">
                                            <span>Zoom Level</span>
                                            <span className="text-emerald-600">{Math.round(form.banner_zoom * 100)}%</span>
                                        </div>
                                        <input 
                                            type="range" min="1" max="2.5" step="0.01" 
                                            value={form.banner_zoom} 
                                            onChange={(e) => updateForm({ banner_zoom: parseFloat(e.target.value) })}
                                            className="w-full h-1.5 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                                            title="Banner Zoom Level"
                                            aria-label="Banner Zoom Level"
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-gray-400">Horizontal Focus</span>
                                            <input 
                                                type="range" min="0" max="100" 
                                                value={form.banner_pos_x} 
                                                onChange={(e) => updateForm({ banner_pos_x: parseInt(e.target.value) })}
                                                className="w-full h-1.5 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                                                title="Banner Horizontal Focus"
                                                aria-label="Banner Horizontal Focus"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-gray-400">Vertical Focus</span>
                                            <input 
                                                type="range" min="0" max="100" 
                                                value={form.banner_pos_y} 
                                                onChange={(e) => updateForm({ banner_pos_y: parseInt(e.target.value) })}
                                                className="w-full h-1.5 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                                                title="Banner Vertical Focus"
                                                aria-label="Banner Vertical Focus"
                                            />
                                        </div>
                                    </div>
                                    <p className="text-[10px] font-medium text-center text-muted-foreground italic">
                                        💡 You can also drag the image directly in the preview to adjust the focus.
                                    </p>
                                </div>
                            )}

                            <input ref={bannerInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleBannerSelect} title="Upload shop banner" aria-label="Upload shop banner" />
                        </div>

                        {/* Logo Upload */}
                        <div>
                            <Label>Shop Logo (Max 5MB — JPG, PNG, WEBP)</Label>
                            <div
                                className="mt-2 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-emerald-500 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                {logoPreview ? (
                                    <div className="flex flex-col items-center gap-3">
                                        <div className="relative w-20 h-20 rounded-xl overflow-hidden border">
                                            <Image src={logoPreview} alt="Logo preview" fill className="object-contain" />
                                        </div>
                                        <p className="text-xs text-muted-foreground">Click to change logo</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                        {uploading ? <Loader2 className="w-8 h-8 animate-spin text-emerald-600" /> : <Upload className="w-8 h-8" />}
                                        <p className="text-sm font-medium">{uploading ? 'Uploading...' : 'Click to upload logo'}</p>
                                        <p className="text-xs">JPG, PNG, WEBP up to 5MB</p>
                                    </div>
                                )}
                            </div>
                            {logoPreview && (
                                <Button variant="ghost" size="sm" className="mt-1 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/10 gap-1.5 text-xs"
                                    onClick={() => { setLogoPreview(null); setLogoUrl(null); setHasUnsavedChanges(true) }}>
                                    <Trash2 className="w-3.5 h-3.5" /> Remove Logo
                                </Button>
                            )}
                            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleLogoUpload} title="Upload shop logo" aria-label="Upload shop logo" />
                        </div>

                        {/* Color Presets */}
                        <div>
                            <Label>Brand Color</Label>
                            <div className="grid grid-cols-4 gap-2 mt-2">
                                {BRAND_PRESETS.map((preset, idx) => (
                                    <button
                                        key={preset.name}
                                        type="button"
                                        onClick={() => updateForm({ brand_color: preset.color, brand_accent: preset.accent })}
                                        className={cn(
                                            'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all',
                                            form.brand_color.toLowerCase() === preset.color.toLowerCase()
                                                ? 'border-gray-900 dark:border-white scale-105 shadow-md'
                                                : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                                        )}
                                    >
                                        <div className={`w-8 h-8 rounded-full shadow-sm preset-bg-${idx}`} title={preset.name} />
                                        <span className="text-[10px] font-medium text-center leading-tight">{preset.name}</span>
                                    </button>
                                ))}
                            </div>
                            {/* Custom color picker */}
                            <div className="mt-3 flex items-center gap-3">
                                <Label className="text-xs text-muted-foreground whitespace-nowrap">Custom color:</Label>
                                <input
                                    type="color"
                                    value={form.brand_color}
                                    onChange={(e) => updateForm({ brand_color: e.target.value, brand_accent: e.target.value })}
                                    className="w-10 h-10 rounded-lg cursor-pointer border border-gray-200 dark:border-gray-700 p-0.5 bg-transparent"
                                    title="Pick a custom brand color"
                                />
                                <span className="text-xs font-mono text-muted-foreground">{form.brand_color}</span>
                            </div>
                        </div>

                        {/* Divider Selector */}
                        <div>
                            <Label>Section Divider Style</Label>
                            <p className="text-xs text-muted-foreground mt-0.5 mb-3">Choose how the hero section blends into the content below.</p>
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                                {dividerList.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => updateForm({ divider_style: preset.id })}
                                        className={cn(
                                            'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all overflow-hidden',
                                            form.divider_style === preset.id
                                                ? 'border-emerald-500 scale-[1.04] shadow-md shadow-emerald-100 dark:shadow-emerald-900/20'
                                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                                        )}
                                    >
                                        <div className="w-full h-8 rounded-md overflow-hidden bg-[var(--brand-color)]" title="Divider preview">
                                            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="w-full h-full">
                                                <path d={preset.path} fill="white" />
                                            </svg>
                                        </div>
                                        <span className="text-[9px] font-bold text-center leading-tight line-clamp-2">{preset.label}</span>
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowAllDividers(!showAllDividers)}
                                className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 py-2 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors"
                            >
                                {showAllDividers ? <><ChevronUp className="w-3.5 h-3.5" /> Show Less</> : <><ChevronDown className="w-3.5 h-3.5" /> Show More (10)</>}
                            </button>
                        </div>

                        {/* Live Preview */}
                        <div>
                            <Label className="flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" /> Preview</Label>
                            <div className="mt-2 rounded-xl border overflow-hidden shadow-sm">
                                <div className="p-6 text-center bg-[var(--brand-color)]">
                                    <div className="flex flex-col items-center gap-3">
                                        {logoPreview ? (
                                            <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-white shadow-lg flex-shrink-0">
                                                <Image src={logoPreview} alt="Logo" fill className="object-contain" />
                                            </div>
                                        ) : (
                                            <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center flex-shrink-0 shadow-lg">
                                                <Store className="w-8 h-8 text-white" />
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <p className="text-white font-black text-lg truncate leading-tight">{form.shop_name || 'Your Shop Name'}</p>
                                            <p className="text-white/80 text-xs mt-1 line-clamp-2 max-w-[200px] mx-auto">{form.description || 'Your shop description appears here.'}</p>
                                        </div>
                                        {bannerPreview && (
                                            <div className="relative w-full h-20 rounded-xl overflow-hidden mt-1">
                                                <Image src={bannerPreview} alt="Banner" fill className="object-cover" />
                                            </div>
                                        )}
                                    </div>
                                    {/* Divider preview */}
                                    <div className="relative w-full h-8 mt-4 overflow-hidden">
                                        <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="absolute bottom-0 w-full h-full fill-white dark:fill-gray-900">
                                            <path d={(DIVIDER_PRESETS.find(d => d.id === form.divider_style) || DIVIDER_PRESETS[0]).path} />
                                        </svg>
                                    </div>
                                </div>
                                <div className="p-3 bg-white dark:bg-gray-900 flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Buy Now button preview:</span>
                                    <button className="text-xs text-white font-bold px-3 py-1.5 rounded-lg bg-[var(--brand-color)]" title="Action button preview">
                                        Buy Now
                                    </button>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                )}
            </Card>

            {/* ── Sticky Save Bar ─────────────────────────────────────────── */}
            <div className="fixed bottom-[68px] md:bottom-0 left-0 right-0 z-50 p-4 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 flex gap-3 max-w-2xl mx-auto">
                <Button
                    onClick={() => handleSave()}
                    disabled={saving || uploading || uploadingBanner || slugTaken}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white h-12 text-base font-semibold gap-2"
                >
                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    {saving ? 'Saving...' : existingShopId ? 'Save Changes' : 'Create Shop'}
                </Button>
            </div>

            {/* Danger Zone */}
            {existingShopId && (
                <div className="pt-8 border-t">
                    <h3 className="text-sm font-medium text-red-600 mb-2">Danger Zone</h3>
                    <div className="flex items-center justify-between p-4 border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-900 rounded-lg">
                        <div>
                            <p className="font-medium text-red-900 dark:text-red-200">Delete Shop</p>
                            <p className="text-xs text-red-700/80 dark:text-red-300/80">
                                Permanently delete your shop, orders, and wallet. This action cannot be undone.
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={async () => {
                                if (window.confirm('Are you absolutely sure?\n\nThis will permanently delete your shop, all orders, and your profit wallet.\nThis action cannot be undone.')) {
                                    setSaving(true)
                                    try {
                                        const { error } = await supabase.rpc('delete_shop_data')
                                        if (error) throw error
                                        toast.success('Shop deleted successfully')
                                        router.replace(shopHome)
                                    } catch (err: any) {
                                        toast.error(err.message || 'Failed to delete shop')
                                        setSaving(false)
                                    }
                                }
                            }}
                            disabled={saving}
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete Shop'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
