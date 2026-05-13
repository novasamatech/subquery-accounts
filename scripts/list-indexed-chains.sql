-- List all chains currently indexed in the DB.
-- For each `app._metadata_*` table, prints the stored `chain` and `genesisHash`.
-- Use the output to find the exact `chain` string to pass to wipe-chain-preview.sql / wipe-chain.sql.

DO $$
DECLARE
  r record;
  v_chain text;
  v_genesis text;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name LIKE '\_metadata\_%' ESCAPE '\'
    ORDER BY table_name
  LOOP
    EXECUTE format('SELECT value #>> ''{}'' FROM app.%I WHERE key = ''chain''       LIMIT 1', r.table_name) INTO v_chain;
    EXECUTE format('SELECT value #>> ''{}'' FROM app.%I WHERE key = ''genesisHash'' LIMIT 1', r.table_name) INTO v_genesis;
    RAISE NOTICE 'metadata=%  chain=%  genesisHash=%', r.table_name, v_chain, v_genesis;
  END LOOP;
END $$;
