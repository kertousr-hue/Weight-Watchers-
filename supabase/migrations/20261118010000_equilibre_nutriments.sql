-- Base de nutriments + calcul des points dans la base de données.

-- Formule des points (identique à public/points.js)
create or replace function public.compute_points(
  kcal numeric, sat_fat numeric, sugar numeric, protein numeric, fiber numeric, is_free boolean default false
) returns int
language sql immutable parallel safe
set search_path = ''
as $$
  select case when coalesce(is_free, false) then 0
    else greatest(0, round(
      coalesce(kcal, 0) / 30 + coalesce(sat_fat, 0) / 3 + coalesce(sugar, 0) / 8
      - coalesce(protein, 0) / 9 - coalesce(fiber, 0) / 10))::int
  end
$$;

-- Catalogue d'aliments : owner null = catalogue commun, sinon aliment personnel
create table if not exists public.foods (
  id bigint generated always as identity primary key,
  owner uuid default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  category text,
  barcode text,
  portion_g numeric(7,1) not null default 100 check (portion_g > 0),
  kcal numeric(7,1) not null default 0 check (kcal >= 0),
  protein numeric(6,1) not null default 0 check (protein >= 0),
  fat numeric(6,1) not null default 0 check (fat >= 0),
  sat_fat numeric(6,1) not null default 0 check (sat_fat >= 0),
  carbs numeric(6,1) not null default 0 check (carbs >= 0),
  sugar numeric(6,1) not null default 0 check (sugar >= 0),
  fiber numeric(6,1) not null default 0 check (fiber >= 0),
  salt numeric(6,2) not null default 0 check (salt >= 0),
  is_free boolean not null default false,
  points_100g int generated always as (public.compute_points(kcal, sat_fat, sugar, protein, fiber, is_free)) stored,
  points_portion int generated always as (
    public.compute_points(kcal * portion_g / 100, sat_fat * portion_g / 100, sugar * portion_g / 100,
                          protein * portion_g / 100, fiber * portion_g / 100, is_free)) stored,
  created_at timestamptz not null default now(),
  unique nulls not distinct (owner, name)
);
create index if not exists foods_owner_idx on public.foods (owner);
create index if not exists foods_barcode_idx on public.foods (barcode) where barcode is not null;

alter table public.foods enable row level security;
create policy "aliments: lecture" on public.foods for select to anon, authenticated
  using (owner is null or owner = (select auth.uid()));
create policy "aliments: ajout" on public.foods for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "aliments: modification" on public.foods for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "aliments: suppression" on public.foods for delete to authenticated
  using (owner = (select auth.uid()));
grant select on public.foods to anon, authenticated;
grant insert, update, delete on public.foods to authenticated;

-- Journal : les points sont recalculés par la base à partir des nutriments
alter table public.food_entries add column if not exists is_free boolean not null default false;

create or replace function public.food_entries_set_points() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.points := public.compute_points(new.kcal, new.sat_fat, new.sugar, new.protein, new.fiber, new.is_free);
  return new;
end
$$;
revoke execute on function public.food_entries_set_points() from public, anon, authenticated;

drop trigger if exists food_entries_points on public.food_entries;
create trigger food_entries_points before insert or update on public.food_entries
  for each row execute function public.food_entries_set_points();
