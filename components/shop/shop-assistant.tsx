'use client'

/**
 * Storefront assistant bubble for a shop's guest customers. Named after the shop
 * (white-label: never shows ARHMS). Hidden unless the server says it is on for this
 * shop (admin switch + owner hasn't turned it off). History lives only in this tab.
 *
 * Opened from the ASK AI tile in the storefront's service grid (ShopAiTile below):
 * the assistant announces itself with the 'shop-ai:ready' window event once the
 * server says it is on, and the tile sends 'shop-ai:open'.
 */
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, Loader2, MessageCircle, Sparkles, X } from 'lucide-react'

const READY_EVENT = 'shop-ai:ready'
const OPEN_EVENT = 'shop-ai:open'

/** True once this shop's assistant is on (so the service grid can show the tile). */
export function useShopAiReady(): boolean {
    const [ready, setReady] = useState(false)
    useEffect(() => {
        if ((window as any).__shopAiReady) setReady(true)
        const on = () => setReady(true)
        window.addEventListener(READY_EVENT, on)
        return () => window.removeEventListener(READY_EVENT, on)
    }, [])
    return ready
}

/** The ASK AI tile in the storefront's "Choose a service" grid. */
export function ShopAiTile({ className }: { className?: string }) {
    return (
        <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} className={className}>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 via-pink-500 to-violet-600 shadow-sm">
                <Sparkles className="h-6 w-6 text-white" />
            </div>
            <span className="text-center text-[10px] font-black uppercase tracking-widest sm:text-[11px]">ASK AI</span>
        </button>
    )
}

interface Msg {
    role: 'user' | 'assistant'
    content: string
    pending?: boolean
}

const SUGGESTIONS = ['What do you sell?', 'How do I buy data here?', 'How do I track my order?']

export function ShopAssistant({ shopSlug, brandColor }: { shopSlug: string; brandColor?: string }) {
    const [enabled, setEnabled] = useState(false)
    const [name, setName] = useState('')
    const [open, setOpen] = useState(false)
    const [messages, setMessages] = useState<Msg[]>([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const color = /^#[0-9a-f]{3,8}$/i.test(brandColor || '') ? brandColor! : '#2563eb'
    const storeKey = `shop_ai_chat_${shopSlug}`

    useEffect(() => {
        fetch(`/api/ai-assistant/shop?shop=${encodeURIComponent(shopSlug)}`, { cache: 'no-store' })
            .then(r => r.json())
            .then(d => {
                if (!d?.enabled) return
                setEnabled(true)
                setName(String(d.name || ''))
                ;(window as any).__shopAiReady = true
                window.dispatchEvent(new Event(READY_EVENT))
            })
            .catch(() => {})
        try {
            const saved = JSON.parse(sessionStorage.getItem(storeKey) || '[]')
            if (Array.isArray(saved)) setMessages(saved.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'))
        } catch {
            /* ignore */
        }
    }, [shopSlug, storeKey])

    useEffect(() => {
        const openChat = () => setOpen(true)
        window.addEventListener(OPEN_EVENT, openChat)
        return () => window.removeEventListener(OPEN_EVENT, openChat)
    }, [])

    useEffect(() => {
        try {
            sessionStorage.setItem(storeKey, JSON.stringify(messages.filter(m => !m.pending).slice(-20)))
        } catch {
            /* ignore */
        }
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [messages, open, storeKey])

    const send = async (text: string) => {
        const message = text.trim().slice(0, 500)
        if (!message || busy) return
        const history = messages.filter(m => !m.pending && m.content).map(({ role, content }) => ({ role, content }))
        setInput('')
        setBusy(true)
        setMessages(prev => [...prev, { role: 'user', content: message }, { role: 'assistant', content: '', pending: true }])
        const setLast = (content: string, pending = false) =>
            setMessages(prev => {
                const next = prev.slice()
                next[next.length - 1] = { role: 'assistant', content, pending }
                return next
            })
        try {
            const res = await fetch('/api/ai-assistant/shop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopSlug, message, history }),
            })
            const type = res.headers.get('content-type') || ''
            if (!res.body || type.includes('application/json')) {
                const data = await res.json().catch(() => ({}))
                setLast(data.notice || data.error || 'Sorry, something went wrong. Please try again.')
                return
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            let content = ''
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                buf += decoder.decode(value, { stream: true })
                let nl: number
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl)
                    buf = buf.slice(nl + 1)
                    try {
                        const ev = JSON.parse(line)
                        if (ev.type === 'text') {
                            content += ev.text
                            setLast(content, true)
                        }
                    } catch {
                        /* partial line */
                    }
                }
            }
            setLast(content || 'Sorry, I could not answer that right now.')
        } catch {
            setLast('Sorry, something went wrong. Please try again.')
        } finally {
            setBusy(false)
        }
    }

    if (!enabled) return null
    const title = name ? `${name} assistant` : 'Shop assistant'

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/40" />
                <Dialog.Content
                    aria-describedby={undefined}
                    className="fixed inset-x-0 bottom-0 z-[70] flex h-[85dvh] flex-col rounded-t-3xl bg-white shadow-2xl outline-none dark:bg-gray-900 md:inset-x-auto md:bottom-4 md:right-4 md:h-[600px] md:w-[400px] md:rounded-3xl"
                >
                    <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
                        <div style={{ backgroundColor: color }} className="flex h-9 w-9 items-center justify-center rounded-full text-white">
                            <MessageCircle className="h-4 w-4" />
                        </div>
                        <Dialog.Title className="min-w-0 flex-1 truncate text-base font-bold">{title}</Dialog.Title>
                        <Dialog.Close aria-label="Close" className="rounded-full p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
                            <X className="h-5 w-5" />
                        </Dialog.Close>
                    </div>

                    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                        {messages.length === 0 ? (
                            <div className="space-y-2 pt-2">
                                <p className="text-sm text-gray-500">Hi! Ask me anything about {name || 'this shop'}.</p>
                                {SUGGESTIONS.map(sg => (
                                    <button key={sg} type="button" onClick={() => send(sg)} disabled={busy}
                                        className="w-full rounded-2xl border border-gray-200 px-4 py-2.5 text-left text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
                                        {sg}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            messages.map((m, i) => (
                                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                                    <div
                                        style={m.role === 'user' ? { backgroundColor: color } : undefined}
                                        className={m.role === 'user'
                                            ? 'max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm text-white'
                                            : 'max-w-[85%] rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-2 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100'}
                                    >
                                        {m.pending && !m.content
                                            ? <span className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Typing…</span>
                                            : <p className="whitespace-pre-wrap break-words">{m.content.replace(/\*\*/g, '')}</p>}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <form onSubmit={e => { e.preventDefault(); send(input) }} className="border-t border-gray-200 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 dark:border-gray-800">
                        <div className="flex items-center gap-2 rounded-full border border-gray-200 py-1.5 pl-4 pr-1.5 dark:border-gray-700">
                            <input
                                value={input}
                                onChange={e => setInput(e.target.value.slice(0, 500))}
                                placeholder="Type your question…"
                                className="min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm"
                            />
                            <button type="submit" aria-label="Send" disabled={busy || !input.trim()} style={{ backgroundColor: color }}
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40">
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                            </button>
                        </div>
                        <p className="mt-1.5 text-center text-[11px] text-gray-500">The assistant can make mistakes. Payment always happens in the checkout.</p>
                    </form>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
