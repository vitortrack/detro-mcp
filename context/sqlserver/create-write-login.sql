-- Login de escrita para a ferramenta executar do MCP detro-sqlserver. Rode UMA vez
-- no banco de DEV (passo a passo no README da raiz). NÃO use aspas simples na senha.
-- Lê, grava e cria/altera tabelas no banco, sem ser dono nem sysadmin.
-- Pode rodar de novo sem problema.

DECLARE @u sysname = N'$(usuario)', @s nvarchar(128) = N'$(senha)', @cmd nvarchar(max);

IF @u = SUSER_SNAME() OR IS_SRVROLEMEMBER('sysadmin', @u) = 1
  THROW 50000, N'usuario é o login em uso ou sysadmin. Escolha um nome novo, só para o MCP (ex.: mcp_escrita).', 1;

IF SUSER_ID(@u) IS NULL
BEGIN
  SET @cmd = N'CREATE LOGIN ' + QUOTENAME(@u) + N' WITH PASSWORD = ' + QUOTENAME(@s, '''');
  EXEC (@cmd);
END;

IF USER_ID(@u) IS NULL
BEGIN
  SET @cmd = N'CREATE USER ' + QUOTENAME(@u) + N' FOR LOGIN ' + QUOTENAME(@u);
  EXEC (@cmd);
END;

SET @cmd = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@u)
         + N'; ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@u)
         + N'; ALTER ROLE db_ddladmin ADD MEMBER ' + QUOTENAME(@u);
EXEC (@cmd);
