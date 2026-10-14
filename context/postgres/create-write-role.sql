-- Usuário de escrita para a ferramenta executar do MCP detro-db. Rode UMA vez no banco de DEV:
--   docker exec -i <container_postgres> psql -U <dono_das_tabelas> -d <banco> \
--     -v usuario=<usuario_escrita> -v senha=<senha_escrita> -v ON_ERROR_STOP=1 \
--     < context/postgres/create-write-role.sql
-- Rode com o usuário dono das tabelas (o mesmo da API): o usuário novo passa a
-- agir como ele, e o que criar fica com o mesmo dono das tabelas da API.
-- NÃO é um arquivo de db/init. Pode rodar de novo sem problema.

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'usuario', :'senha')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usuario') \gexec

SELECT set_config('mcp.usuario', :'usuario', false);

DO $$
DECLARE
  r text := current_setting('mcp.usuario');
BEGIN
  IF r = current_user OR (SELECT rolsuper FROM pg_roles WHERE rolname = r) THEN
    RAISE EXCEPTION 'usuario=% é o dono das tabelas ou superusuário. Escolha um nome novo, só para o MCP (ex.: mcp_escrita).', r;
  END IF;

  EXECUTE format('GRANT %I TO %I', current_user, r);
  EXECUTE format('ALTER ROLE %I SET role = %I', r, current_user);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '10s');
END $$;
