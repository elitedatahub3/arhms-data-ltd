-- When a dealer plan ends, the user goes back to what they were before:
-- a customer, or an agent with the agent time they had left (paused while
-- they were a dealer). These columns hold that snapshot, written when the
-- user becomes a dealer and cleared when they are restored.
--
-- No backfill: dealers from before this change have no snapshot and fall back
-- to customer, which is what already happened to them.
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS pre_dealer_role text,                  -- 'customer' | 'agent'
    ADD COLUMN IF NOT EXISTS pre_dealer_agent_seconds_left bigint;  -- NULL with 'agent' = lifetime agent
