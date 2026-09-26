'use client'

import { ShieldAlert } from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog'

/**
 * Shown when a sale is refused because the beneficiary's MTN number has never been
 * registered for data on our supplier account. Used by the storefront and by the
 * dashboard's purchase paths.
 *
 * There is nothing to agree to here. Every surface the gate applies to refuses
 * outright — see lib/mtn-registration-gate.ts for where it runs and why API v1 is
 * the one exemption.
 *
 * Two things the copy has to get right:
 *
 *   1. Registration has ALREADY started, and saying so is accurate — the check that
 *      produced this dialog submits the number as a side effect.
 *
 *   2. It must NOT promise a delivery. No order exists; nothing was charged. The only
 *      honest offer is "come back once registration finishes".
 */
export interface MtnRegistrationDialogProps {
    open: boolean
    /** The refused number. For a batch, the first one — `numbers` carries the rest. */
    phoneNumber?: string
    /** All refused numbers, when a batch triggered this. */
    numbers?: string[]
    /** Total lines in the batch, for the "3 of 20" framing. */
    total?: number
    onCancel: () => void
    /**
     * Forwarded to Radix. Callers that want to place the cursor somewhere specific on
     * close must do it here and preventDefault() — Radix restores focus to whatever was
     * focused when the dialog opened, and that restore would otherwise land after (and
     * undo) any focus() called from onCancel.
     */
    onCloseAutoFocus?: (event: Event) => void
}

export function MtnRegistrationDialog({
    open,
    phoneNumber,
    numbers,
    total,
    onCancel,
    onCloseAutoFocus,
}: MtnRegistrationDialogProps) {
    const blocked = numbers && numbers.length > 0 ? numbers : phoneNumber ? [phoneNumber] : []
    const isBatch = blocked.length > 1

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
            {/* z-[110] beats the hand-rolled purchase sheets (z-[70]) and the storefront
                sidebar (z-[100]). Those callers also hide themselves while this is open —
                this is the backstop so the prompt is never buried by a new overlay. */}
            <DialogContent className="w-[95%] max-w-sm rounded-2xl z-[110]" onCloseAutoFocus={onCloseAutoFocus}>
                <DialogHeader>
                    <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                        <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                    </div>
                    <DialogTitle className="text-center">
                        {isBatch
                            ? `${blocked.length}${total ? ` of ${total}` : ''} numbers can’t receive data yet`
                            : 'This number can’t receive data yet'}
                    </DialogTitle>
                    <DialogDescription className="text-center">
                        {isBatch
                            ? 'These MTN numbers have never received data from us before. We’ve started registering them — this can take up to 2 weeks.'
                            : 'This MTN number has never received data from us before. We’ve started registering it — this can take up to 2 weeks.'}
                    </DialogDescription>
                </DialogHeader>

                {blocked.length > 0 && (
                    <div className="max-h-32 overflow-y-auto rounded-xl bg-muted/60 px-3 py-2">
                        {blocked.map((n) => (
                            <p key={n} className="font-mono text-sm font-semibold tracking-wide">
                                {n}
                            </p>
                        ))}
                    </div>
                )}

                <p className="text-center text-xs text-muted-foreground">
                    You can&apos;t buy data for {isBatch ? 'these numbers' : 'this number'} until
                    registration finishes. Nothing has been charged. Once it&apos;s done, orders
                    to {isBatch ? 'them' : 'it'} go through instantly.
                </p>

                <div className="mt-1 flex flex-col gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-700"
                    >
                        Try another number
                    </button>

                    <button
                        type="button"
                        onClick={onCancel}
                        className="w-full rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted"
                    >
                        Close
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
