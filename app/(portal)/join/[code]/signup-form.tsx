'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { writePendingSignupEmail } from '@/lib/portal-signup'

interface SignupFormProps {
  inviteId: string
  shopId: string
  shopName: string
  brandColor: string
  ownerWhatsApp?: string
}

type FormStep = 'email-password' | 'success'

export function SubAgentSignupForm({
  inviteId,
  shopId,
  shopName,
  brandColor,
  ownerWhatsApp,
}: SignupFormProps) {
  const [step, setStep] = useState<FormStep>('email-password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      // Call signup endpoint to:
      // 1. Create Supabase auth user
      // 2. Create users table row
      // 3. Create sub_agents row (status='pending')
      const response = await fetch('/api/shop/sub-agents/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          phone,
          inviteId,
          shopId,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Signup failed')
        setLoading(false)
        return
      }

      // The recruit almost always signs up on the recruiter's own phone, and
      // signup never touched this browser's session — so whoever was already
      // logged in still is. Sending them onward in that state is how a recruit
      // ends up looking at their recruiter's storefront on "My Shop" and
      // believing a shop was made for them.
      //
      // f29823b fixed that for a Lead by having /portal/login refuse to forward
      // a session that is not a sub-agent. That test stopped working the moment
      // subs could recruit: an L1 recruiter IS a sub, so the check passes and
      // the recruit lands in the recruiter's portal. Identity is the thing that
      // matters, not whether the session happens to be a sub.
      //
      // So end the session here. The correct state after creating an account is
      // "signed in as nobody, log in as yourself". Remember the new email so the
      // login page can prefill it and, if the sign-out fails, still notice the
      // session belongs to someone else.
      writePendingSignupEmail(email)
      await supabase.auth.signOut().catch(() => {})

      setStep('success')
      setLoading(false)
    } catch (err: any) {
      setError(err?.message || 'An error occurred')
      setLoading(false)
    }
  }

  if (step === 'success') {
    return (
      <div className="text-center">
        <div
          className="h-16 w-16 rounded-full mx-auto mb-4 flex items-center justify-center text-white text-3xl"
          style={{ backgroundColor: brandColor }}
        >
          ✓
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Account Created!
        </h2>
        <p className="text-gray-600 mb-4">
          Your sub-agent account has been created and is pending approval from{' '}
          <strong>{shopName}</strong>.
        </p>
        <p className="text-sm text-gray-500">
          You'll receive an SMS when your account is approved. Then you can set up
          your wallet and start selling!
        </p>

        {ownerWhatsApp && (
          <>
            <a
              href={`https://wa.me/${ownerWhatsApp}?text=${encodeURIComponent(
                `Hello ${shopName}, I just signed up as your sub-agent (my number: ${phone}). ` +
                  `Please approve my account so I can start selling. Thank you!`
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-white font-semibold"
              style={{ backgroundColor: '#25D366' }}
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
              Chat {shopName} to approve me
            </a>
            <p className="mt-2 text-xs text-gray-500">
              Message the shop owner on WhatsApp to speed up your approval.
            </p>
          </>
        )}

        <button
          onClick={() => (window.location.href = '/portal/login')}
          className="mt-4 w-full px-4 py-2 rounded-lg text-white font-semibold"
          style={{ backgroundColor: brandColor }}
        >
          Go to Login
        </button>
      </div>
    )
  }

  // Email/Password step
  return (
    <form onSubmit={handleEmailPasswordSubmit} className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Create Account</h2>

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
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:outline-none"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:outline-none"
          minLength={8}
          required
        />
        <p className="text-xs text-gray-500 mt-1">At least 8 characters</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Phone Number
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          placeholder="0XXXXXXXXX"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:outline-none"
          pattern="0\d{9}"
          required
        />
        <p className="text-xs text-gray-500 mt-1">Ghana format: 0XXXXXXXXX</p>
      </div>

      <button
        type="submit"
        disabled={!email || !password || password.length < 8 || !phone || loading}
        className="w-full px-4 py-2 rounded-lg text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: brandColor }}
      >
        {loading ? 'Creating Account...' : 'Continue'}
      </button>

      <p className="text-xs text-gray-500 text-center">
        By signing up, you agree to our Terms of Service and Privacy Policy
      </p>
    </form>
  )
}
