/**
 * Handover between the de-branded signup and login pages.
 *
 * A recruit almost always signs up on the phone of whoever recruited them, and
 * signup never touches the browser session — so the recruiter is still logged
 * in afterwards. The signup page ends that session and leaves the new account's
 * email here, so the login page can prefill it and, if the sign-out did not
 * take, recognise that the live session belongs to somebody else.
 *
 * Session-scoped on purpose: it should not outlive the tab.
 */
export const PENDING_SIGNUP_EMAIL_KEY = 'portal_signup_email'

/** Reads the pending email. Returns null when storage is unavailable. */
export function readPendingSignupEmail(): string | null {
    try {
        return sessionStorage.getItem(PENDING_SIGNUP_EMAIL_KEY)
    } catch {
        return null
    }
}

export function writePendingSignupEmail(email: string): void {
    try {
        sessionStorage.setItem(PENDING_SIGNUP_EMAIL_KEY, email.trim().toLowerCase())
    } catch {
        // Private mode or blocked storage. The sign-out on the signup page is
        // the primary protection; this is the backstop, so losing it is safe.
    }
}

export function clearPendingSignupEmail(): void {
    try {
        sessionStorage.removeItem(PENDING_SIGNUP_EMAIL_KEY)
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
