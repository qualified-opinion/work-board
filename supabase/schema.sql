-- Work Board database for Supabase.
-- Run once in your Supabase project: SQL Editor > New query > paste this file > Run.
--
-- Every record on the board (client, recurring job, task, note, timesheet day, setting) is one
-- row here, keyed by its path such as 'tasks/abc'. Row-level security means a signed-in person
-- can only ever read or change their own rows.

create table if not exists public.docs (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,
  coll       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (owner, path)
);

create index if not exists docs_owner_coll on public.docs (owner, coll);

alter table public.docs enable row level security;

drop policy if exists "Own rows only" on public.docs;
create policy "Own rows only" on public.docs
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- Live updates, so a change on your phone shows on your computer straight away.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;
