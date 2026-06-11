-- Shank v0.7.0 — player profiles (photo, bio, motto, favorite club, home course)
-- Run this ONCE in the Supabase dashboard: SQL Editor → New query → paste → Run.

-- 1. Profile fields on players
alter table players
  add column if not exists bio text,
  add column if not exists fav_club text,
  add column if not exists home_course text,
  add column if not exists motto text,
  add column if not exists avatar_url text;

-- 2. Public storage bucket for profile photos
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- 3. Photo rules: anyone can view; each account can only touch its own
--    photo (the file is named <account-id>.jpg)
drop policy if exists "avatar public read" on storage.objects;
drop policy if exists "avatar upload own" on storage.objects;
drop policy if exists "avatar update own" on storage.objects;
drop policy if exists "avatar delete own" on storage.objects;

create policy "avatar public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatar upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
create policy "avatar update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
create policy "avatar delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
