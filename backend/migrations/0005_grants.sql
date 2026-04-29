-- Migration 0005: Standard Supabase role grants
-- Ensures service_role, anon, and authenticated can interact with public tables
-- Idempotent — safe to apply on any project state

grant usage on schema public to postgres, anon, authenticated, service_role;

grant all on all tables in schema public to postgres, service_role;
grant select on all tables in schema public to anon, authenticated;

grant all on all sequences in schema public to postgres, service_role;
grant usage, select on all sequences in schema public to anon, authenticated;

grant all on all functions in schema public to postgres, service_role;
grant execute on all functions in schema public to anon, authenticated;

alter default privileges in schema public grant all on tables to postgres, service_role;
alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to postgres, service_role;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to postgres, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;