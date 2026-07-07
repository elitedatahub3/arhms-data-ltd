'use client'

import { useState } from 'react'
import { Phone, Mail, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SafetyTipsModal } from './safety-tips-modal'
import { toast } from 'sonner'
import type { ClassifiedListing } from '@/types/supabase'

interface ContactRevealButtonProps {
    listing: ClassifiedListing
    userId?: string
}

export function ContactRevealButton({ listing }: ContactRevealButtonProps) {
    const [showSafetyModal, setShowSafetyModal] = useState(false)
    const [contactInfo, setContactInfo] = useState<any>(null)
    const [revealed, setRevealed] = useState(false)

    const handleClick = () => {
        if (revealed) {
            return
        }

        setShowSafetyModal(true)
    }

    // Contact details already ship with the listing (loaded via getListingById on
    // the detail page), so we reveal them directly — no login or extra API call.
    const handleAcknowledgeSafety = () => {
        const l = listing as any
        setContactInfo({
            seller_name: l.users?.first_name,
            phone: l.contact_phone,
            email: l.contact_email,
            location: l.location,
            whatsapp_number: l.whatsapp_number,
            facebook_url: l.facebook_url,
            twitter_url: l.twitter_url,
            instagram_url: l.instagram_url,
        })
        setRevealed(true)
        setShowSafetyModal(false)
        toast.success('Contact information revealed!')
    }

    if (revealed && contactInfo) {
        return (
            <div className="space-y-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                <p className="text-sm font-bold text-emerald-900 dark:text-emerald-300">
                    Contact Details for {contactInfo.seller_name || 'Seller'}
                </p>

                <div className="space-y-2">
                    {contactInfo.phone && (
                        <a
                            href={`tel:${contactInfo.phone}`}
                            className="flex items-center gap-2 p-3 bg-white dark:bg-[#151c2c] rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <Phone className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">PHONE</p>
                                <p className="font-bold text-gray-900 dark:text-white">{contactInfo.phone}</p>
                            </div>
                        </a>
                    )}

                    {contactInfo.email && (
                        <a
                            href={`mailto:${contactInfo.email}`}
                            className="flex items-center gap-2 p-3 bg-white dark:bg-[#151c2c] rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <Mail className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">EMAIL</p>
                                <p className="font-bold text-gray-900 dark:text-white text-sm truncate">{contactInfo.email}</p>
                            </div>
                        </a>
                    )}

                    {contactInfo.location && (
                        <div className="flex items-center gap-2 p-3 bg-white dark:bg-[#151c2c] rounded-lg">
                            <MapPin className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                            <div>
                                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">LOCATION</p>
                                <p className="font-bold text-gray-900 dark:text-white">{contactInfo.location}</p>
                            </div>
                        </div>
                    )}

                    {(contactInfo.whatsapp_number || contactInfo.facebook_url || contactInfo.twitter_url || contactInfo.instagram_url) && (
                        <div className="flex gap-3 p-3 bg-white dark:bg-[#151c2c] rounded-lg">
                            {contactInfo.whatsapp_number && (
                                <a
                                    href={`https://wa.me/${contactInfo.whatsapp_number}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="h-10 w-10 rounded-full bg-[#25D366] hover:bg-[#20bd5a] flex items-center justify-center transition-colors"
                                    aria-label="Contact on WhatsApp"
                                >
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.88 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                                    </svg>
                                </a>
                            )}

                            {contactInfo.facebook_url && (
                                <a
                                    href={contactInfo.facebook_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="h-10 w-10 rounded-full bg-[#1877F2] hover:bg-[#166fe5] flex items-center justify-center transition-colors"
                                    aria-label="Visit Facebook"
                                >
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                                    </svg>
                                </a>
                            )}

                            {contactInfo.twitter_url && (
                                <a
                                    href={contactInfo.twitter_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="h-10 w-10 rounded-full bg-black hover:bg-gray-800 flex items-center justify-center transition-colors"
                                    aria-label="Visit Twitter"
                                >
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.6l-5.165-6.75-5.868 6.75h-3.308l7.732-8.835L.424 2.25h6.679l4.682 6.18 5.459-6.18zM17.534 20.589h1.828L6.975 3.75H5.042l12.492 16.839z" />
                                    </svg>
                                </a>
                            )}

                            {contactInfo.instagram_url && (
                                <a
                                    href={contactInfo.instagram_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="h-10 w-10 rounded-full bg-gradient-to-br from-[#FE7E0D] via-[#D946EF] to-[#0EA5E9] hover:opacity-90 flex items-center justify-center transition-opacity"
                                    aria-label="Visit Instagram"
                                >
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
                                        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0m5.521 17.674c-1.431 2.582-4.169 4.326-7.521 4.326-4.686 0-8.5-3.814-8.5-8.5s3.814-8.5 8.5-8.5c3.352 0 6.09 1.744 7.521 4.326 1.387-1.495 2.249-3.495 2.249-5.826 0-4.686-3.814-8.5-8.5-8.5-4.686 0-8.5 3.814-8.5 8.5 0 2.331.862 4.331 2.249 5.826C6.479 14.348 5.617 12.348 5.617 10c0-3.534 2.866-6.4 6.4-6.4s6.4 2.866 6.4 6.4c0 2.348-.862 4.348-2.249 5.826v.448c1.387-1.495 2.249-3.495 2.249-5.826 0-4.686-3.814-8.5-8.5-8.5" />
                                    </svg>
                                </a>
                            )}
                        </div>
                    )}
                </div>

                <p className="text-xs text-gray-600 dark:text-gray-400">
                    Remember to meet in person, inspect the item before paying, and always be cautious.
                </p>
            </div>
        )
    }

    return (
        <>
            <Button
                onClick={handleClick}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-6 text-base"
            >
                Contact Seller
            </Button>

            <SafetyTipsModal
                open={showSafetyModal}
                onOpenChange={setShowSafetyModal}
                onAcknowledge={handleAcknowledgeSafety}
            />
        </>
    )
}
