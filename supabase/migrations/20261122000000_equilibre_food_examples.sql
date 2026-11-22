-- Photos « apprises » : empreinte numérique d'une photo (calculée dans le téléphone)
-- associée à l'aliment choisi par l'utilisateur. Aucune image n'est stockée.
create table if not exists public.food_examples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  food jsonb not null,
  embedding real[] not null check (array_length(embedding, 1) between 64 and 2048),
  created_at timestamptz not null default now()
);
create index if not exists food_examples_user_idx on public.food_examples (user_id, created_at desc);
alter table public.food_examples enable row level security;
create policy "exemples: lecture" on public.food_examples for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "exemples: ajout" on public.food_examples for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "exemples: suppression" on public.food_examples for delete to authenticated
  using ((select auth.uid()) = user_id);
grant select, insert, delete on public.food_examples to authenticated;
