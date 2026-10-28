-- Applied after every migration run (idempotent). Production uses three database roles
-- (deploy/cloud/postgres/init-roles.sh creates them):
--   voltax_owner        owns the schema, runs migrations (cli migrate). Never used by the app.
--   voltax_app          the running cloud: no UPDATE/DELETE/TRUNCATE on any audit table, cannot
--                       ALTER tables or disable triggers (not the owner).
--   voltax_audit_reader read-only access to the audit tables for external verification.
-- In unit tests (PGlite) the roles do not exist and nothing happens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltax_app') THEN
    GRANT USAGE ON SCHEMA public TO voltax_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voltax_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, hub_audit, audit_checkpoints FROM voltax_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM voltax_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO voltax_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltax_audit_reader') THEN
    GRANT USAGE ON SCHEMA public TO voltax_audit_reader;
    GRANT SELECT ON audit_log, hub_audit, audit_checkpoints TO voltax_audit_reader;
  END IF;
END
$$;
