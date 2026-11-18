-- ============================================================================
-- ARHMS AI — knowledge base (FAQ + policy rows the assistant searches)
-- ============================================================================
-- Edited by admins on /admin/ai-assistant. Read by the search_knowledge tool,
-- which filters by is_active and the caller's surface (contexts).
--
--   * Server code only: RLS on with NO policies, so anon/authenticated keys
--     can neither read nor write it; the service role bypasses RLS.
--   * Keep changing values (prices, fees) OUT of these rows: the assistant reads
--     those live through tools.
--   * Surfaces: dashboard | home | storefront | admin | whatsapp
--
-- Seeded from lib/ai-assistant/knowledge.ts (the get_help fallback text).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_knowledge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category    text NOT NULL,
    question    text NOT NULL,
    answer      text NOT NULL,
    contexts    text[] NOT NULL DEFAULT '{dashboard,home,storefront,whatsapp}',
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ai_knowledge_question_len CHECK (char_length(question) BETWEEN 3 AND 300),
    CONSTRAINT ai_knowledge_answer_len   CHECK (char_length(answer) BETWEEN 3 AND 2000),
    CONSTRAINT ai_knowledge_category_len CHECK (char_length(category) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_active_contexts
    ON public.ai_knowledge USING gin (contexts) WHERE is_active;

ALTER TABLE public.ai_knowledge ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role touches this table.

-- Seed once (skipped when any row already exists, so re-running is safe).
INSERT INTO public.ai_knowledge (category, question, answer, contexts)
SELECT v.category, v.question, v.answer, v.contexts::text[]
FROM (VALUES
    ('buying', 'How do I buy a data bundle?',
     $a$Open Data Packages from the menu, pick the network, tap a bundle, enter the recipient's number and pay from your wallet or with Mobile Money (Direct Pay). You can also buy for many numbers at once with Bulk Order on the same page.$a$,
     '{dashboard,home,whatsapp}'),
    ('wallet', 'How do I fund or top up my wallet?',
     $a$Open Wallet, tap Fund Wallet / Top Up, enter the amount and approve the Mobile Money prompt on your phone. The balance updates once the payment is confirmed; MTN MoMo can take a few minutes to confirm.$a$,
     '{dashboard,home,whatsapp}'),
    ('orders', 'Why did my order fail?',
     $a$An order can fail when the network is having issues, the number is wrong or not eligible, or the supplier refuses it. A failed order that was paid from the wallet is refunded to the wallet. Check the status in My Orders.$a$,
     '{dashboard,home,storefront,whatsapp}'),
    ('refunds', 'How do refunds work?',
     $a$Failed wallet orders are refunded to your ARHMS wallet automatically. If an order shows Failed but the money is not back after a few minutes, contact support on WhatsApp with the order reference.$a$,
     '{dashboard,home,whatsapp}'),
    ('delivery', 'How long does delivery take?',
     $a$Most bundles arrive within minutes. At busy times, or when a network is slow, it can take longer. The live Delivery Status on the dashboard shows current delivery times per network. If it has been much longer than usual, contact support with the order reference.$a$,
     '{dashboard,home,storefront,whatsapp}'),
    ('mtn', 'My MTN number is not registered for data. What happens?',
     $a$Some MTN numbers are not yet registered for data bundles. When that happens the buy page warns you before paying; you can still continue, but the bundle may only arrive once the number is registered, which can take up to 2 weeks.$a$,
     '{dashboard,home,storefront,whatsapp}'),
    ('agents', 'How do I become an agent or dealer?',
     $a$Agents and dealers buy at lower prices. Look for the Upgrade / Become an Agent option on the dashboard to see the current plans and prices.$a$,
     '{dashboard,home,whatsapp}'),
    ('airtime', 'How do I buy airtime?',
     $a$Open Airtime from the menu, choose the network, enter the number and amount, and pay from your wallet. A small fee is taken out of the amount.$a$,
     '{dashboard,home,whatsapp}'),
    ('afa', 'How do I do MTN AFA registration?',
     $a$MTN AFA registration is under AFA in the menu. Fill in the details from the Ghana Card and pay; the registration is processed by the team.$a$,
     '{dashboard,home,whatsapp}'),
    ('checker', 'How do I buy a WASSCE or BECE results checker?',
     $a$WASSCE/BECE results checker vouchers are sold under Results Checker in the menu. Pay from your wallet and the voucher appears on the page and in your orders.$a$,
     '{dashboard,home,whatsapp}'),
    ('shop', 'Can I open my own shop or storefront?',
     $a$Agents and dealers can open their own shop (storefront) with their own prices under Shop in the menu, and share the link with customers.$a$,
     '{dashboard,home,whatsapp}')
) AS v(category, question, answer, contexts)
WHERE NOT EXISTS (SELECT 1 FROM public.ai_knowledge);
