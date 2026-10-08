-- Usuário somente leitura para o MCP detro-db. Rode UMA vez no banco de DEV:
--   docker exec -i udp-postgres psql -U tracker -d tracker -v ON_ERROR_STOP=1 \
--     < db-readonly/create-readonly-role.sql
-- Rode com o usuário dono das tabelas (tracker, o mesmo da API), para que o
-- ALTER DEFAULT PRIVILEGES valha também para tabelas criadas depois.
-- NÃO é um arquivo de db/init. Pode rodar de novo sem problema.

DO $$
DECLARE s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'detro_readonly') THEN
    CREATE ROLE detro_readonly LOGIN PASSWORD 'detro_readonly';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO detro_readonly', current_database());

  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO detro_readonly', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO detro_readonly', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO detro_readonly', s);
  END LOOP;
END $$;

ALTER ROLE detro_readonly SET default_transaction_read_only = on;
ALTER ROLE detro_readonly SET statement_timeout = '10s';
