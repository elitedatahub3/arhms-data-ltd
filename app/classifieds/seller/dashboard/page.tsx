'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Loader2, Zap, AlertCircle, Plus, CheckCircle } from 'lucide-react'
import { BoostModal } from '@/components/classifieds/boost-modal'
import { ClassifiedsSellerSidebar } from '@/components/classifieds/seller-sidebar'
import { useAuth } from '@/contexts/auth-context'
import { toast } from 'sonner'
import type { ClassifiedListing } from '@/types/supabase'

export default function SellerDashboardPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const { user, session, isLoading: authLoading } = useAuth()
    const [listings, setListings] = useState<ClassifiedListing[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [selectedListingId, setSelectedListingId] = useState<string | null>(null)
    const [boostModalOpen, setBoostModalOpen] = useState(false)
    const [showSuccessMessage, setShowSuccessMessage] = useState(false)

    useEffect(() => {
        // Wait for the auth context to finish hydrating before deciding — otherwise
        // `user` is momentarily null on first render and we'd bounce a logged-in user.
        if (!authLoading && !user) {
            toast.error('Please log in to access seller dashboard')
            router.push('/classifieds/auth/login?redirect=/classifieds/seller/dashboard')
        }
    }, [authLoading, user, router])

    // Handle boost success/error messages
    useEffect(() => {
        const boostSuccess = searchParams.get('boost_success')
        const boostError = searchParams.get('boost_error')
        const boostRef = searchParams.get('boost_ref')

        if (boostSuccess === 'true' || boostRef) {
            setShowSuccessMessage(true)
            toast.success('🚀 Promotion activated successfully!')
            // Clean up URL
            router.replace('/classifieds/seller/dashboard', undefined)
        }

        if (boostError === 'true') {
            toast.error('Failed to activate promotion. Please try again.')
            // Clean up URL
            router.replace('/classifieds/seller/dashboard', undefined)
        }
    }, [searchParams, router])

    useEffect(() => {
        const loadListings = async () => {
            if (!session?.access_token) {
                setIsLoading(false)
                return
            }

            setIsLoading(true)
            try {
                const res = await fetch('/api/classifieds/listings?seller_id=me', {
                    headers: { 'Authorization': `Bearer ${session.access_token}` },
                })

                if (res.ok) {
                    const data = await res.json()
                    setListings(data.listings || [])
                } else if (res.status === 401) {
                    toast.error('Please log in')
                }
            } catch (error) {
                console.error('Error loading listings:', error)
            } finally {
                setIsLoading(false)
            }
        }

        loadListings()
    }, [session?.access_token])

    const handleBoostClick = (listingId: string) => {
        setSelectedListingId(listingId)
        setBoostModalOpen(true)
    }

    const handleBoostSuccess = () => {
        // Refresh listings
        const loadListings = async () => {
            if (!session?.access_token) return

            try {
                const res = await fetch('/api/classifieds/listings?seller_id=me', {
                    headers: { 'Authorization': `Bearer ${session.access_token}` },
                })

                if (res.ok) {
                    const data = await res.json()
                    setListings(data.listings || [])
                    toast.success('Boost activated!')
                }
            } catch (error) {
                console.error('Error refreshing listings:', error)
            }
        }

        loadListings()
        setBoostModalOpen(false)
        setSelectedListingId(null)
    }

    const isBoosted = (listing: ClassifiedListing) => {
        return listing.is_boosted && listing.boosted_until && new Date(listing.boosted_until) > new Date()
    }

    const isBoostExpiringSoon = (listing: ClassifiedListing) => {
        if (!isBoosted(listing)) return false
        const daysLeft = Math.ceil(
            (new Date(listing.boosted_until!).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        )
        return daysLeft <= 3
    }

    const getDaysRemaining = (listing: ClassifiedListing) => {
        if (!listing.boosted_until) return 0
        const daysLeft = Math.ceil(
            (new Date(listing.boosted_until).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        )
        return Math.max(0, daysLeft)
    }

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-[#0a0f1c] flex">
            <ClassifiedsSellerSidebar />

            <div className="flex-1 min-w-0 pb-20 lg:pb-0">
            {/* Header */}
            <div className="bg-white dark:bg-[#151c2c] border-b border-gray-100 dark:border-gray-800">
                <div className="max-w-6xl mx-auto px-6 py-8">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <h1 className="text-3xl font-black text-gray-900 dark:text-white">
                                My Listings
                            </h1>
                            <p className="text-gray-600 dark:text-gray-400 mt-2">
                                Manage and promote your items
                            </p>
                        </div>
                        <Link href="/classifieds/seller/dashboard/new">
                            <Button className="bg-blue-600 hover:bg-blue-700 text-white gap-2 rounded-lg">
                                <Plus className="w-4 h-4" />
                                Post New Listing
                            </Button>
                        </Link>
                    </div>
                </div>
            </div>

            {/* Success Message */}
            {showSuccessMessage && (
                <div className="max-w-6xl mx-auto px-6 pt-6 pb-0">
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 flex items-center gap-3">
                        <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                        <div>
                            <p className="font-semibold text-emerald-900 dark:text-emerald-100">Promotion Activated!</p>
                            <p className="text-sm text-emerald-800 dark:text-emerald-200">Your listing is now featured and will reach more buyers</p>
                        </div>
                        <button
                            onClick={() => setShowSuccessMessage(false)}
                            className="ml-auto text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}

            {/* Main Content */}
            <div className="max-w-6xl mx-auto px-6 py-8">
                {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400 animate-spin" />
                    </div>
                ) : listings.length === 0 ? (
                    <div className="bg-white dark:bg-[#151c2c] rounded-xl border border-gray-100 dark:border-gray-800 p-12 text-center">
                        <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mx-auto mb-4">
                            <span className="text-3xl">📋</span>
                        </div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                            No listings yet
                        </h2>
                        <p className="text-gray-600 dark:text-gray-400 mb-6">
                            Create your first listing and boost it to reach buyers instantly!
                        </p>
                        <Link href="/classifieds/seller/dashboard/new">
                            <Button className="bg-blue-600 hover:bg-blue-700 text-white gap-2 rounded-lg">
                                <Plus className="w-4 h-4" />
                                Create Your First Listing
                            </Button>
                        </Link>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {listings.map(listing => (
                            <div
                                key={listing.id}
                                className="bg-white dark:bg-[#151c2c] rounded-xl border border-gray-100 dark:border-gray-800 p-6 hover:shadow-md transition-shadow"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    {/* Left side: listing info */}
                                    <div className="flex-1">
                                        <div className="flex items-start gap-3 mb-2">
                                            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                                                {listing.title}
                                            </h3>
                                            {isBoosted(listing) && (
                                                <div className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 whitespace-nowrap">
                                                    <Zap className="w-3 h-3" />
                                                    Promoted
                                                </div>
                                            )}
                                        </div>

                                        <p className="text-gray-600 dark:text-gray-400 text-sm mb-2 line-clamp-2">
                                            {listing.description}
                                        </p>

                                        <div className="flex flex-wrap items-center gap-4 text-sm mb-3">
                                            <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
                                                GHS {listing.price.toFixed(2)}
                                            </span>
                                            {listing.location && (
                                                <span className="text-gray-500 dark:text-gray-400">
                                                    📍 {listing.location}
                                                </span>
                                            )}
                                            <span className="text-gray-500 dark:text-gray-400 capitalize">
                                                {listing.condition || 'Used'}
                                            </span>
                                            <span className={`inline-flex px-2 py-1 rounded-md text-xs font-bold ${
                                                listing.status === 'active'
                                                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                                    : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                                            }`}>
                                                {listing.status === 'active' ? '✓ Active' : listing.status}
                                            </span>
                                        </div>

                                        {isBoosted(listing) && (
                                            <p className="text-xs text-amber-600 dark:text-amber-400 font-bold">
                                                ⏰ Promoted until {new Date(listing.boosted_until!).toLocaleDateString()} ({getDaysRemaining(listing)} days left)
                                            </p>
                                        )}
                                    </div>

                                    {/* Right side: action button */}
                                    <div className="flex flex-col items-end gap-2">
                                        {isBoosted(listing) ? (
                                            <>
                                                {isBoostExpiringSoon(listing) && (
                                                    <Button
                                                        onClick={() => handleBoostClick(listing.id)}
                                                        variant="default"
                                                        className="bg-amber-600 hover:bg-amber-700 text-white gap-2 whitespace-nowrap"
                                                    >
                                                        <Zap className="w-4 h-4" />
                                                        Renew Boost
                                                    </Button>
                                                )}
                                                {!isBoostExpiringSoon(listing) && (
                                                    <div className="text-xs text-gray-500 dark:text-gray-400 text-right">
                                                        Promoted &amp; Active
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <Button
                                                onClick={() => handleBoostClick(listing.id)}
                                                className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                                            >
                                                <Zap className="w-4 h-4" />
                                                Boost
                                            </Button>
                                        )}
                                        <Link href={`/classifieds/${listing.id}`}>
                                            <Button variant="outline" size="sm">
                                                View
                                            </Button>
                                        </Link>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Boost Modal */}
            {selectedListingId && (
                <BoostModal
                    open={boostModalOpen}
                    onOpenChange={setBoostModalOpen}
                    listingId={selectedListingId}
                    onSuccess={handleBoostSuccess}
                />
            )}
            </div>
        </div>
    )
}
