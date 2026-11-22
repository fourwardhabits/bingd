-- Rollback for 20261130001200_a_recommendation_you_can_put_away (recipient dismissal of
-- "Sent to You" recommendations). One transaction.
--
-- Order: the two writers go first so nothing can write the column while the policy is being
-- put back; then the recipient policy returns to exactly its 20260826000400 form (delivered
-- rows only), which makes every dismissed recommendation visible again on every client;
-- then the column and the migration record.
--
-- Dropping the column discards which recommendations were dismissed. If a re-apply is
-- expected soon and the dismissals should survive it, skip the `drop column` line: with the
-- policy restored the column is inert (granted to nobody, read by nothing).
--
-- `processed_operations` rows of kinds 'dismiss_received_recommendation' and
-- 'restore_received_recommendation' are left in place; they are inert ledger entries.
begin;

drop function if exists public.restore_received_recommendation(uuid, uuid);
drop function if exists public.dismiss_received_recommendation(uuid, uuid);

alter policy title_recommendations_recipient on public.title_recommendations
  using (recipient_id = auth.uid() and state = 'delivered');
comment on policy title_recommendations_recipient on public.title_recommendations is null;

alter table public.title_recommendations drop column if exists dismissed_at;

delete from supabase_migrations.schema_migrations where version = '20261130001200';

commit;
