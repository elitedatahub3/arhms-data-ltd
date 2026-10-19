import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /r/<code> — the old Refer & Earn link. The referral programme was removed;
 * links already shared still land somewhere useful instead of a 404. The code
 * is dropped: nothing attributes or pays on it any more.
 */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/auth/signup', request.nextUrl.origin), 307)
}
