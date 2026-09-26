# Sub-Agents Implementation Guide

## Overview

This document details the complete sub-agents (network/affiliate) system for ARHMS. A sub-agent is a user recruited by a Lead (eligible shop owner) who operates in two modes:

1. **Wallet Mode** — Deposits into personal wallet, buys data at Lead's wholesale sub_price
2. **Storefront Mode** — Runs own-branded storefront, customers pay retail, sub earns markup above sub_price

The network runs **three levels**: Lead (L0) → sub (L1) → sub-of-sub (L2). An L2
cannot recruit.

Profits split atomically, each level keeping the spread it adds. The rule: *a
level's cost is its upline's wholesale price if it has an upline, otherwise its
platform role price.* With one level of downline this reduces exactly to the
original two-level split, so existing chains were unaffected by the change.

```
customer pays      L2.selling_price
  L2 earns         L2.selling_price - cost(L2)    cost(L2) = COALESCE(L1.sub_price, L1.selling_price)
  L1 earns         cost(L2)         - cost(L1)    cost(L1) = COALESCE(L0.sub_price, L0.selling_price)
  L0 earns         cost(L1)         - cost(L0)    cost(L0) = resolveOwnerCost(pkg, L0.role)
  platform earns   cost(L0)         - pkg.cost_price
```

Implemented by `splitChainProfit()` in `lib/pricing/chain-cost.ts` (unit-tested by
`scripts/test-chain-split.ts`) and paid out by `credit_shop_order_profits()`,
which credits up to three wallets — `SUBPROFIT-` / `LEADPROFIT-` / `GRANDPROFIT-`,
each leg claimed by its own reference.

---

## Architecture

### Data Model

**Core tables (Phase 1 migration):**
- `sub_agents` — Membership (status='pending'|'active'|'suspended')
- `shop_invites` — Revocable invite codes (max_uses, expires_at, revoked_at)
- `shop_pricing.sub_price` — Lead's wholesale price per package
- `shop_orders.parent_shop_id, parent_profit` — Attribution for sub sales
- `shop_wallet_transactions.*_approval_*` — Withdrawal approval chain

**Reused tables:**
- `shop_profiles` — Both Lead and sub run storefronts
- `shop_wallets`, `shop_wallet_transactions` — Wallets + ledger
- `users` — Authentication (no Google for subs)

### Key Decision Points

| # | Decision | Rationale |
|----|----------|-----------|
| D1 | ~~2-level hierarchy (no sub-of-sub)~~ — **superseded 2026-08-25: 3 levels** | Was v1 scope. The third level was never actually blocked: `POST /api/shop/invites` authorised on "do you own a shop?" alone, and a sub in storefront mode owns one — so the cap lived only in this table while the money code assumed it held. Now enforced by `sub_agents.depth` + a CHECK + a trigger, with matching guards in the invite and signup routes. |
| D2 | Live eligibility checks (not cached) | Prevents fund locks if Lead degrades |
| D3 | 48h escalation on withdrawn → admin | Prevents Lead from silencing subs |
| D4 | de-branded portal + dashboard | Subs operate under own brand, not platform |
| D5 | Atomic credit RPCs only (no direct UPDATEs) | Prevents partial failures, idempotent |
| D6 | Profit floors on all charge paths | Catches downgrade races |

---

## RLS Security Model

### Policies

**sub_agents table:**
- Lead reads all their subs: `upline_shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = auth.uid())`
- Sub reads own row: `user_id = auth.uid()`
- Admin reads all (bypass via is_admin())

**shop_pricing table:**
- Sub can read upline's sub_price: `shop_id IN (SELECT upline_shop_id FROM sub_agents WHERE user_id = auth.uid())`

**shop_orders table:**
- Lead reads sub orders: `parent_shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = auth.uid())`

**shop_wallet_transactions table:**
- Lead approves/rejects sub withdrawals: Can UPDATE rows where sub_agents.upline_shop_id = Lead's shop

### SECURITY DEFINER RPCs

All new RPCs run with elevated privileges (REVOKE from anon/authenticated):
- `credit_shop_order_profits(order_id)` — Atomically credit sub + Lead
- `credit_lead_margin(order_id, upline_shop_id, amount)` — Credit Lead on wallet buys
- `approve_sub_withdrawal(withdrawal_id, note)` — Lead approves
- `reject_sub_withdrawal(withdrawal_id, note)` — Lead rejects (refunds)
- `adjust_shop_pricing_for_role_change_v2(...)` — Reprice on role change (with dealer branch)

**Verification:**
```sql
-- After deploying RPCs, run:
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'sub_agents' AND privilege_type = 'SELECT';

-- Should NOT show 'anon' or 'authenticated' with INSERT/UPDATE/DELETE
```

---

## Charge-Entry Coverage Matrix (Security-Critical)

Every path a sub could transact through must apply sub-pricing + eligibility, or block:

| Path | File | Behavior |
|------|------|----------|
| Storefront checkout | `lib/shop-checkout.ts` | Sub retail from sub's shop_pricing; eligibility gate |
| Webhook processor | `lib/shop-order-processor.ts` | Profit floor validation |
| Wallet purchase | `app/api/orders/purchase/route.ts` | Sub-priced at upline sub_price; eligibility gate |
| Bulk purchase | `app/api/orders/bulk-purchase/route.ts` | 403 "not available yet" |
| v1 API | `app/api/v1/data/purchase/route.ts` | 403 "not available on v1 API" |
| USSD | TBD | Block subs (find charge path) |

**Verification script:**
```bash
# Grep for sub-agent checks in all charge paths
grep -r "sub_agents\|isSub" app/api/orders app/api/v1 lib/shop*
```

---

## Eligibility & Downgrade Handling

### Live Eligibility Check

A Lead is eligible while their **shop** is approved and active. Role standing
(`canOwnSubNetwork()` in `lib/pricing/cost-basis.ts`: lifetime agent or unexpired
dealer) is accepted as an alternative, never as a requirement — a Lead is made by
getting a shop approved, not by buying a subscription, and in production nearly
every live Lead is role `customer`.

```typescript
// In TypeScript (lib/sub-agents.ts):
async function isUplineEligible(db, uplineShopId, uplineOwnerId) {
  // shop_profiles.approval_status = 'approved' AND shop_profiles.is_active
  //   OR canOwnSubNetwork(upline user)
}
```

**Evaluated at every gate:**
- Sub activation (status=pending → active)
- Sub purchase eligibility
- Lead approval (checks Lead is still eligible before approving withdrawal)
- Escalation cron (marks for escalation if Lead becomes ineligible)

### Downgrade Handling (Dealer → Agent)

When a dealer expires (cron `downgrade-expired-dealers`):
1. Role changes: `dealer` → `agent`, `agent_expires_at := NULL`
2. Cost basis rises: `dealer_price` → `agent_price`
3. Reprice triggered: `adjust_shop_pricing_for_role_change_v2()` re-calculates storefront prices
4. Sub_price cascaded: If sub_price < new_owner_cost + min_margin, bumped up and sub notified

**Residual risk (R-4):** Verify withdrawal/escalation flow does NOT gate on Lead's current role, so paused sub-owners aren't locked out of their money.

---

## Withdrawal Chain + 48h Escalation

### States

```
Sub requests withdrawal
        ↓
status='shop_owner_pending'
sub_approval_status='pending'
escalate_after=now()+48h
        ↓
  [LEAD DECISION]
        ↙          ↘
    APPROVE      REJECT
        ↓            ↓
status='pending'  Refund,
Enters admin      mark rejected
payout queue      (visible in history)
```

### Escalation Cron

**Endpoint:** `GET /api/cron/escalate-sub-withdrawals` (requires CRON_SECRET)

**Triggers:**
1. escalate_after < now() (48h passed)
2. Lead is ineligible (checked live)
3. Lead is suspended

**Action:**
- Move from `shop_owner_pending` → `pending`
- Set `auto_escalated=true` (flags for admin extra verification)
- Send SMS to Lead (optional): "Withdrawal auto-escalated due to timeout"

**Registration:** Must be registered on cronjob.org:
```
Service: cronjob.org
Endpoint: https://your-domain/api/cron/escalate-sub-withdrawals
Frequency: Hourly (0 * * * *)
Headers: Authorization: Bearer {CRON_SECRET}
```

---

## De-Branding

### Portal (`app/(portal)/join/[code]/`)

Sub sees Lead's brand + logo on signup page. After account creation, sub receives email/SMS from their Lead's shop name.

### Dashboard (`app/dashboard/sub/`)

`BrandContext` resolver returns Lead's branding:
- App name → Lead's shop name
- Logo → Lead's logo_url
- Colors → Lead's brand_color/brand_accent
- Hidden menus → "Become Dealer", "Get App", platform promos

Sub sees "Powered by {Lead shop name}" footer (honest limits: SMS sender ID + email domain still platform-level in v1).

---

## Cost-Basis Consolidation (D17)

**Problem:** Five drifted resolvers (TS checkout, processor, API; SQL trigger, RPC).

**Solution:** Single source of truth.

- **SQL:** `effective_owner_cost(pkg_id, user_id)` function
- **TS:** `resolveOwnerCost(pricing, owner)` in lib/pricing/cost-basis.ts
- **Parity test:** `scripts/test-cost-basis.ts` verifies all combinations match

**Apply everywhere:**
- Checkout: `const cost = resolveOwnerCost(pricing, { role, agentExpiresAt, dealerExpiresAt })`
- Reprice: Use SQL `effective_owner_cost()` in RPC

---

## Testing & Verification

### Unit Tests

1. **Cost-Basis Parity** (`scripts/test-cost-basis.ts`):
   ```bash
   npx ts-node scripts/test-cost-basis.ts
   ```
   Tests all role × expiry state combinations match between TS and (TODO) SQL.

2. **Profit-Split Flow** (`scripts/test-profit-split.ts`):
   ```bash
   npx ts-node scripts/test-profit-split.ts
   ```
   Creates test Lead, Sub, shop, pricing. Simulates guest payment → RPC credit. Verifies wallets.

### RLS Audit

1. **Check REVOKE statements:**
   ```sql
   -- Should NOT have anon/authenticated execute permissions
   SELECT grantee, privilege_type
   FROM information_schema.role_table_grants
   WHERE routine_name IN (
     'credit_shop_order_profits',
     'credit_lead_margin',
     'approve_sub_withdrawal',
     'reject_sub_withdrawal'
   );
   ```

2. **Check table policies:**
   ```sql
   SELECT schemaname, tablename, policyname, qual
   FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN (
     'sub_agents', 'shop_invites'
   );
   ```

3. **Verify Leads can't write sub wallets:**
   - Lead UPDATE shop_wallets WHERE owner_id = sub.user_id should fail (RLS denies)

### Functional Tests

1. **Eligibility gates:**
   - Sub with status='pending' cannot buy (should 403)
   - Sub with ineligible Lead cannot buy (should 403)
   - Sub with status='suspended' cannot buy (should 403)

2. **Withdrawal escalation:**
   - Create shop_owner_pending withdrawal with escalate_after=now()-1hour
   - Run cron
   - Verify status='pending', auto_escalated=true

3. **Profit floors:**
   - Set sub_price = owner_cost (no margin)
   - Attempt storefront sale
   - Should be rejected (profit <= 0)

---

## Deployment Checklist

- [ ] Phase 1 migration deployed (schema, RLS, enums)
- [ ] Phase 2 RPCs deployed (credit_shop_order_profits, approval, reprice_v2)
- [ ] Phase 3 API routes updated (sub gates, profit floors, blocking v1/bulk)
- [ ] Phase 4 cron endpoint created + registered on cronjob.org
- [ ] Phase 5 de-branded portal live (join page + signup)
- [ ] Phase 6 API routes live (invites, sub-agents, withdrawals)
- [ ] Phase 7 dashboards deployed (Lead, Admin, Sub)
- [ ] Phase 8 tests passing (cost-basis, profit-split, RLS)
- [ ] Cronjob registered: escalate-sub-withdrawals (hourly)
- [ ] get_advisors audit passed (new RPCs listed)
- [ ] SMS service extended (sendSubAgentOtpSms)
- [ ] Email service parameterized (brandConfig)
- [ ] Docs updated (support, billing, terms)

---

## Residual Risks

| # | Risk | Mitigation | Owner |
|----|------|-----------|-------|
| R-1 | Deployed adjust_shop_pricing_for_role_change differs from repo | Verify live function body before Stage 2 | DevOps |
| R-2 | Reprice errors swallowed silently | Add reconciliation cron flagging underwater shop_pricing rows | TBD |
| R-3 | Five resolvers drift again | Keep cost-basis test in CI/CD | Dev |
| R-4 | Paused Lead can gate sub funds | Verify withdrawal escalation doesn't check Lead.role | QA |
| R-5 | schema.sql becomes stale | Build DB state from migrations + types/supabase.ts | Dev |
| R-6 | Cron not registered | Register escalate-sub-withdrawals on cronjob.org before go-live | DevOps |
| R-7 | Wallet-mode Lead credit unclear | Decide: lightweight shop_orders rows (option a) vs dedicated RPC (option b) | Product |

---

## Out of Scope (Phase 2)

- Neutral white-label domain (v1 uses store.arhmsgh.com)
- Per-shop SMS sender ID / email domain
- Google sign-up for subs
- Subs on USSD/v1 API/bulk (v1 scope, unblock in Phase 2)
- Leaderboard, auto-approve, downline statements
- Sub PWA white-label
- Owner-set join fee
- Paying every level on **airtime, Results Checker and AFA**. Storefront parity
  shipped — all four tiles now render on a sub storefront at any level, seeded by
  `seedSubShopFromParent()` and priced via `/api/dashboard/sub/{rc,afa}-pricing` —
  but the payout for those three still credits only the seller (airtime) or only
  the direct upline (RC/AFA), exactly as at two levels.
- Wallet-mode purchases still pay no upline: `credit_lead_margin()` exists and is
  never called. The eligibility gate in `lib/data-order-pricing.ts` no longer
  blocks them — it reads the Lead's shop standing rather than their role.

---

## Support

For questions, refer to:
- **Schema design:** See migration comments in `20260703_sub_agents.sql`
- **RLS policies:** grep "POLICY" in supabase/sub_agents_rpcs.sql
- **API routes:** Check endpoint comments (route.ts files)
- **Tests:** See scripts/test-*.ts for expected behavior
