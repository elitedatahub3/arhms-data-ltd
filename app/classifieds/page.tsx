'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { getCategories } from '@/lib/classifieds-queries'
import { ListingGrid } from '@/components/classifieds/listing-grid'
import { Loader2, Search, Grid3x3, List, Plus, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { CategoryPicture } from '@/components/classifieds/category-picture'
import { SellButton } from '@/components/classifieds/sell-button'
import { supabase } from '@/lib/supabase'
import type { ClassifiedListing, ClassifiedCategory } from '@/types/supabase'

export default function ClassifiedsPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const { user, dbUser, isLoading: authLoading } = useAuth()

    const [listings, setListings] = useState<ClassifiedListing[]>([])
    const [allCategories, setAllCategories] = useState<ClassifiedCategory[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [favorites, setFavorites] = useState<string[]>([])
    const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '')
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
    const [showSellGuide, setShowSellGuide] = useState(false)
    const [showBuyGuide, setShowBuyGuide] = useState(false)

    const location = searchParams.get('location') || undefined

    const mainCategories = allCategories.filter(cat => !cat.parent_id).sort((a, b) => a.display_order - b.display_order)

    useEffect(() => {
        const loadData = async () => {
            setIsLoading(true)
            try {
                const categoriesData = await getCategories()
                setAllCategories(categoriesData)
            } catch (error) {
                console.error('Error loading categories:', error)
                setAllCategories([])
            } finally {
                setIsLoading(false)
            }
        }

        loadData()
    }, [])

    useEffect(() => {
        const loadListings = async () => {
            try {
                const params = new URLSearchParams()
                if (location) params.set('location', location)

                const listingsRes = await fetch(`/api/classifieds/promoted?${params.toString()}`)
                if (listingsRes.ok) {
                    const data = await listingsRes.json()
                    setListings(data.promoted_listings || [])
                } else {
                    setListings([])
                }
            } catch (error) {
                console.error('Error loading listings:', error)
                setListings([])
            }
        }

        loadListings()
    }, [location])

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        if (searchQuery) {
            router.push(`/classifieds?q=${encodeURIComponent(searchQuery)}`)
        }
    }

    const handleFavoriteToggle = async (listingId: string) => {
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const token = session?.access_token

            if (!token) {
                alert('Please log in to save favorites')
                return
            }

            const isFavorited = favorites.includes(listingId)
            const endpoint = isFavorited
                ? `/api/classifieds/favorites?listing_id=${listingId}`
                : '/api/classifieds/favorites'

            const response = await fetch(endpoint, {
                method: isFavorited ? 'DELETE' : 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                ...((!isFavorited) && {
                    body: JSON.stringify({ listing_id: listingId }),
                }),
            })

            if (response.ok) {
                if (isFavorited) {
                    setFavorites(favorites.filter(id => id !== listingId))
                } else {
                    setFavorites([...favorites, listingId])
                }
            }
        } catch (error) {
            console.error('Error toggling favorite:', error)
        }
    }

    return (
        <div className="min-h-screen bg-white dark:bg-[#0a0f1c]">
            {/* Hero search header — carries the premium "hero" treatment
                (emerald gradient, inset glow, floating circles, dot grid) with
                the real search form on top. Replaces the old flat banner + promo carousel. */}
            <div className="max-w-7xl mx-auto px-4 pt-4">
                <div className="relative overflow-hidden rounded-2xl shadow-2xl">
                    {/* Gradient base + inset glow */}
                    <div
                        className="absolute inset-0 bg-gradient-to-br from-emerald-600 via-teal-500 to-green-400 dark:from-emerald-700 dark:via-teal-600 dark:to-emerald-500 transition-all duration-700"
                        style={{ boxShadow: 'inset 0 0 100px rgba(16,185,129,0.45)' }}
                    />

                    {/* Floating translucent circles */}
                    <div className="pointer-events-none absolute -top-16 -right-16 w-72 h-72 rounded-full bg-white/5" />
                    <div className="pointer-events-none absolute -bottom-20 -left-12 w-56 h-56 rounded-full bg-white/5" />
                    <div className="pointer-events-none absolute top-6 right-44 w-28 h-28 rounded-full bg-white/5" />

                    {/* Dot-grid overlay */}
                    <div
                        className="pointer-events-none absolute inset-0 opacity-[0.08]"
                        style={{
                            backgroundImage: 'radial-gradient(circle, #ffffff 1px, transparent 1px)',
                            backgroundSize: '22px 22px',
                        }}
                    />

                    {/* Content */}
                    <div className="relative z-10 p-6 md:p-8">
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                                <h2 className="text-white text-xl md:text-2xl font-black leading-tight drop-shadow-md">
                                    What are you looking for?
                                </h2>
                                <p className="hidden sm:block text-white/85 text-sm font-medium mt-1">
                                    Buy and sell anything across Ghana
                                </p>
                            </div>
                            {/* SELL opens a login-less "Become a Seller" popup: enter a phone
                                number → invisible account is provisioned → seller dashboard.
                                Existing sellers skip straight to the dashboard. */}
                            <div className="flex-shrink-0">
                                <SellButton />
                            </div>
                        </div>
                        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
                            <select
                                aria-label="Location filter"
                                className="px-4 py-2.5 rounded-xl bg-white/15 backdrop-blur-md border border-white/25 text-white font-medium focus:ring-2 focus:ring-white/60 focus:outline-none [&>option]:text-gray-900"
                            >
                                <option>All Ghana</option>
                                <option>Ahafo</option>
                                <option>Ashanti</option>
                                <option>Bono</option>
                                <option>Bono East</option>
                                <option>Central</option>
                                <option>Eastern</option>
                                <option>Greater Accra</option>
                                <option>North East</option>
                                <option>Northern</option>
                                <option>Oti</option>
                                <option>Savannah</option>
                                <option>Upper East</option>
                                <option>Upper West</option>
                                <option>Volta</option>
                                <option>Western</option>
                                <option>Western North</option>
                            </select>
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    placeholder="I am looking for..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full px-4 py-2.5 pr-11 rounded-xl bg-white text-gray-900 shadow-lg ring-1 ring-white/30 border-0 focus:ring-2 focus:ring-white focus:outline-none"
                                />
                                <button
                                    type="submit"
                                    aria-label="Search listings"
                                    className="absolute right-3 top-1/2 -translate-y-1/2"
                                >
                                    <Search className="w-5 h-5 text-gray-400" />
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>

            {/* Jiji-style promo row + category grid */}
            <div className="max-w-7xl mx-auto px-4 py-6">
                {/* Promo row (horizontal snap-scroll on mobile, 3-up on sm+) */}
                <div className="flex gap-3 overflow-x-auto snap-x pb-2 -mx-4 px-4 mb-6 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-3 sm:overflow-visible">
                    {/* Niche Intelligence */}
                    <Link
                        href="/classifieds/niche-intelligence"
                        className="flex-shrink-0 w-40 sm:w-auto snap-start rounded-2xl border-2 border-purple-200 bg-purple-100/70 dark:border-purple-800 dark:bg-purple-900/25 p-4 flex flex-col min-h-[150px] transition-transform active:scale-95 hover:shadow-md"
                    >
                        <div className="flex-1 flex items-center justify-center">
                            <span className="text-5xl leading-none" role="img" aria-label="Niche Intelligence">🔍</span>
                        </div>
                        <p className="text-base font-extrabold text-gray-900 dark:text-white leading-tight">Niche Intelligence</p>
                    </Link>

                    {/* How to Sell */}
                    <button
                        type="button"
                        onClick={() => setShowSellGuide(true)}
                        className="flex-shrink-0 w-40 sm:w-auto snap-start text-left rounded-2xl border-2 border-green-200 bg-green-100/70 dark:border-green-800 dark:bg-green-900/25 p-4 flex flex-col min-h-[150px] transition-transform active:scale-95 hover:shadow-md"
                    >
                        <div className="flex-1 flex items-center justify-center">
                            <span className="text-5xl leading-none" role="img" aria-label="How to Sell">💰</span>
                        </div>
                        <p className="text-base font-extrabold text-gray-900 dark:text-white leading-tight">How to Sell</p>
                    </button>

                    {/* How to Buy */}
                    <button
                        type="button"
                        onClick={() => setShowBuyGuide(true)}
                        className="flex-shrink-0 w-40 sm:w-auto snap-start text-left rounded-2xl border-2 border-orange-200 bg-orange-100/70 dark:border-orange-800 dark:bg-orange-900/25 p-4 flex flex-col min-h-[150px] transition-transform active:scale-95 hover:shadow-md"
                    >
                        <div className="flex-1 flex items-center justify-center">
                            <span className="text-5xl leading-none" role="img" aria-label="How to Buy">🛍️</span>
                        </div>
                        <p className="text-base font-extrabold text-gray-900 dark:text-white leading-tight">How to Buy</p>
                    </button>
                </div>

                {/* Category grid (Post ad + Trending, then real categories) */}
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-y-4 gap-x-2 mb-8">
                    {/* Post ad — reuses SellButton's become-a-seller / seller-dashboard flow */}
                    <SellButton className="flex flex-col items-center justify-start gap-1.5 h-auto p-0 bg-transparent hover:bg-transparent shadow-none font-normal group">
                        <span className="w-14 h-14 rounded-2xl bg-amber-400 text-black flex items-center justify-center shadow-sm transition-all active:scale-95 group-hover:bg-amber-500">
                            <Plus className="w-6 h-6" />
                        </span>
                        <span className="text-[11px] font-bold text-center text-gray-700 dark:text-gray-300 leading-tight">Post ad</span>
                    </SellButton>

                    {/* Trending — anchors to the Trending Now feed below */}
                    <a href="#trending" className="flex flex-col items-center gap-1.5 group">
                        <span className="w-14 h-14 rounded-2xl bg-secondary text-foreground/80 flex items-center justify-center shadow-sm transition-all active:scale-95 group-hover:bg-primary/10 group-hover:text-primary">
                            <TrendingUp className="w-6 h-6" />
                        </span>
                        <span className="text-[11px] font-bold text-center text-gray-700 dark:text-gray-300 leading-tight">Trending</span>
                    </a>

                    {/* Real categories from the DB */}
                    {mainCategories.map((cat) => (
                        <Link
                            key={cat.id}
                            href={`/classifieds/category/${cat.id}`}
                            className="flex flex-col items-center gap-1.5 group"
                        >
                            <CategoryPicture
                                imageUrl={cat.image_url}
                                iconName={cat.icon}
                                name={cat.name}
                                className="w-14 h-14 rounded-2xl transition-all active:scale-95 group-hover:opacity-90"
                                iconClassName="w-6 h-6 text-gray-700 dark:text-gray-300"
                            />
                            <span className="text-[11px] font-bold text-center text-gray-700 dark:text-gray-300 leading-tight line-clamp-2">{cat.name}</span>
                        </Link>
                    ))}

                    {mainCategories.length === 0 && isLoading && (
                        <div className="col-span-full flex items-center justify-center py-8">
                            <Loader2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400 animate-spin" />
                        </div>
                    )}
                </div>

                {/* Trending Now feed */}
                <div id="trending" className="scroll-mt-4">
                    {listings.length > 0 && (
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                                Trending ads
                            </h3>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setViewMode('grid')}
                                    aria-label="Grid view"
                                    className={`p-2 rounded ${viewMode === 'grid' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' : 'text-gray-400'}`}
                                >
                                    <Grid3x3 className="w-5 h-5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setViewMode('list')}
                                    aria-label="List view"
                                    className={`p-2 rounded ${viewMode === 'list' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' : 'text-gray-400'}`}
                                >
                                    <List className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    )}

                    {isLoading && listings.length === 0 ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400 animate-spin" />
                        </div>
                    ) : listings.length === 0 ? (
                        <div className="text-center py-12">
                            <p className="text-gray-600 dark:text-gray-400">No trending listings available right now</p>
                        </div>
                    ) : (
                        <ListingGrid
                            listings={listings}
                            isLoading={isLoading}
                            favorites={favorites}
                            onFavoriteToggle={handleFavoriteToggle}
                            viewMode={viewMode}
                        />
                    )}
                </div>
            </div>


            {/* How to Sell Modal */}
            {showSellGuide && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-[#151c2c] rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                        <div className="sticky top-0 bg-white dark:bg-[#151c2c] border-b border-gray-200 dark:border-gray-800 p-6 flex items-center justify-between">
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white">How to Sell</h2>
                            <button
                                type="button"
                                onClick={() => setShowSellGuide(false)}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-2xl"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">1</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Create Your Account</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Sign up with your phone number and verify your account to become a seller.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">2</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Set Up Your Seller Profile</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Add your profile photo, business name, phone number, and location. This helps buyers trust you.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">3</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Post Your First Listing</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Click "Post New Listing" and add product title, description, photos, price, condition, and location.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">4</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Promote Your Listing (Optional)</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Pay a small fee to boost your listing to the top and reach more buyers. Choose from 6 duration options.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">5</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Connect with Buyers</h3>
                                    <p className="text-gray-600 dark:text-gray-400">When a buyer is interested, they'll request your contact info. Respond quickly and negotiate the best deal.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold">6</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Complete the Sale</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Meet the buyer, verify payment, and hand over the product. Mark your listing as sold when complete.</p>
                                </div>
                            </div>

                            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 mt-6">
                                <p className="text-sm text-emerald-900 dark:text-emerald-100">
                                    💡 <strong>Pro Tip:</strong> Use Niche Intelligence to find high-demand products with low competition and maximize your sales potential!
                                </p>
                            </div>

                            <SellButton className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg py-3 font-bold">
                                Start Selling Now
                            </SellButton>
                        </div>
                    </div>
                </div>
            )}

            {/* How to Buy Modal */}
            {showBuyGuide && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-[#151c2c] rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                        <div className="sticky top-0 bg-white dark:bg-[#151c2c] border-b border-gray-200 dark:border-gray-800 p-6 flex items-center justify-between">
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white">How to Buy</h2>
                            <button
                                type="button"
                                onClick={() => setShowBuyGuide(false)}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-2xl"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">1</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Browse the Marketplace</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Browse promoted listings on our homepage or use filters to find items by category, location, or price.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">2</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">View Listing Details</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Click on any listing to see full details, photos, seller info, price, and buyer reviews.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">3</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Save to Favorites (Optional)</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Like an item? Click the heart icon to save it to your favorites for later.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">4</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Request Seller Contact</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Click "Reveal Contact" and read the safety tips to protect yourself during the transaction.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">5</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Negotiate & Arrange Meeting</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Contact the seller via phone or message. Agree on price, condition, and meet-up time and location.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">6</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Meet Safely & Inspect</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Meet in a public place during daytime. Inspect the item thoroughly before making payment.</p>
                                </div>
                            </div>

                            <div className="flex gap-4">
                                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">7</div>
                                <div>
                                    <h3 className="font-bold text-gray-900 dark:text-white mb-2">Complete the Purchase</h3>
                                    <p className="text-gray-600 dark:text-gray-400">Pay the agreed amount and take the product. Keep your receipt or payment proof.</p>
                                </div>
                            </div>

                            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-6 space-y-3">
                                <p className="text-sm font-bold text-blue-900 dark:text-blue-100">🛡️ Safety Tips:</p>
                                <ul className="text-sm text-blue-900 dark:text-blue-100 space-y-1 list-disc list-inside">
                                    <li>Always meet in public places (mall, market, police station)</li>
                                    <li>Bring a friend or family member to the meeting</li>
                                    <li>Check the product thoroughly before paying</li>
                                    <li>Avoid sending money before seeing the item</li>
                                    <li>Report suspicious listings to our team</li>
                                </ul>
                            </div>

                            <button
                                type="button"
                                onClick={() => setShowBuyGuide(false)}
                                className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-3 font-bold"
                            >
                                Start Shopping
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
