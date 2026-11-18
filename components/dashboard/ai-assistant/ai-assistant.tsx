'use client'

/**
 * ARHMS AI — floating launcher + chat panel (bottom sheet on phones, side panel
 * on desktop). Renders nothing unless GET /api/ai-assistant/chat says the
 * assistant is enabled for this user (admin switch ai_assistant_mode).
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, Loader2, SquarePen, Sparkles, X, Wifi } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'

interface BundleCard {
    packageId: string
    network: string
    size: string
    price: number
    description: string | null
    href: string
}

interface ChatMessage {
    role: 'user' | 'assistant'
    content: string
    cards?: BundleCard[] | null
    pending?: boolean
}

const SUGGESTIONS = [
    'How much is in my wallet?',
    'Where is my order?',
    'What are the MTN data prices?',
    'What are my agent prices for MTN?',
    'I want to buy MTN data',
]

const NETWORK_LABEL: Record<string, string> = {
    'Special MTN Mashup': 'MTN Mashup',
    'EXPRESS MTN': 'Express MTN',
    'AT-iShare': 'AT iShare',
    'AT-BigTime': 'AT BigTime',
}

/**
 * In-app page addresses the assistant may mention (/dashboard/..., /docs).
 * Only these become links: anything else, including full URLs, stays plain text,
 * so a manipulated reply can never send a user off-site.
 */
const APP_PATH_RE = /((?<![\w.:/-])\/(?:dashboard(?:\/[a-z0-9-]+){0,3}|docs)(?![\w/-]))/g

function WithAppLinks({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
    const parts = text.split(APP_PATH_RE)
    return (
        <>
            {parts.map((p, i) =>
                i % 2 === 1
                    ? (
                        <Link
                            key={i}
                            href={p}
                            onClick={onNavigate}
                            {...(p === '/docs' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                            className="font-semibold text-primary underline underline-offset-2"
                        >
                            {p}
                        </Link>
                    )
                    : <Fragment key={i}>{p}</Fragment>,
            )}
        </>
    )
}

/** **bold** and in-app page links inside a line, rendered without HTML injection. */
function Inline({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
    const parts = text.split(/(\*\*[^*]+\*\*)/g)
    return (
        <>
            {parts.map((p, i) =>
                p.startsWith('**') && p.endsWith('**') && p.length > 4
                    ? <strong key={i}><WithAppLinks text={p.slice(2, -2)} onNavigate={onNavigate} /></strong>
                    : <WithAppLinks key={i} text={p} onNavigate={onNavigate} />,
            )}
        </>
    )
}

/** Minimal formatting for replies: paragraphs, bullet and numbered lists, bold, in-app links. */
function Formatted({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
    const lines = text.split('\n')
    const blocks: JSX.Element[] = []
    let list: string[] = []
    const flush = () => {
        if (!list.length) return
        blocks.push(
            <ul key={`l${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-5">
                {list.map((li, i) => <li key={i}><Inline text={li} onNavigate={onNavigate} /></li>)}
            </ul>,
        )
        list = []
    }
    for (const raw of lines) {
        const line = raw.trimEnd()
        const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)
        if (bullet) {
            list.push(bullet[1])
            continue
        }
        flush()
        if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="my-1"><Inline text={line} onNavigate={onNavigate} /></p>)
    }
    flush()
    return <>{blocks}</>
}

function BundleCards({ cards, onPick }: { cards: BundleCard[]; onPick: () => void }) {
    return (
        <div className="mt-2 grid grid-cols-2 gap-2">
            {cards.map(c => (
                <Link
                    key={c.packageId}
                    href={c.href}
                    onClick={onPick}
                    className="group rounded-xl border border-border bg-background p-3 transition hover:border-primary hover:shadow-sm"
                >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Wifi className="h-3 w-3" />
                        {NETWORK_LABEL[c.network] ?? c.network}
                    </div>
                    <div className="mt-1 text-lg font-black leading-tight">{c.size}</div>
                    <div className="mt-0.5 text-sm font-semibold text-primary">GHS {c.price.toFixed(2)}</div>
                    <div className="mt-2 text-xs font-medium text-muted-foreground group-hover:text-primary">Tap to buy →</div>
                </Link>
            ))}
        </div>
    )
}

export function AiAssistant() {
    const { dbUser, isSubAgent } = useAuth()
    const [enabled, setEnabled] = useState(false)
    const [open, setOpen] = useState(false)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [conversationId, setConversationId] = useState<string | null>(null)
    const [remaining, setRemaining] = useState<number | null>(null)
    const [maxChars, setMaxChars] = useState(500)
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const abortRef = useRef<AbortController | null>(null)

    const loadStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/ai-assistant/chat', { cache: 'no-store' })
            if (!res.ok) return setEnabled(false)
            const data = await res.json()
            setEnabled(data.enabled === true)
            if (!data.enabled) return
            setRemaining(data.remaining ?? null)
            if (data.maxChars) setMaxChars(data.maxChars)
            setConversationId(data.conversationId ?? null)
            setMessages((data.messages || []).map((m: any) => ({ role: m.role, content: m.content, cards: m.cards })))
        } catch {
            setEnabled(false)
        }
    }, [])

    useEffect(() => {
        if (!dbUser?.id || isSubAgent) {
            setEnabled(false)
            return
        }
        loadStatus()
    }, [dbUser?.id, isSubAgent, loadStatus])

    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [messages, open])

    useEffect(() => () => abortRef.current?.abort(), [])

    const newChat = () => {
        abortRef.current?.abort()
        setBusy(false)
        setMessages([])
        setConversationId(null)
    }

    const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages(prev => {
            if (!prev.length) return prev
            const next = prev.slice()
            next[next.length - 1] = fn(next[next.length - 1])
            return next
        })

    const send = async (text: string) => {
        const message = text.trim()
        if (!message || busy) return
        setInput('')
        setBusy(true)
        setMessages(prev => [...prev, { role: 'user', content: message }, { role: 'assistant', content: '', pending: true }])

        const controller = new AbortController()
        abortRef.current = controller

        try {
            const res = await fetch('/api/ai-assistant/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, conversationId }),
                signal: controller.signal,
            })

            if (!res.ok || !res.body) {
                const data = await res.json().catch(() => ({}))
                if (res.status === 403) setEnabled(false)
                // Only the daily cap empties the counter; 'too_fast' is a one-minute pause.
                if (res.status === 429 && data.code !== 'too_fast') setRemaining(0)
                patchLast(m => ({ ...m, pending: false, content: data.error || 'Something went wrong. Please try again.' }))
                return
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let nl: number
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim()
                    buffer = buffer.slice(nl + 1)
                    if (!line) continue
                    let ev: any
                    try { ev = JSON.parse(line) } catch { continue }
                    if (ev.type === 'meta') setConversationId(ev.conversationId)
                    else if (ev.type === 'text') patchLast(m => ({ ...m, pending: false, content: m.content + ev.text }))
                    else if (ev.type === 'cards') patchLast(m => ({ ...m, pending: false, cards: [...(m.cards || []), ...ev.cards] }))
                    else if (ev.type === 'done') setRemaining(ev.remaining)
                }
            }
        } catch (err: any) {
            if (err?.name !== 'AbortError') {
                patchLast(m => ({ ...m, content: m.content || 'Connection lost. Please try again.' }))
            }
        } finally {
            patchLast(m => ({ ...m, pending: false }))
            setBusy(false)
        }
    }

    if (!enabled) return null

    const firstName = dbUser?.first_name?.trim()
    const outOfMessages = remaining === 0

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
                <button
                    type="button"
                    aria-label="Open ARHMS AI assistant"
                    className={cn(
                        // z-30: under the bottom nav's pop-up menu (z-40), which can open over this spot.
                        'fixed z-30 flex items-center gap-2 rounded-full bg-gradient-to-br from-primary to-violet-600 text-white shadow-lg shadow-primary/30 transition hover:scale-105 active:scale-95',
                        'left-4 bottom-[calc(7rem+env(safe-area-inset-bottom))] h-12 w-12 justify-center',
                        'md:left-auto md:right-6 md:bottom-6 md:h-auto md:w-auto md:px-4 md:py-3',
                    )}
                >
                    <Sparkles className="h-5 w-5" />
                    <span className="hidden text-sm font-semibold md:inline">ARHMS AI</span>
                </button>
            </Dialog.Trigger>

            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
                <Dialog.Content
                    aria-describedby={undefined}
                    className={cn(
                        'fixed z-50 flex flex-col bg-background shadow-2xl outline-none',
                        'inset-x-0 bottom-0 h-[92dvh] rounded-t-3xl data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom',
                        'md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[420px] md:rounded-none md:border-l md:data-[state=open]:slide-in-from-right md:data-[state=closed]:slide-out-to-right',
                    )}
                >
                    <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-muted md:hidden" />

                    {/* Header */}
                    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-600 text-white">
                            <Sparkles className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="text-base font-bold leading-tight">ARHMS AI</Dialog.Title>
                            <p className="text-xs text-muted-foreground">AI assistant</p>
                        </div>
                        <button type="button" onClick={newChat} aria-label="New chat" className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
                            <SquarePen className="h-5 w-5" />
                        </button>
                        <Dialog.Close aria-label="Close" className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
                            <X className="h-5 w-5" />
                        </Dialog.Close>
                    </div>

                    {/* Messages */}
                    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
                        {messages.length === 0 ? (
                            <div className="flex flex-col items-center pt-4 text-center">
                                <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-primary/40 text-primary">
                                    <Sparkles className="h-7 w-7" />
                                </div>
                                <h2 className="mt-4 bg-gradient-to-r from-primary to-violet-600 bg-clip-text text-xl font-bold text-transparent">
                                    Hi{firstName ? ` ${firstName}` : ''}, I am ARHMS AI
                                </h2>
                                <p className="mt-1 text-sm text-muted-foreground">Ask me anything about ARHMS.</p>
                                <div className="mt-6 w-full space-y-2">
                                    {SUGGESTIONS.map(s => (
                                        <button
                                            key={s}
                                            type="button"
                                            disabled={busy || outOfMessages}
                                            onClick={() => send(s)}
                                            className="w-full rounded-2xl border border-border bg-muted/40 px-4 py-3 text-left text-sm font-medium transition hover:border-primary/50 hover:bg-muted disabled:opacity-50"
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {messages.map((m, i) => (
                                    <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                                        <div
                                            className={cn(
                                                'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                                                m.role === 'user'
                                                    ? 'rounded-br-md bg-primary text-primary-foreground'
                                                    : 'rounded-bl-md bg-muted text-foreground',
                                            )}
                                        >
                                            {m.pending && !m.content ? (
                                                <span className="flex items-center gap-2 py-1 text-muted-foreground">
                                                    <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                                                </span>
                                            ) : m.role === 'user' ? (
                                                <p className="whitespace-pre-wrap break-words">{m.content}</p>
                                            ) : (
                                                <div className="break-words"><Formatted text={m.content} onNavigate={() => setOpen(false)} /></div>
                                            )}
                                            {m.cards?.length ? <BundleCards cards={m.cards} onPick={() => setOpen(false)} /> : null}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Input */}
                    <form
                        onSubmit={e => { e.preventDefault(); send(input) }}
                        className="border-t border-border px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3"
                    >
                        <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 py-1.5 pl-4 pr-1.5 focus-within:border-primary">
                            <input
                                value={input}
                                onChange={e => setInput(e.target.value.slice(0, maxChars))}
                                placeholder={outOfMessages ? 'Daily limit reached — back tomorrow' : 'Ask ARHMS AI anything…'}
                                disabled={outOfMessages}
                                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
                            />
                            <button
                                type="submit"
                                aria-label="Send"
                                disabled={busy || outOfMessages || !input.trim()}
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition disabled:opacity-40"
                            >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                            </button>
                        </div>
                        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                            ARHMS AI can make mistakes. Purchases always ask you to confirm.
                            {remaining !== null && ` · ${remaining} left today`}
                        </p>
                    </form>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
