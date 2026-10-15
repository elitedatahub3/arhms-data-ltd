-- ════════════════════════════════════════════════════════════════════════════
-- Shop owners price freely above cost
--
-- Profit on a shop's data package used to be capped at GHS 10 (agents) / GHS 5
-- (everyone else). The cap is gone; the only rule is profit > 0 so nobody sells
-- below cost. GHS 1,000 stays as a typo guard, matching MAX_SHOP_PROFIT_GHS in
-- lib/shop-price-limits.ts — change both together.
--
-- Two places enforced the old 10:
--   1. check_profit_margin_range on shop_pricing — rejected the row outright.
--   2. auto_update_shop_pricing_on_platform_cost() — clamped margin to 10 when
--      re-pricing after an admin cost change, so a shop at cost + 25 would be
--      silently cut to cost + 10 the first time a package price moved.
--
-- The function below is 20260825_sub_aware_price_cascade.sql verbatim except:
--   * the clamp is 1000, not 10;
--   * Stage 1 prices dealer-owned shops off dealer_price. It only knew
--     agent_price, so a dealer at cost + 2 was re-priced to CUSTOMER price + 2 —
--     overcharging their buyers and banking them profit they never set. Same
--     ladder as ownerCostPrice() in lib/shop-price-limits.ts;
--   * SET search_path = public: 20260422_security_hardening pinned it, and the
--     20260825 CREATE OR REPLACE dropped the pin.
--
-- Run BEFORE deploying the matching code.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.shop_pricing DROP CONSTRAINT IF EXISTS check_profit_margin_range;
ALTER TABLE public.shop_pricing ADD CONSTRAINT check_profit_margin_range
    CHECK (profit_margin > 0 AND profit_margin <= 1000);

CREATE OR REPLACE FUNCTION auto_update_shop_pricing_on_platform_cost()
RETURNS TRIGGER AS $$
DECLARE
  v_min_margin NUMERIC;
  v_depth      SMALLINT;
BEGIN
    -- Zero Price Guard
    IF NEW.price <= 0 OR (NEW.agent_price IS NOT NULL AND NEW.agent_price <= 0) THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

    -- Trigger Guard (Loops, No Operation)
    IF NEW.price IS NOT DISTINCT FROM OLD.price
       AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price
       AND NEW.dealer_price IS NOT DISTINCT FROM OLD.dealer_price THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE((value #>> '{}')::NUMERIC, 0.50) INTO v_min_margin
    FROM public.shop_global_settings WHERE key = 'sub_min_margin';
    v_min_margin := COALESCE(v_min_margin, 0.50);

    -- Safe execution block guaranteeing flag reset
    BEGIN
        -- System Isolation bypass flag
        PERFORM set_config('app.system_pricing_update', 'true', true);

        -- ── Stage 1: shops priced against the platform ────────────────────
        -- Unchanged behaviour, but now scoped to owners with no membership row.
        WITH updated_pricing AS (
            SELECT
                sp.id,
                sp.shop_id,
                sp.package_id,
                CASE
                    WHEN u.role = 'dealer' AND OLD.dealer_price > 0 THEN OLD.dealer_price
                    WHEN u.role = 'agent' AND OLD.agent_price IS NOT NULL THEN OLD.agent_price
                    ELSE OLD.price
                END AS old_cost,
                sp.selling_price AS old_selling,
                CASE
                    WHEN u.role = 'dealer' AND NEW.dealer_price > 0 THEN NEW.dealer_price
                    WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                    ELSE NEW.price
                END AS new_cost,
                (
                    CASE
                        WHEN u.role = 'dealer' AND NEW.dealer_price > 0 THEN NEW.dealer_price
                        WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                        ELSE NEW.price
                    END
                ) + (
                    CASE
                        WHEN sp.profit_margin <= 0 THEN 1
                        WHEN sp.profit_margin > 1000 THEN 1000
                        ELSE sp.profit_margin
                    END
                ) AS new_selling
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
              AND NOT EXISTS (
                    SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id
                  )
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET
                selling_price = up.new_selling,
                last_auto_updated_at = NOW()
            FROM updated_pricing up
            WHERE sp.id = up.id
            RETURNING up.*
        )
        INSERT INTO public.shop_pricing_logs (
            shop_id, package_id, old_cost_price, new_cost_price,
            old_selling_price, new_selling_price, changed_at
        )
        SELECT
            shop_id, package_id, old_cost, new_cost,
            old_selling, new_selling, NOW()
        FROM applied_update;

        -- ── Stage 2: downline shops, shallowest first ─────────────────────
        -- A downline's price follows its PARENT, not the platform.
        --
        -- profit_margin already holds exactly what is needed: for a sub it is
        -- written as (their price − their parent's price) by
        -- /api/dashboard/sub/pricing, and seeded at SUB_START_MARGIN when the
        -- storefront is created. So re-applying it to the parent's NEW price
        -- reproduces the markup this level actually chose, with no need to
        -- reconstruct what the parent used to charge.
        --
        -- Then floor at the parent's wholesale + the platform minimum, so a row
        -- can never land underwater even if the margin on file was stale.
        --
        -- Depth order matters: level 2 reads level 1's row only after the
        -- v_depth = 1 pass has already corrected it.
        FOR v_depth IN 1..2 LOOP
            WITH resolved AS (
                SELECT
                    sp.id,
                    sp.shop_id,
                    sp.package_id,
                    sp.selling_price AS old_selling,
                    COALESCE(parent_sp.sub_price, parent_sp.selling_price) AS parent_wholesale,
                    GREATEST(
                        parent_sp.selling_price + (
                            CASE
                                WHEN sp.profit_margin <= 0 THEN v_min_margin
                                WHEN sp.profit_margin > 1000 THEN 1000
                                ELSE sp.profit_margin
                            END
                        ),
                        COALESCE(parent_sp.sub_price, parent_sp.selling_price) + v_min_margin
                    ) AS new_selling
                FROM public.shop_pricing sp
                JOIN public.shop_profiles spf ON sp.shop_id = spf.id
                JOIN public.sub_agents sa ON sa.user_id = spf.owner_id
                JOIN public.shop_pricing parent_sp
                  ON parent_sp.shop_id = sa.upline_shop_id
                 AND parent_sp.package_id = sp.package_id
                WHERE sp.package_id = NEW.id
                  AND sa.depth = v_depth
            ),
            applied AS (
                UPDATE public.shop_pricing sp
                SET selling_price = r.new_selling,
                    last_auto_updated_at = NOW()
                FROM resolved r
                WHERE sp.id = r.id
                  AND sp.selling_price IS DISTINCT FROM r.new_selling
                RETURNING r.*
            )
            INSERT INTO public.shop_pricing_logs (
                shop_id, package_id, old_cost_price, new_cost_price,
                old_selling_price, new_selling_price, changed_at
            )
            SELECT shop_id, package_id, NULL, parent_wholesale, old_selling, new_selling, NOW()
            FROM applied;
        END LOOP;

        PERFORM set_config('app.system_pricing_update', 'false', true);
        RETURN NEW;
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM set_config('app.system_pricing_update', 'false', true);
            RAISE;
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Dealer shops re-price off dealer_price, so a dealer_price change has to fire
-- the cascade too — before this, raising it could leave a dealer's shelf price
-- at or under their new cost, and those orders fail only after payment.
DROP TRIGGER IF EXISTS trg_auto_update_shop_pricing ON public.data_packages;
CREATE TRIGGER trg_auto_update_shop_pricing
AFTER UPDATE OF price, agent_price, dealer_price ON public.data_packages
FOR EACH ROW
EXECUTE FUNCTION auto_update_shop_pricing_on_platform_cost();
