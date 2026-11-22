-- Ajouts : modification des aliments du journal, eau, activités physiques.

-- Permettre de modifier une entrée du journal (portion, repas)
create policy "journal: modification" on public.food_entries for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant update on public.food_entries to authenticated;

-- Suivi quotidien (verres d'eau)
create table if not exists public.day_logs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  water int not null default 0 check (water between 0 and 40),
  primary key (user_id, day)
);
alter table public.day_logs enable row level security;
create policy "jour: lecture" on public.day_logs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "jour: ajout" on public.day_logs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "jour: modification" on public.day_logs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update on public.day_logs to authenticated;

-- Activités physiques (rapportent des points bonus)
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  done_on date not null,
  name text not null,
  minutes int not null check (minutes between 1 and 600),
  kcal numeric(7,1) not null default 0,
  points int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists activities_user_day_idx on public.activities (user_id, done_on);
alter table public.activities enable row level security;
create policy "activité: lecture" on public.activities for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "activité: ajout" on public.activities for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "activité: suppression" on public.activities for delete to authenticated
  using ((select auth.uid()) = user_id);
grant select, insert, delete on public.activities to authenticated;
