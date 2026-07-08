'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'

interface Props {
    label?: string
    /** Path the OAuth flow returns to. Defaults to the main-domain callback. */
    callbackPath?: string
    /** Optional post-login destination, forwarded to the callback as `?next=`. */
    next?: string
}

export function GoogleSignInButton({
    label = 'Continue with Google',
    callbackPath = '/auth/callback',
    next,
}: Props) {
    const [isLoading, setIsLoading] = useState(false)

    const handleGoogleSignIn = async () => {
        setIsLoading(true)
        try {
            // Persist the post-login path in a short-lived cookie rather than a
            // ?next= query param: Supabase matches redirectTo against its allow-list
            // and a query string can break an exact match, silently falling back to
            // the Site URL (localhost). Keep redirectTo an EXACT allow-listed URL.
            if (next) {
                document.cookie = `mkt_oauth_next=${encodeURIComponent(next)}; path=/; max-age=600; samesite=lax`
            }
            const redirectTo = `${window.location.origin}${callbackPath}`
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo,
                    queryParams: {
                        access_type: 'offline',
                        prompt: 'consent',
                    },
                },
            })
            if (error) {
                toast.error('Google sign-in failed. Please try again.')
                setIsLoading(false)
            }
            // On success Supabase redirects the page — loading stays true intentionally
        } catch {
            toast.error('An unexpected error occurred')
            setIsLoading(false)
        }
    }

    return (
        <Button
            type="button"
            variant="outline"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full h-14 rounded-2xl border-border/50 hover:bg-secondary/50 font-bold tracking-tight text-foreground transition-all flex items-center justify-center gap-3"
        >
            {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
            )}
            {label}
        </Button>
    )
}
