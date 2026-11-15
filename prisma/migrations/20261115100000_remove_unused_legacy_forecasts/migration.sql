BEGIN;

DO $$
DECLARE
  has_rows boolean;
BEGIN
  IF to_regclass('public.forecast_results') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.forecast_results IN ACCESS EXCLUSIVE MODE';
  END IF;
  IF to_regclass('public.forecast_runs') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.forecast_runs IN ACCESS EXCLUSIVE MODE';
  END IF;
  IF to_regclass('public.forecast_results') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.forecast_results)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'forecast_results contains data; review it before removing legacy forecast tables';
    END IF;
  END IF;
  IF to_regclass('public.forecast_runs') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.forecast_runs)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'forecast_runs contains data; review it before removing legacy forecast tables';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.forecast_results;
DROP TABLE IF EXISTS public.forecast_runs;

COMMIT;
