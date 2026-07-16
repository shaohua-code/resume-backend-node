-- Add immutable official price baselines for non-compounding rate adjustment.
-- Existing current prices become the initial baselines. For a full official-price
-- reset, execute upsert_bailian_ai_models.sql instead.

BEGIN;

ALTER TABLE public.ai_model
  ADD COLUMN IF NOT EXISTS official_input_price_per_million NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS official_cached_input_price_per_million NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS official_output_price_per_million NUMERIC(10, 4);

UPDATE public.ai_model
SET
  official_input_price_per_million = COALESCE(official_input_price_per_million, input_price_per_million, 0),
  official_cached_input_price_per_million = COALESCE(official_cached_input_price_per_million, cached_input_price_per_million, 0),
  official_output_price_per_million = COALESCE(official_output_price_per_million, output_price_per_million, 0);

ALTER TABLE public.ai_model
  ALTER COLUMN official_input_price_per_million SET DEFAULT 0,
  ALTER COLUMN official_cached_input_price_per_million SET DEFAULT 0,
  ALTER COLUMN official_output_price_per_million SET DEFAULT 0;

COMMIT;
