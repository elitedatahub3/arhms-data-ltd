'use client'

import { useRouter } from 'next/navigation'
import { PublicProfileScreen } from '@/components/marketplace/public-profile-screen'

/**
 * Preview harness for PublicProfileScreen (dummy data). Delete once wired to the
 * classified_sellers_public view + getSellerListings + a reviews source.
 */
export default function SellerProfileDemoPage() {
    const router = useRouter()
    return <PublicProfileScreen onBack={() => router.push('/classifieds')} />
}
