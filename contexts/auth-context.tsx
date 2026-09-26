'use client'

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { User, Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { User as DBUser } from '@/types/supabase'
import { useRouter } from 'next/navigation'

interface AuthContextType {
    user: User | null
    dbUser: DBUser | null
    session: Session | null
    isLoading: boolean
    isAdmin: boolean
    isSubAdmin: boolean
    isSeller: boolean
    /** True once we've confirmed (via /api/dashboard/sub/data) this account is a sub-agent. */
    isSubAgent: boolean
    /** True once the sub-agent check above has resolved (success or 403) — lets callers avoid a false "not a sub-agent" during the initial fetch. */
    subAgentCheckDone: boolean
    /** True for a level-2+ sub, who is the bottom of the recruiting chain and can never recruit further. */
    subAgentRecruitBlocked: boolean
    phoneVerified: boolean
    signIn: (email: string, password: string) => Promise<{ error: Error | null }>
    signUp: (data: SignUpData) => Promise<{ error: any, data: { user: User | null, session: Session | null } | null }>
    signOut: () => Promise<void>
    refreshUser: () => Promise<void>
}

interface SignUpData {
    email: string
    password: string
    firstName: string
    lastName: string
    phoneNumber: string
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

const INACTIVITY_TIMEOUT = 30 * 60 * 1000 // 30 minutes

// Same profile row? The select below is fixed, so a key-by-key compare is exact.
function sameRow(a: Record<string, any> | null, b: Record<string, any>): boolean {
    if (!a) return false
    const keys = Object.keys(b)
    if (keys.length !== Object.keys(a).length) return false
    return keys.every(k => a[k] === b[k])
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [dbUser, setDbUser] = useState<DBUser | null>(null)
    const [session, setSession] = useState<Session | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const lastActivityRef = useRef(Date.now())
    const userIdRef = useRef<string | undefined>(undefined)
    const router = useRouter()

    useEffect(() => {
        userIdRef.current = user?.id
    }, [user?.id])

    // Apply a session without churning object identity. `user` and `session`
    // are dependencies of dozens of page effects; handing them a fresh object
    // for the same user and the same token made every one of those pages
    // refetch. The user object is replaced only when the account changes or its
    // metadata does; the session only when the token does (client code that
    // sends that token to an API must still see a refresh).
    const applySession = useCallback((next: Session) => {
        userIdRef.current = next.user.id
        setSession(prev => (prev?.access_token === next.access_token ? prev : next))
        setUser(prev =>
            prev?.id === next.user.id && prev.updated_at === next.user.updated_at ? prev : next.user
        )
    }, [])

    const isAdmin = dbUser?.role === 'admin'
    const isSubAdmin = dbUser?.role === 'sub-admin'
    const isSeller = dbUser?.is_seller ?? false
    const phoneVerified = dbUser?.phone_verified ?? false

    // Sub-agent status lives in a separate `sub_agents` table, not on `role`, so
    // it can only be resolved by asking the server. 200 → sub-agent, 403 → not
    // one; anything else fails open (both flags stay false) so a network hiccup
    // never wrongly de-features a regular user's dashboard.
    const [isSubAgent, setIsSubAgent] = useState(false)
    const [subAgentCheckDone, setSubAgentCheckDone] = useState(false)
    const [subAgentRecruitBlocked, setSubAgentRecruitBlocked] = useState(false)
    useEffect(() => {
        if (!dbUser?.id) {
            setIsSubAgent(false)
            setSubAgentCheckDone(false)
            setSubAgentRecruitBlocked(false)
            return
        }
        let active = true
        fetch('/api/dashboard/sub/data')
            .then((r) => {
                if (!active) return
                if (r.ok) {
                    setIsSubAgent(true)
                    return r.json().catch(() => null)
                }
                if (r.status === 403) setIsSubAgent(false)
                return null
            })
            .then((d) => {
                if (!active) return
                if (typeof d?.canRecruit === 'boolean') setSubAgentRecruitBlocked(!d.canRecruit)
            })
            .catch(() => {})
            .finally(() => { if (active) setSubAgentCheckDone(true) })
        return () => { active = false }
    }, [dbUser?.id])

    // Fetch the profile row for the authenticated user. Returns true on success.
    // Resilient by design: mobile networks (see the "Connection Error" screen in
    // the dashboard layout) frequently drop a single request, so we retry with
    // backoff and refresh the JWT when the failure looks auth-related (stale token
    // after the tab/app was backgrounded).
    const fetchDbUser = useCallback(async (userId: string): Promise<boolean> => {
        const MAX_ATTEMPTS = 3

        const runQuery = () => supabase
            .from('users')
            .select(`
                id,
                email,
                first_name,
                last_name,
                phone_number,
                phone_verified,
                role,
                status,
                agent_expires_at,
                dealer_claimed_at,
                dealer_expires_at,
                is_seller,
                created_at,
                updated_at
            `)
            .eq('id', userId)
            .single()

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                // Per-attempt timeout so one hung request can't stall the whole flow.
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Database timeout')), 10000)
                )

                const { data, error } = await Promise.race([runQuery(), timeout]) as any

                if (!error && data) {
                    // Keep the existing object when nothing changed, so effects
                    // keyed on dbUser don't re-run (and refetch) for no reason.
                    setDbUser(prev => (sameRow(prev as any, data) ? prev : data))
                    return true
                }

                if (error) {
                    console.error(`Error fetching user data (attempt ${attempt}/${MAX_ATTEMPTS}):`, error)
                    // A JWT/permission failure won't fix itself on retry — refresh the
                    // session token first so the next attempt carries a valid claim.
                    const authRelated =
                        error?.code === 'PGRST301' ||
                        error?.code === '401' ||
                        /jwt|token|auth/i.test(error?.message ?? '')
                    if (authRelated) {
                        try { await supabase.auth.refreshSession() } catch {}
                    }
                }
            } catch (error) {
                console.error(`Error fetching user data (attempt ${attempt}/${MAX_ATTEMPTS}):`, error)
            }

            // Backoff before the next try (skip the wait after the final attempt).
            if (attempt < MAX_ATTEMPTS) {
                await new Promise(res => setTimeout(res, 500 * attempt))
            }
        }

        // Exhausted retries — leave dbUser as-is so the UI can surface a retry path.
        return false
    }, [])

    // Auto-downgrade expired agents and dealers
    useEffect(() => {
        const checkAndDowngradeExpired = async () => {
            if (dbUser?.role === 'agent' && dbUser?.agent_expires_at) {
                const expiryDate = new Date(dbUser.agent_expires_at)
                const now = new Date()

                if (expiryDate < now) {
                    console.log('[AuthContext] Agent expired, auto-downgrading to customer')
                    try {
                        const response = await fetch('/api/agent/downgrade', {
                            method: 'POST'
                        })

                        if (response.ok) {
                            console.log('[AuthContext] Auto-downgrade successful')
                            await refreshUser()
                        } else {
                            console.error('[AuthContext] Auto-downgrade failed:', await response.text())
                        }
                    } catch (error) {
                        console.error('[AuthContext] Auto-downgrade error:', error)
                    }
                }
            }

            if (dbUser?.role === 'dealer' && (dbUser as any)?.dealer_expires_at) {
                const expiryDate = new Date((dbUser as any).dealer_expires_at)
                const now = new Date()

                if (expiryDate < now) {
                    console.log('[AuthContext] Dealer expired, auto-downgrading to customer')
                    try {
                        const response = await fetch('/api/user/dealer-downgrade', {
                            method: 'POST'
                        })

                        if (response.ok) {
                            console.log('[AuthContext] Dealer auto-downgrade successful')
                            await refreshUser()
                        } else {
                            console.error('[AuthContext] Dealer auto-downgrade failed:', await response.text())
                        }
                    } catch (error) {
                        console.error('[AuthContext] Dealer auto-downgrade error:', error)
                    }
                }
            }
        }

        checkAndDowngradeExpired()
    }, [dbUser?.role, dbUser?.agent_expires_at, (dbUser as any)?.dealer_expires_at])

    const refreshUser = useCallback(async () => {
        if (user) {
            // Refresh the JWT session first so the new role is reflected in the token
            await supabase.auth.refreshSession()
            await fetchDbUser(user.id)
        }
    }, [user, fetchDbUser])

    const signIn = useCallback(async (email: string, password: string) => {
        // We use the client-side Supabase instance directly to guarantee the session cookie is set natively in the browser.
        // This avoids Vercel Edge stripping Set-Cookie headers from API responses.
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        })

        if (error) {
            if (error.message.includes('rate limit') || error.message.includes('Too many')) {
                return { error: { message: `TOO_MANY_ATTEMPTS:5` } as Error }
            }
            return { error: { message: error.message } as Error }
        }

        // Wait a brief moment for the auth state to propagate to cookies
        await supabase.auth.getSession()

        return { error: null }
    }, [])

    const signUp = useCallback(async (data: SignUpData) => {
        // Use client-side Supabase instance directly
        const { data: authData, error } = await supabase.auth.signUp({
            email: data.email,
            password: data.password,
            options: {
                data: {
                    first_name: data.firstName,
                    last_name: data.lastName,
                    phone_number: data.phoneNumber
                }
            }
        })

        if (error) {
            if (error.message.includes('rate limit') || error.message.includes('Too many')) {
                return { error: { message: `TOO_MANY_ATTEMPTS:5` } as Error, data: null }
            }
            return { error: { message: error.message, details: error.name }, data: null }
        }

        // Wait a brief moment for auth state to propagate
        await supabase.auth.getSession()

        return { error: null, data: { user: authData.user, session: authData.session } }
    }, [])

    const signOut = useCallback(async () => {
        await supabase.auth.signOut({ scope: 'global' })
        setUser(null)
        setDbUser(null)
        setSession(null)
        router.push('/auth/login')
    }, [router])

    // Track user activity.
    // Written to a ref, never to state: these events fire on every scroll frame
    // and every tap, and a setState here re-rendered the whole provider — and
    // with it every useAuth() consumer on the page — continuously while the user
    // scrolled. Nothing renders from this value; only the interval below reads it.
    const userId = user?.id
    useEffect(() => {
        if (!userId) return

        lastActivityRef.current = Date.now()
        const updateActivity = () => {
            lastActivityRef.current = Date.now()
        }

        const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click']
        events.forEach(event => {
            window.addEventListener(event, updateActivity, { passive: true })
        })

        return () => {
            events.forEach(event => {
                window.removeEventListener(event, updateActivity)
            })
        }
    }, [userId])

    // Auto logout on inactivity. One interval per signed-in user, rather than one
    // torn down and rebuilt on every activity event.
    useEffect(() => {
        if (!userId) return

        const checkInactivity = setInterval(() => {
            if (Date.now() - lastActivityRef.current > INACTIVITY_TIMEOUT) {
                console.log('User inactive for 30 minutes, redirecting to home...')
                // Sign out and redirect to home page
                supabase.auth.signOut()
                setUser(null)
                setDbUser(null)
                setSession(null)
                router.push('/')
            }
        }, 60000) // Check every minute

        return () => clearInterval(checkInactivity)
    }, [userId, router])

    // Handle tab visibility and session stale check.
    // No reload: a phone coming back from the app switcher used to hard-reload
    // the page whenever getSession raced a token refresh. State is reconciled in
    // place instead, and only when something actually changed.
    useEffect(() => {
        if (!userId) return

        const handleVisibilityChange = async () => {
            if (document.visibilityState !== 'visible') return
            const { data: { session: currentSession }, error } = await supabase.auth.getSession()

            // A read error is transient (storage lock, flaky network) — keep what we have.
            if (error) return

            if (!currentSession) {
                // Signed out elsewhere. Clearing the user lets the route guards
                // send them to login.
                setSession(null)
                setUser(null)
                setDbUser(null)
                return
            }

            applySession(currentSession)
            if (currentSession.user.id !== userId) {
                fetchDbUser(currentSession.user.id)
            }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
    }, [userId, applySession, fetchDbUser])

    // Initialize auth state
    useEffect(() => {
        const initAuth = async () => {
            if (typeof window !== 'undefined') {
                const params = new URLSearchParams(window.location.search)
                const mockRole = params.get('mockRole')
                if (mockRole) {
                    const mockData = {
                        id: 'mock-id',
                        email: 'derrick@example.com',
                        first_name: 'Derrick',
                        last_name: 'Awuah',
                        phone_number: '0240000000',
                        phone_verified: true,
                        role: mockRole as 'admin' | 'sub-admin' | 'agent' | 'dealer' | 'customer',
                        status: 'active' as 'active' | 'suspended' | 'inactive',
                        dealer_claimed_at: new Date().toISOString(),
                        dealer_expires_at: new Date(Date.now() + 531 * 24 * 60 * 60 * 1000).toISOString(),
                        agent_expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
                        created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
                        updated_at: new Date().toISOString()
                    }
                    setSession({ user: mockData } as any)
                    setUser(mockData as any)
                    setDbUser(mockData)
                    setIsLoading(false)
                    return
                }
            }

            try {
                // Add 8 second total timeout for initialization
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Auth initialization timeout')), 8000)
                )

                const init = async () => {
                    const { data: { session } } = await supabase.auth.getSession()

                    if (session) {
                        applySession(session)
                        await fetchDbUser(session.user.id)
                    }
                }

                await Promise.race([init(), timeout])
            } catch (error) {
                console.error('Auth initialization error:', error)
                // Continue anyway - allow user to proceed without full auth
            } finally {
                // ALWAYS set loading to false, even on error
                setIsLoading(false)
            }
        }

        initAuth()

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, session) => {
                if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockRole')) {
                    return
                }

                if (!session?.user) {
                    setSession(null)
                    setUser(null)
                    setDbUser(null)
                    return
                }

                const previousId = userIdRef.current
                applySession(session)

                // Supabase fires SIGNED_IN again every time the tab regains focus,
                // TOKEN_REFRESHED roughly hourly, and INITIAL_SESSION right after
                // initAuth has already loaded the profile. None of those change the
                // profile row, and refetching it swapped `dbUser` for a new object,
                // which re-ran every page effect keyed on it. Only a different user
                // or an explicit profile update warrants a fetch.
                const needsProfile =
                    event === 'USER_UPDATED' ||
                    (event !== 'TOKEN_REFRESHED' && event !== 'INITIAL_SESSION' && session.user.id !== previousId)

                if (needsProfile) {
                    // Deferred out of the callback: awaiting a Supabase query inside
                    // onAuthStateChange holds the auth lock and can stall every
                    // other client call until it times out.
                    setTimeout(() => { fetchDbUser(session.user.id) }, 0)
                }
            }
        )

        return () => subscription.unsubscribe()
    }, [fetchDbUser, applySession])

    const value = useMemo(() => ({
        user,
        dbUser,
        session,
        isLoading,
        isAdmin,
        isSubAdmin,
        isSeller,
        isSubAgent,
        subAgentCheckDone,
        subAgentRecruitBlocked,
        phoneVerified,
        signIn,
        signUp,
        signOut,
        refreshUser,
    }), [user, dbUser, session, isLoading, isAdmin, isSubAdmin, isSeller, isSubAgent, subAgentCheckDone, subAgentRecruitBlocked, phoneVerified, signIn, signUp, signOut, refreshUser])

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
