-- OPTIONAL: close and score expired attempts every minute, even if the
-- student never comes back. Not required for correctness — the server
-- enforces deadlines on every save, and expired attempts are finalised
-- whenever a student or admin views them.
-- On Neon, scheduled jobs only run while the compute is awake, and keeping
-- it awake uses more of the free monthly compute allowance — so this is off
-- by default. If you want it, enable pg_cron for the project, then run:
create extension if not exists pg_cron;
select cron.schedule('finalize-expired-attempts', '* * * * *', $$ select public.finalize_expired_attempts(); $$);
-- To remove: select cron.unschedule('finalize-expired-attempts');
