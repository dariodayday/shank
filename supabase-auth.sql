-- Shank v0.5.0 — accounts & ownership
-- Run this ONCE in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- What it does:
--   1. Links each player to a signed-up account (one player per account).
--   2. Replaces the wide-open access rules with:
--        - anyone can READ the board (no account needed)
--        - signed-in users can only create/edit/delete THEIR OWN player & rounds

-- 1. Ownership column
alter table players add column if not exists user_id uuid references auth.users(id);
create unique index if not exists players_user_id_key on players(user_id);

-- 2. Drop every existing policy on players/rounds (the old open ones)
do $$
declare pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('players', 'rounds')
  loop
    execute format('drop policy %I on %I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- 3. Anyone with the link can view the board
create policy "public read players" on players for select using (true);
create policy "public read rounds"  on rounds  for select using (true);

-- 4. Signed-in users manage only their own player...
create policy "insert own player" on players for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own player" on players for update to authenticated
  using (user_id = auth.uid());
create policy "delete own player" on players for delete to authenticated
  using (user_id = auth.uid());

-- 5. ...and only their own rounds
create policy "insert own rounds" on rounds for insert to authenticated
  with check (exists (
    select 1 from players p where p.id = rounds.player_id and p.user_id = auth.uid()));
create policy "delete own rounds" on rounds for delete to authenticated
  using (exists (
    select 1 from players p where p.id = rounds.player_id and p.user_id = auth.uid()));

-- Optional: wipe any old test data so everyone starts fresh with accounts.
-- Uncomment the next two lines if you want a clean slate:
-- delete from rounds;
-- delete from players;
