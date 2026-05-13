-- Wipe all per-chain data for one chain and drop its metadata/checkpoint table.
--
-- 1. Stop the indexer process/container for the target project before running.
-- 2. Run scripts/wipe-chain-preview.sql first to confirm row counts.
-- 3. Set v_target_chain below to the same value used in the preview.
--
-- Idempotent: a re-run after a successful wipe is a clean no-op (metadata table
-- is already gone, so the block exits with a notice instead of raising).
--
-- Per-table deleted-row counts are printed via RAISE NOTICE, mirroring the
-- preview output so the two can be diffed visually.

BEGIN;

DO $$
DECLARE
  -- >>> Set the target chain (must match `_metadata_*.chain` exactly) <<<
  v_target_chain CONSTANT text := 'Kusama';

  r record;
  v_chain_name text;
  v_chain_id text;
  v_meta_table text;
  v_rows bigint;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name LIKE '\_metadata\_%' ESCAPE '\'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''chain'' LIMIT 1',
      r.table_name
    ) INTO v_chain_name;

    IF v_chain_name = v_target_chain THEN
      v_meta_table := r.table_name;
      EXECUTE format(
        'SELECT value #>> ''{}'' FROM app.%I WHERE key = ''genesisHash'' LIMIT 1',
        r.table_name
      ) INTO v_chain_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_meta_table IS NULL OR v_chain_id IS NULL THEN
    -- Idempotent path: nothing to wipe (already done, or chain was never indexed)
    RAISE NOTICE 'No metadata table for chain=% — nothing to wipe (already clean).', v_target_chain;
    RETURN;
  END IF;

  RAISE NOTICE 'target=%  metadata_table=%  chain_id=%', v_target_chain, v_meta_table, v_chain_id;

  -- Delete chain-scoped data (report per-table row counts)
  EXECUTE format(
    'DELETE FROM app.multisig_events me
     USING app.multisig_operations mo
     WHERE me.multisig_id = mo.id
       AND mo.chain_id = %L',
    v_chain_id
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'multisig_events deleted: %', v_rows;

  EXECUTE format('DELETE FROM app.multisig_operations WHERE chain_id = %L', v_chain_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'multisig_operations deleted: %', v_rows;

  EXECUTE format('DELETE FROM app.proxieds WHERE chain_id = %L', v_chain_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'proxieds deleted: %', v_rows;

  EXECUTE format('DELETE FROM app.pure_proxies WHERE chain_id = %L', v_chain_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'pure_proxies deleted: %', v_rows;

  -- Drop metadata table for this network (full checkpoint reset).
  -- IF EXISTS keeps the script safe under unexpected concurrent drops.
  EXECUTE format('DROP TABLE IF EXISTS app.%I', v_meta_table);
  RAISE NOTICE 'metadata table dropped: %', v_meta_table;
END $$;

COMMIT;
