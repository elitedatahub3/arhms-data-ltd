'use client'

import { useState, useEffect } from 'react'

interface SubAgent {
  id: string
  status: 'pending' | 'active' | 'suspended'
  user: {
    email: string
    phone_number: string
    first_name: string
    last_name: string
  }
  approvedAt: string | null
  createdAt: string
  markupCeiling: number | null
}

interface Tab {
  id: 'all' | 'pending' | 'active' | 'suspended'
  label: string
}

/**
 * Downline listing, approval and invite generation.
 *
 * Mounted by both portals: a Lead manages their subs at
 * /dashboard/shop/sub-agents, and a level-1 sub manages their own recruits at
 * /dashboard/sub/sub-agents inside the de-branded shell. Nothing here is
 * level-specific — /api/shop/sub-agents resolves the caller's shop by
 * owner_id, and PATCH authorises on "am I the upline", which is equally true
 * of a sub who has recruited.
 */
export default function SubAgentsManager({
  pricingHref = '/dashboard/shop/sub-pricing',
}: {
  /** Where "Set their prices" goes — differs per portal. */
  pricingHref?: string
} = {}) {
  const [subs, setSubs] = useState<SubAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Recruiting hangs off a shop: /api/shop/sub-agents resolves the caller's
  // shop by owner_id and 404s without one. That is a normal state for a new
  // sub, not a failure, so it gets its own message rather than a red banner
  // reading "Shop not found".
  const [needsShop, setNeedsShop] = useState(false)
  const [selectedTab, setSelectedTab] = useState<'all' | 'pending' | 'active' | 'suspended'>('all')
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [selectedSub, setSelectedSub] = useState<SubAgent | null>(null)

  const tabs: Tab[] = [
    { id: 'all', label: 'All' },
    { id: 'pending', label: 'Pending Approval' },
    { id: 'active', label: 'Active' },
    { id: 'suspended', label: 'Suspended' },
  ]

  useEffect(() => {
    fetchSubAgents()
  }, [])

  const fetchSubAgents = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/shop/sub-agents')
      const data = await response.json()

      if (response.status === 404) {
        setNeedsShop(true)
        return
      }

      if (!response.ok) {
        setError(data.error || 'Failed to load sub-agents')
        return
      }

      setSubs(data.subs || [])
    } catch (err) {
      setError('An error occurred')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const filteredSubs = selectedTab === 'all'
    ? subs
    : subs.filter(sub => sub.status === selectedTab)

  const stats = {
    total: subs.length,
    pending: subs.filter(s => s.status === 'pending').length,
    active: subs.filter(s => s.status === 'active').length,
    suspended: subs.filter(s => s.status === 'suspended').length,
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Sub-Agents</h1>
          <p className="text-gray-600 mt-1">Manage your sub-agent network</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          {/* Recruiting and pricing a downline are the same job, so the link
              belongs next to the invite button rather than buried in Pricing,
              which is about what your own customers pay. */}
          <a
            href={pricingHref}
            className="w-full sm:w-auto px-4 py-2 rounded-lg border border-blue-600 text-blue-700 hover:bg-blue-50 font-semibold text-center"
          >
            Set their prices
          </a>
          <button
            onClick={() => setShowInviteForm(!showInviteForm)}
            className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold"
          >
            + Generate Invite Link
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-gray-600 text-sm">Total Subs</p>
          <p className="text-2xl sm:text-3xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-yellow-50 rounded-lg shadow p-4">
          <p className="text-yellow-700 text-sm">Pending</p>
          <p className="text-2xl sm:text-3xl font-bold text-yellow-900">{stats.pending}</p>
        </div>
        <div className="bg-green-50 rounded-lg shadow p-4">
          <p className="text-green-700 text-sm">Active</p>
          <p className="text-2xl sm:text-3xl font-bold text-green-900">{stats.active}</p>
        </div>
        <div className="bg-red-50 rounded-lg shadow p-4">
          <p className="text-red-700 text-sm">Suspended</p>
          <p className="text-2xl sm:text-3xl font-bold text-red-900">{stats.suspended}</p>
        </div>
      </div>

      {/* Invite Form (Collapsible) */}
      {showInviteForm && <InviteForm onSuccess={() => {
        setShowInviteForm(false)
        fetchSubAgents()
      }} />}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSelectedTab(tab.id)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 font-semibold text-sm ${
              selectedTab === tab.id
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-Agents List */}
      {loading ? (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="text-gray-600 mt-2">Loading...</p>
        </div>
      ) : needsShop ? (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <p className="font-semibold text-blue-900">Create your storefront first</p>
          <p className="text-blue-800 text-sm mt-1">
            Your sub-agents sell from prices you set on your own shop, so you need one
            before you can recruit. Open <strong>My Shop</strong> to create it.
          </p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          {error}
        </div>
      ) : filteredSubs.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg">
          <p className="text-gray-600">No sub-agents found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSubs.map(sub => (
            <SubAgentRow
              key={sub.id}
              sub={sub}
              onSelect={() => setSelectedSub(sub)}
              onUpdated={fetchSubAgents}
            />
          ))}
        </div>
      )}

      {/* Detail Panel (Side/Modal) */}
      {selectedSub && (
        <SubAgentDetail
          sub={selectedSub}
          onClose={() => setSelectedSub(null)}
          onUpdated={() => {
            fetchSubAgents()
            setSelectedSub(null)
          }}
        />
      )}
    </div>
  )
}

function SubAgentRow({ sub, onSelect, onUpdated }: {
  sub: SubAgent
  onSelect: () => void
  onUpdated: () => void
}) {
  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800',
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-red-100 text-red-800',
  }

  const handleQuickAction = async (action: 'approve' | 'suspend') => {
    if (!confirm(`Are you sure you want to ${action} this sub?`)) return

    try {
      const response = await fetch(`/api/shop/sub-agents/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })

      if (response.ok) {
        onUpdated()
      } else {
        alert('Action failed')
      }
    } catch (err) {
      alert('Error performing action')
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between hover:shadow-md transition">
      <div className="flex items-center justify-between gap-3 sm:flex-1">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 bg-gray-300 rounded-full"></div>
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">
              {sub.user.first_name || sub.user.email}
            </p>
            <p className="text-sm text-gray-600 truncate">{sub.user.phone_number}</p>
          </div>
        </div>

        <span className={`shrink-0 px-3 py-1 rounded-full text-xs sm:text-sm font-semibold ${statusColors[sub.status]}`}>
          {sub.status === 'pending' ? 'Pending' : sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:ml-4 sm:shrink-0">
        {sub.status !== 'active' && (
          <button
            onClick={() => handleQuickAction('approve')}
            className="px-3 py-2 sm:py-1 bg-green-600 text-white text-sm font-semibold rounded hover:bg-green-700"
          >
            {/* Same action either way — approving a suspended sub reinstates
                them and brings their storefront back online. */}
            {sub.status === 'suspended' ? 'Reinstate' : 'Approve'}
          </button>
        )}
        {sub.status !== 'suspended' && (
          <button
            onClick={() => handleQuickAction('suspend')}
            className="px-3 py-2 sm:py-1 bg-red-600 text-white text-sm font-semibold rounded hover:bg-red-700"
          >
            Suspend
          </button>
        )}
        <button
          onClick={onSelect}
          className="col-span-2 sm:col-auto px-3 py-2 sm:py-1 bg-gray-200 text-gray-900 text-sm font-semibold rounded hover:bg-gray-300"
        >
          Details
        </button>
      </div>
    </div>
  )
}

function SubAgentDetail({ sub, onClose, onUpdated }: {
  sub: SubAgent
  onClose: () => void
  onUpdated: () => void
}) {
  const [markupCeiling, setMarkupCeiling] = useState(sub.markupCeiling || 5.0)
  const [saving, setSaving] = useState(false)

  const handleSaveSettings = async () => {
    setSaving(true)
    try {
      const response = await fetch(`/api/shop/sub-agents/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-settings',
          markupCeiling,
        }),
      })

      if (response.ok) {
        onUpdated()
      } else {
        alert('Failed to save settings')
      }
    } catch (err) {
      alert('Error saving settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full m-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900">Sub-Agent Details</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold text-gray-600">Name</p>
            <p className="text-gray-900">{sub.user.first_name || 'N/A'}</p>
          </div>

          <div>
            <p className="text-sm font-semibold text-gray-600">Email</p>
            <p className="text-gray-900">{sub.user.email}</p>
          </div>

          <div>
            <p className="text-sm font-semibold text-gray-600">Phone</p>
            <p className="text-gray-900">{sub.user.phone_number}</p>
          </div>

          <div>
            <p className="text-sm font-semibold text-gray-600">Status</p>
            <p className="text-gray-900 capitalize">{sub.status}</p>
          </div>

          <div>
            <label className="text-sm font-semibold text-gray-600 block mb-2">
              Markup Ceiling (GHS)
            </label>
            <input
              type="number"
              step="0.01"
              value={markupCeiling}
              onChange={(e) => setMarkupCeiling(parseFloat(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <button
            onClick={handleSaveSettings}
            disabled={saving}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-semibold"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}

function InviteForm({ onSuccess }: { onSuccess: () => void }) {
  const [maxUses, setMaxUses] = useState('')
  const [expiresInHours, setExpiresInHours] = useState('24')
  const [loading, setLoading] = useState(false)
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)

  const handleCreateInvite = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/shop/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxUses: maxUses ? parseInt(maxUses) : null,
          expiresInHours: parseInt(expiresInHours),
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setGeneratedUrl(data.invite.url)
      } else {
        alert(data.error || 'Failed to create invite')
      }
    } catch (err) {
      alert('Error creating invite')
    } finally {
      setLoading(false)
    }
  }

  if (generatedUrl) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
        <p className="font-semibold text-green-900 mb-2">Invite Link Generated!</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            readOnly
            value={generatedUrl}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded bg-white text-sm"
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(generatedUrl)
              alert('Copied to clipboard!')
            }}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Copy
          </button>
        </div>
        <button
          onClick={onSuccess}
          className="mt-2 w-full px-4 py-2 bg-gray-200 text-gray-900 rounded hover:bg-gray-300"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
      <p className="font-semibold text-blue-900">Create Invite Link</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-semibold text-gray-700 block mb-1">
            Max Uses (leave empty for unlimited)
          </label>
          <input
            type="number"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="5"
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div>
          <label className="text-sm font-semibold text-gray-700 block mb-1">
            Expires In (hours)
          </label>
          <input
            type="number"
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
      </div>

      <button
        onClick={handleCreateInvite}
        disabled={loading}
        className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-semibold"
      >
        {loading ? 'Creating...' : 'Generate Link'}
      </button>
    </div>
  )
}
