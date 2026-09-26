'use client'

/**
 * De-branded Sub-Agent Portal Login
 *
 * A neutral (non-ARHMS) sign-in page for sub-agents, matching the de-branded
 * /join signup portal. Reuses the shared auth engine; on success it sends the
 * user to /dashboard, where middleware routes sub-agents to /dashboard/sub.
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { readPendingSignupEmail, clearPendingSignupEmail } from '@/lib/portal-signup'

export default function PortalLoginPage() {
  const { signIn, signOut, user, dbUser, isLoading } = useAuth()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // A session that is signed in but is NOT a sub-agent — almost always the Lead
  // still logged in on the phone they just handed to a new recruit.
  const [otherAccount, setOtherAccount] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)

  // Already signed in → forward only a session that is BOTH a sub-agent and the
  // person we are expecting.
  //
  // Forwarding on sub-agent-ness alone was how a Lead's own storefront ended up
  // on a recruit's "My Shop" page (f29823b). That check silently stopped working
  // once subs could recruit: an L1 recruiter IS a sub, so their session passed
  // and the recruit was walked straight into the recruiter's portal — same bug,
  // one level down, and invisible because every guard was satisfied.
  //
  // A recruit who just signed up leaves their email behind; if the live session
  // is anyone else, treat it as a foreign account no matter what it is.
  useEffect(() => {
    if (isLoading) return
    if (!user) {
      setOtherAccount(false)
      setCheckingSession(false)
      return
    }

    const pendingEmail = readPendingSignupEmail()

    if (pendingEmail) {
      setEmail(pendingEmail)
      const signedInAs = String(user.email || '').trim().toLowerCase()
      if (signedInAs && signedInAs !== pendingEmail) {
        setOtherAccount(true)
        setCheckingSession(false)
        return
      }
    }

    let active = true
    // 200 → sub-agent; 403 → some other account. Any other failure falls through
    // to the portal as before, so a network blip never strands a real sub-agent.
    fetch('/api/dashboard/sub/data')
      .then((r) => {
        if (!active) return
        if (r.status === 403) {
          setOtherAccount(true)
          setCheckingSession(false)
          return
        }
        clearPendingSignupEmail()
        window.location.href = '/dashboard/sub'
      })
      .catch(() => {
        if (active) window.location.href = '/dashboard/sub'
      })
    return () => { active = false }
  }, [user, isLoading])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { error } = await signIn(email, password)
      if (error) {
        setError(
          error.message?.startsWith('TOO_MANY_ATTEMPTS:')
            ? 'Too many attempts. Please try again later.'
            : error.message || 'Login failed'
        )
        setLoading(false)
        return
      }
      clearPendingSignupEmail()
      // Middleware sends sub-agents from /dashboard → /dashboard/sub.
      window.location.href = '/dashboard'
    } catch {
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  // Signed in as somebody who is not a sub-agent. Say so plainly instead of
  // dropping them into a portal that would show them their own shop.
  if (user && otherAccount) {
    const name = [dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ').trim()
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <h1 className="text-xl font-bold text-gray-900">You are already signed in</h1>
            <p className="text-gray-600 mt-2">
              This phone is signed in as <strong>{name || dbUser?.email || 'another account'}</strong>,
              which is not a sub-agent account.
            </p>
            <p className="text-gray-600 mt-2 text-sm">
              Signing up a new sub-agent? Sign out first, then log in with their details.
            </p>
            <button
              onClick={async () => {
                await signOut()
                // signOut() pushes to the main ARHMS login; the portal must stay
                // de-branded, so land back on this page instead.
                window.location.href = '/portal/login'
              }}
              className="mt-6 w-full px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
            >
              Sign out
            </button>
            <button
              onClick={() => (window.location.href = '/dashboard')}
              className="mt-3 w-full px-4 py-2 rounded-lg border border-gray-300 font-semibold text-gray-700 hover:bg-gray-50"
            >
              Go to my dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Hold the form back while an existing session is being classified, so a
  // real sub-agent never sees a login form they do not need.
  if (isLoading || (user && checkingSession)) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        <p className="text-gray-500 text-sm">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Sub-Agent Portal</h1>
          <p className="text-gray-600 mt-2">Sign in to continue</p>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-2 pr-16 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={!email || !password || loading}
              className="w-full px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in…' : 'Login'}
            </button>
          </form>

          <p className="text-center text-xs text-gray-500 mt-6">
            Signed up but not approved yet? Ask your Lead to approve your account.
          </p>
        </div>
      </div>
    </div>
  )
}
