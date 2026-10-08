-- Usuário somente leitura para o MCP detro-db. Rode UMA vez no banco de DEV:
--   docker exec -i <container_postgres> psql -U <dono_das_tabelas> -d <banco> \
--     -v usuario=<usuario_readonly> -v senha=<senha_readonly> -v ON_ERROR_STOP=1 \
--     < context/postgres/create-readonly-role.sql
-- Rode com o usuário dono das tabelas (o mesmo da API), para que o
-- ALTER DEFAULT PRIVILEGES valha também para tabelas criadas depois.
-- NÃO é um arquivo de db/init. Pode rodar de novo sem problema.

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'usuario', :'senha')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usuario') \gexec

SELECT set_config('mcp.usuario', :'usuario', false);

DO $$
DECLARE
  s text;
  r text := current_setting('mcp.usuario');
BEGIN
  IF r = current_user OR (SELECT rolsuper FROM pg_roles WHERE rolname = r) THEN
    RAISE EXCEPTION 'usuario=% é o dono das tabelas ou superusuário. Escolha um nome novo, só para o MCP (ex.: mcp_readonly).', r;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);

  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, r);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s, r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO %I', s, r);
  END LOOP;

  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', r);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '10s');
END $$;
