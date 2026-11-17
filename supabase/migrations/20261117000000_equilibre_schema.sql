-- Schéma de l'application Équilibre : profil, journal alimentaire, suivi du poids.
-- Chaque utilisateur ne voit et ne modifie que ses propres lignes (RLS).

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  sex text check (sex in ('femme', 'homme')),
  age int check (age between 10 and 120),
  height_cm numeric(5,1) check (height_cm between 80 and 250),
  goal_weight numeric(5,1),
  activity text not null default 'leger' check (activity in ('sedentaire', 'leger', 'modere', 'actif')),
  goal text not null default 'perdre' check (goal in ('perdre', 'maintenir')),
  updated_at timestamptz not null default now()
);

create table if not exists public.food_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  eaten_on date not null,
  meal text not null check (meal in ('petit-dejeuner', 'dejeuner', 'diner', 'collation')),
  name text not null,
  grams numeric(7,1) not null check (grams > 0),
  kcal numeric(7,1) not null default 0,
  protein numeric(6,1) not null default 0,
  sat_fat numeric(6,1) not null default 0,
  sugar numeric(6,1) not null default 0,
  fiber numeric(6,1) not null default 0,
  points int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists food_entries_user_day_idx on public.food_entries (user_id, eaten_on);

create table if not exists public.weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  measured_on date not null,
  kg numeric(5,1) not null check (kg between 20 and 400),
  unique (user_id, measured_on)
);

alter table public.profiles enable row level security;
alter table public.food_entries enable row level security;
alter table public.weights enable row level security;

-- profiles : la clé primaire est l'id de l'utilisateur
create policy "profil: lecture" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profil: création" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "profil: modification" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- food_entries
create policy "journal: lecture" on public.food_entries for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "journal: ajout" on public.food_entries for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "journal: suppression" on public.food_entries for delete to authenticated
  using ((select auth.uid()) = user_id);

-- weights
create policy "poids: lecture" on public.weights for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "poids: ajout" on public.weights for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "poids: modification" on public.weights for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "poids: suppression" on public.weights for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.food_entries to authenticated;
grant select, insert, update, delete on public.weights to authenticated;
