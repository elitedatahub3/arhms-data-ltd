-- ============================================================
-- Three-leg profit split for the level-3 sub-agent network.
--
-- Apply migrations/20260825_sub_agent_level_3.sql FIRST — this function reads
-- shop_orders.grandparent_shop_id / grandparent_profit.
--
-- The two-leg version (20260812_sub_ussd_and_profit_split.sql) credited the
-- seller and one upline. A level-2 sub has two ancestors, so a third leg is
-- needed or the root Lead is silently paid nothing.
--
-- The per-leg body was identical twice over and is now three times over, so it
-- moves into credit_shop_order_leg(). The idempotency contract is unchanged and
-- is the important part: the ledger insert claims the credit via the partial
-- unique index idx_shop_wallet_tx_reference (reference, type), and the balance
-- moves only if that insert won. Each leg keeps its own reference —
-- SUBPROFIT- / LEADPROFIT- / GRANDPROFIT- — so two legs of equal value can
-- never be mistaken for one another.
-- ============================================================

-- ── One leg ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_shop_order_leg(
  p_shop_order_id UUID,
  p_owner_id      UUID,
  p_amount        DECIMAL,
  p_description   TEXT,
  p_reference     TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_wallet_id UUID;
  v_rows      INT;
BEGIN
  -- A zero leg is normal, not an error: an upline can raise their price after a
  -- downline set theirs, leaving that level nothing on this sale.
  IF p_owner_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (p_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = p_owner_id;

  IF v_wallet_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- The arbiter index is partial (WHERE reference IS NOT NULL), so the
  -- predicate has to be restated here for Postgres to infer it.
  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, shop_order_id, type, amount, description, status, reference)
  VALUES
    (v_wallet_id, p_shop_order_id, 'profit', p_amount,
     p_description, 'completed', p_reference)
  ON CONFLICT (reference, type) WHERE reference IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN FALSE;  -- already credited
  END IF;

  UPDATE public.shop_wallets
  SET balance      = balance + p_amount,
      total_earned = total_earned + p_amount,
      updated_at   = NOW()
  WHERE id = v_wallet_id;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_shop_order_leg(UUID, UUID, DECIMAL, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_shop_order_leg(UUID, UUID, DECIMAL, TEXT, TEXT) TO service_role;


-- ── All legs of one order ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_shop_order_profits(
  p_shop_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- ALIAS FOR positional args: avoids parameter resolution issues under
  -- SECURITY DEFINER + empty search_path (same pattern as the other RPCs).
  _shop_order_id    ALIAS FOR $1;
  v_sub_profit      DECIMAL;
  v_parent_profit   DECIMAL;
  v_grand_profit    DECIMAL;
  v_owner_id        UUID;
  v_upline_owner_id UUID;
  v_grand_owner_id  UUID;
  v_legacy_sub_tx   UUID;
  v_sub_credited    BOOLEAN := FALSE;
  v_parent_credited BOOLEAN := FALSE;
  v_grand_credited  BOOLEAN := FALSE;
BEGIN
  -- Serialize concurrent webhooks for the same order.
  PERFORM pg_advisory_xact_lock(hashtext(_shop_order_id::text));

  SELECT
    so.profit,            -- the seller's own markup in storefront mode
    so.parent_profit,
    so.grandparent_profit,
    sp.owner_id,
    sp_upline.owner_id,
    sp_grand.owner_id
  INTO
    v_sub_profit,
    v_parent_profit,
    v_grand_profit,
    v_owner_id,
    v_upline_owner_id,
    v_grand_owner_id
  FROM public.shop_orders so
  JOIN public.shop_profiles sp ON so.shop_id = sp.id
  LEFT JOIN public.shop_profiles sp_upline ON so.parent_shop_id = sp_upline.id
  LEFT JOIN public.shop_profiles sp_grand  ON so.grandparent_shop_id = sp_grand.id
  WHERE so.id = _shop_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  v_sub_profit    := COALESCE(v_sub_profit, 0);
  v_parent_profit := COALESCE(v_parent_profit, 0);
  v_grand_profit  := COALESCE(v_grand_profit, 0);

  IF v_sub_profit <= 0 AND v_parent_profit <= 0 AND v_grand_profit <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Nothing to credit on this order');
  END IF;

  -- ── Seller leg ──────────────────────────────────────────────────────────
  -- An order settled before the reference scheme existed was credited by
  -- credit_shop_profit(), which writes no `reference`. Reference-keyed
  -- idempotency cannot see those rows, so check for one explicitly: without
  -- this, re-processing such an order would pay the seller a second time.
  SELECT id INTO v_legacy_sub_tx
  FROM public.shop_wallet_transactions
  WHERE shop_order_id = _shop_order_id
    AND type = 'profit'
    AND reference IS NULL
  LIMIT 1;

  IF v_legacy_sub_tx IS NULL THEN
    v_sub_credited := public.credit_shop_order_leg(
      _shop_order_id, v_owner_id, v_sub_profit,
      'Sub storefront sale', 'SUBPROFIT-' || _shop_order_id::text
    );
  END IF;

  -- ── Direct upline leg ───────────────────────────────────────────────────
  v_parent_credited := public.credit_shop_order_leg(
    _shop_order_id, v_upline_owner_id, v_parent_profit,
    'Sub network commission', 'LEADPROFIT-' || _shop_order_id::text
  );

  -- ── Root Lead leg (only when the seller is a level-2 sub) ────────────────
  v_grand_credited := public.credit_shop_order_leg(
    _shop_order_id, v_grand_owner_id, v_grand_profit,
    'Downline network commission', 'GRANDPROFIT-' || _shop_order_id::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'sub_credited', v_sub_credited,
    'parent_credited', v_parent_credited,
    'grandparent_credited', v_grand_credited,
    'message', CASE
      WHEN v_sub_credited OR v_parent_credited OR v_grand_credited
        THEN 'Credited sub: ' || v_sub_profit
          || ', lead: ' || v_parent_profit
          || ', root: ' || v_grand_profit
      ELSE 'Already credited'
    END
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_shop_order_profits(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.credit_shop_order_profits(UUID) TO authenticated, service_role;
