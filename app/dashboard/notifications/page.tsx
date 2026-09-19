'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatDate } from '@/lib/utils'
import { usePwa } from '@/hooks/use-pwa'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Bell,
    BellRing,
    BellOff,
    CheckCircle2,
    ShoppingCart,
    CreditCard,
    MessageSquare,
    Wallet,
    Trash2,
    Check,
    Loader2,
    Trash,
    Share2,
    Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Notification } from '@/types/supabase'

function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base64)
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

const NOTIFICATION_FETCH_LIMIT = 100
const NOTIFICATION_PAGE_SIZE = 25

export default function NotificationsPage() {
    const { dbUser } = useAuth()
    const { isIOS, isInstalled } = usePwa()
    const [notifications, setNotifications] = useState<Notification[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [filter, setFilter] = useState<'all' | 'unread'>('all')
    const [markingAllRead, setMarkingAllRead] = useState(false)
    const [deletingAll, setDeletingAll] = useState(false)
    const [pushPermission, setPushPermission] = useState<NotificationPermission | null>(null)
    const [isPushSupported, setIsPushSupported] = useState(false)
    const [isSubscribing, setIsSubscribing] = useState(false)
    const [visibleCount, setVisibleCount] = useState(NOTIFICATION_PAGE_SIZE)

    useEffect(() => {
        setVisibleCount(NOTIFICATION_PAGE_SIZE)
    }, [filter])

    useEffect(() => {
        if (!dbUser) return

        fetchNotifications()

        const channel = supabase
            .channel(`notif-page:${dbUser.id}`)
            .on(
                'postgres_changes' as any,
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'notifications',
                    filter: `user_id=eq.${dbUser.id}`,
                },
                (payload: any) => {
                    setNotifications(prev => [payload.new as Notification, ...prev])
                }
            )
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [dbUser])

    useEffect(() => {
        if (typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator) {
            setIsPushSupported(true)
            const perm = Notification.permission
            setPushPermission(perm)
            // Silently refresh subscription on every load — fixes stale/key-rotated subs
            if (perm === 'granted') {
                refreshSubscription()
            }
        }
    }, [])

    const pushSubscribe = async (registration: ServiceWorkerRegistration) => {
        const key = urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!)
        try {
            return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        } catch {
            // VAPID key mismatch — unsubscribe stale subscription and retry
            const old = await registration.pushManager.getSubscription()
            if (old) await old.unsubscribe()
            return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        }
    }

    const refreshSubscription = async () => {
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await pushSubscribe(registration)
            await fetch('/api/notifications/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(subscription.toJSON()),
            })
        } catch {
            // Silent — user will see the Enable button on next visit if this fails
        }
    }

    const subscribeToPush = async () => {
        setIsSubscribing(true)
        try {
            const permission = await Notification.requestPermission()
            setPushPermission(permission)
            if (permission !== 'granted') {
                toast.error('Push notifications blocked. Enable them in your browser settings.')
                return
            }
            const registration = await navigator.serviceWorker.ready
            const subscription = await pushSubscribe(registration)
            const res = await fetch('/api/notifications/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(subscription.toJSON()),
            })
            if (res.ok) {
                toast.success('Push alerts enabled!')
            } else {
                throw new Error('Subscribe failed')
            }
        } catch {
            toast.error('Failed to enable push notifications')
        } finally {
            setIsSubscribing(false)
        }
    }

    const unsubscribeFromPush = async () => {
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (subscription) {
                await fetch('/api/notifications/unsubscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: subscription.endpoint }),
                })
                await subscription.unsubscribe()
            }
            setPushPermission('default')
            toast.success('Push notifications disabled')
        } catch {
            toast.error('Failed to disable push notifications')
        }
    }

    const fetchNotifications = async () => {
        try {
            const { data, error } = await supabase
                .from('notifications')
                .select('*')
                .eq('user_id', dbUser?.id as any)
                .order('created_at', { ascending: false })
                // Bounded: this used to download every notification the account
                // had ever received. The counts below stay exact for anyone
                // under the cap, and the list says so when it is reached.
                .limit(NOTIFICATION_FETCH_LIMIT)

            if (error) throw error
            setNotifications(data || [])
        } catch (error) {
            console.error('Error fetching notifications:', error)
            toast.error('Failed to load notifications')
        } finally {
            setIsLoading(false)
        }
    }

    const markAsRead = async (id: string) => {
        try {
            await (supabase
                .from('notifications') as any)
                .update({ is_read: true })
                .eq('id', id)

            setNotifications(prev =>
                prev.map(n => n.id === id ? { ...n, is_read: true } : n)
            )
        } catch (error) {
            toast.error('Failed to mark as read')
        }
    }

    const markAllAsRead = async () => {
        setMarkingAllRead(true)
        try {
            await (supabase
                .from('notifications') as any)
                .update({ is_read: true })
                .eq('user_id', dbUser?.id as any)
                .eq('is_read', false)

            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
            toast.success('All notifications marked as read')
        } catch (error) {
            toast.error('Failed to mark all as read')
        } finally {
            setMarkingAllRead(false)
        }
    }

    const deleteNotification = async (id: string) => {
        try {
            await (supabase
                .from('notifications') as any)
                .delete()
                .eq('id', id)

            setNotifications(prev => prev.filter(n => n.id !== id))
            toast.success('Notification deleted')
        } catch (error) {
            toast.error('Failed to delete notification')
        }
    }

    const deleteAllNotifications = async () => {
        setDeletingAll(true)
        try {
            await (supabase
                .from('notifications') as any)
                .delete()
                .eq('user_id', dbUser?.id as any)

            setNotifications([])
            toast.success('All notifications deleted')
        } catch (error) {
            toast.error('Failed to delete all notifications')
        } finally {
            setDeletingAll(false)
        }
    }

    const getIcon = (type: string) => {
        switch (type) {
            case 'order_update':
                return <ShoppingCart className="w-5 h-5 text-blue-500" />
            case 'payment_success':
                return <CreditCard className="w-5 h-5 text-green-500" />
            case 'complaint_resolved':
                return <MessageSquare className="w-5 h-5 text-purple-500" />
            case 'balance_updated':
                return <Wallet className="w-5 h-5 text-amber-500" />
            default:
                return <Bell className="w-5 h-5 text-gray-500" />
        }
    }

    const filteredNotifications = filter === 'unread'
        ? notifications.filter(n => !n.is_read)
        : notifications

    const unreadCount = notifications.filter(n => !n.is_read).length

    // Render a page at a time: several hundred cards is what makes this list
    // stutter on a low-end phone.
    const visibleNotifications = filteredNotifications.slice(0, visibleCount)

    if (isLoading) {
        return (
            <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-20" />
                ))}
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col items-center gap-4 text-center">
                <div>
                    <h1 className="text-xl sm:text-2xl font-bold">Notifications</h1>
                    <p className="text-sm text-muted-foreground">
                        {unreadCount > 0 ? `${unreadCount} unread notification${unreadCount > 1 ? 's' : ''}` : 'All caught up!'}
                    </p>
                </div>
                <div className="flex gap-2 flex-wrap justify-center">
                    {unreadCount > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={markAllAsRead}
                            disabled={markingAllRead}
                            className="sm:flex-none"
                        >
                            {markingAllRead ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <Check className="w-4 h-4 sm:mr-2" />}
                            <span className="hidden sm:inline">Mark all as read</span>
                            <span className="sm:hidden">Mark read</span>
                        </Button>
                    )}
                    {notifications.length > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={deleteAllNotifications}
                            disabled={deletingAll}
                            className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 sm:flex-none"
                        >
                            {deletingAll ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <Trash className="w-4 h-4 sm:mr-2" />}
                            <span className="hidden sm:inline">Delete All</span>
                            <span className="sm:hidden">Delete</span>
                        </Button>
                    )}
                </div>
            </div>

            {/* iOS "Add to Home Screen" prompt */}
            {isIOS && !isInstalled && (
                <Card className="border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20">
                    <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                            <Smartphone className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold">Install app for push alerts</p>
                            <p className="text-xs text-muted-foreground">
                                On iPhone/iPad, push notifications only work when the app is installed.
                                Tap <Share2 className="w-3 h-3 inline mx-0.5" /> <strong>Share</strong> → <strong>Add to Home Screen</strong>.
                            </p>
                        </div>
                        <Link href="/dashboard/install" className="flex-shrink-0">
                            <Button size="sm" variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/40">
                                Install
                            </Button>
                        </Link>
                    </CardContent>
                </Card>
            )}

            {/* Push opt-in / status card */}
            {isPushSupported && (!isIOS || isInstalled) && pushPermission !== 'granted' && (
                <Card className="border-primary/20 bg-primary/5">
                    <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <BellRing className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold">Enable push alerts</p>
                            <p className="text-xs text-muted-foreground">
                                Get notified about orders and payments even when the app is closed.
                            </p>
                        </div>
                        {pushPermission === 'denied' ? (
                            <div className="flex items-center gap-1 text-xs text-destructive flex-shrink-0">
                                <BellOff className="w-4 h-4" />
                                <span>Blocked</span>
                            </div>
                        ) : (
                            <Button
                                size="sm"
                                onClick={subscribeToPush}
                                disabled={isSubscribing}
                                className="flex-shrink-0"
                            >
                                {isSubscribing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Enable'}
                            </Button>
                        )}
                    </CardContent>
                </Card>
            )}
            {isPushSupported && (!isIOS || isInstalled) && pushPermission === 'granted' && (
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                    <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                            <BellRing className="w-3.5 h-3.5 text-green-500" />
                            Push alerts active
                        </span>
                        <button 
                            type="button" 
                            onClick={async () => {
                                toast.info('Sending test notification...')
                                try {
                                    const res = await fetch('/api/notifications/test', { method: 'POST' })
                                    if (!res.ok) throw new Error('Failed to send')
                                } catch (e) {
                                    toast.error('Failed to trigger test push')
                                }
                            }} 
                            className="underline text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                        >
                            Send Test Alert
                        </button>
                    </div>
                    <button type="button" onClick={unsubscribeFromPush} className="underline hover:text-foreground transition-colors">
                        Disable
                    </button>
                </div>
            )}

            {/* Filter */}
            <div className="flex gap-2">
                <Button
                    variant={filter === 'all' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFilter('all')}
                >
                    All ({notifications.length})
                </Button>
                <Button
                    variant={filter === 'unread' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFilter('unread')}
                >
                    Unread ({unreadCount})
                </Button>
            </div>

            {/* Notifications List */}
            {filteredNotifications.length === 0 ? (
                <Card className="p-12 text-center">
                    <Bell className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                    <p className="text-muted-foreground">
                        {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
                    </p>
                </Card>
            ) : (
                <div className="space-y-3">
                    {visibleNotifications.map((notification) => (
                        <Card
                            key={notification.id}
                            className={`transition-all ${!notification.is_read
                                ? 'bg-blue-50/50 dark:bg-blue-950/20 border-l-4 border-l-blue-500'
                                : ''
                                }`}
                        >
                            <CardContent className="p-4">
                                <div className="flex items-start gap-4">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${!notification.is_read ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-muted'
                                        }`}>
                                        {getIcon(notification.type)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <h3 className={`font-medium ${!notification.is_read ? 'text-foreground' : 'text-muted-foreground'}`}>
                                                    {notification.title}
                                                </h3>
                                                <p className="text-sm text-muted-foreground mt-1">
                                                    {notification.message}
                                                </p>
                                                <p className="text-xs text-muted-foreground mt-2">
                                                    {formatDate(notification.created_at)}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                {!notification.is_read && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => markAsRead(notification.id)}
                                                    >
                                                        <CheckCircle2 className="w-4 h-4" />
                                                    </Button>
                                                )}
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                                                    onClick={() => deleteNotification(notification.id)}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}

                    {filteredNotifications.length > visibleNotifications.length && (
                        <div className="flex flex-col items-center gap-2 pt-2">
                            <Button
                                variant="outline"
                                className="w-full sm:w-auto"
                                onClick={() => setVisibleCount(c => c + NOTIFICATION_PAGE_SIZE)}
                            >
                                Load more
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                Showing {visibleNotifications.length} of {filteredNotifications.length}
                            </p>
                        </div>
                    )}

                    {notifications.length >= NOTIFICATION_FETCH_LIMIT && (
                        <p className="pt-2 text-center text-xs text-muted-foreground">
                            Showing your {NOTIFICATION_FETCH_LIMIT} most recent notifications.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
