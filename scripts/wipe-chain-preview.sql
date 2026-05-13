-- Preview wipe impact for one chain. Counts rows that would be removed.
-- No data is modified: the transaction ends with ROLLBACK.
--
-- 1. Set v_target_chain below to the exact `chain` string from app._metadata_*.chain
--    (run scripts/list-indexed-chains.sql first to see available values).
-- 2. Run this script and read row counts from NOTICE output.

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
    RAISE EXCEPTION 'Metadata table not found for chain=%', v_target_chain;
  END IF;

  RAISE NOTICE 'target=%  metadata_table=%  chain_id=%', v_target_chain, v_meta_table, v_chain_id;

  EXECUTE format('SELECT count(*) FROM app.multisig_operations WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'multisig_operations rows to delete: %', v_rows;

  EXECUTE format(
    'SELECT count(*) FROM app.multisig_events me
     JOIN app.multisig_operations mo ON mo.id = me.multisig_id
     WHERE mo.chain_id = %L',
    v_chain_id
  ) INTO v_rows;
  RAISE NOTICE 'multisig_events rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.proxieds WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'proxieds rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.pure_proxies WHERE chain_id = %L', v_chain_id) INTO v_rows;
  RAISE NOTICE 'pure_proxies rows to delete: %', v_rows;

  EXECUTE format('SELECT count(*) FROM app.%I', v_meta_table) INTO v_rows;
  RAISE NOTICE 'metadata rows in table to drop (%): %', v_meta_table, v_rows;
END $$;

ROLLBACK;
