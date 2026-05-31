-- ============================================================================
-- DMS Atelier BTS MV — Lycée Gallieni
-- Schéma Supabase : à exécuter dans le SQL Editor du projet (une seule fois).
-- ============================================================================
-- Modèle : seul le STAFF (admin/enseignant) a un compte (auth.users + profiles).
-- Les ÉLÈVES sont de simples fiches (table students), sans compte.
-- ----------------------------------------------------------------------------

-- 1. TABLES -----------------------------------------------------------------

-- Profils du staff, liés 1-1 à auth.users
create table if not exists profiles (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null,
  role       text not null default 'enseignant' check (role in ('admin','enseignant')),
  created_at timestamptz default now()
);

-- Élèves : fiches affectables aux ordres (aucun compte)
create table if not exists students (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  grp        text default '',          -- groupe / classe (ex. G1-MV)
  archived   boolean default false,
  created_at timestamptz default now()
);

-- Ordres de réparation
create table if not exists orders (
  id                uuid primary key default gen_random_uuid(),
  order_num         text unique,                       -- généré par trigger (OR-AAAA-XXXX)
  file_ref          text default '',
  plate             text not null,
  brand             text not null,
  model             text not null,
  year              text default '',
  km                text default '',
  vtype             text not null check (vtype in ('client','peda')),
  client_name       text default '',
  client_phone      text default '',
  teacher           text default '',
  assigned_students jsonb default '[]'::jsonb,          -- ["Jean Martin", ...]
  reason            text default '',
  entry_date        date,
  entry_time        text default '',
  exit_date         date,
  exit_time         text default '',
  exit_condition    text default '',
  status            text not null default 'en_attente'
                    check (status in ('en_attente','en_cours','termine')),
  tasks             jsonb default '[]'::jsonb,          -- [{id,label,done,doneBy,doneAt}]
  observations      text default '',
  additional_sales  text default '',
  signature         text default '',                    -- dataURL PNG du canvas
  created_by        text default '',
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- 2. NUMÉROTATION OR-AAAA-XXXX (atomique, anti-collision multi-postes) -------

create table if not exists order_counters (
  year int primary key,
  last int not null default 0
);

create or replace function set_order_num() returns trigger as $$
declare
  y int := extract(year from now())::int;
  n int;
begin
  if new.order_num is null then
    insert into order_counters(year, last) values (y, 1)
      on conflict (year) do update set last = order_counters.last + 1
      returning last into n;
    new.order_num := 'OR-' || y || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_order_num on orders;
create trigger trg_order_num before insert on orders
  for each row execute function set_order_num();

-- updated_at auto
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_orders_touch on orders;
create trigger trg_orders_touch before update on orders
  for each row execute function touch_updated_at();

-- 3. AUTH : profil créé automatiquement à l'inscription d'un compte -----------

-- IMPORTANT : `set search_path = ''` est indispensable. Sans lui, le système
-- d'auth Supabase exécute ce trigger avec un search_path restreint et `profiles`
-- est introuvable → « Database error creating new user ». On qualifie donc les
-- tables avec le schéma `public.`.
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'enseignant')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_new_user on auth.users;
create trigger trg_new_user after insert on auth.users
  for each row execute function handle_new_user();

-- helper : l'utilisateur courant est-il admin ?
create or replace function is_admin() returns boolean
  language sql security definer stable set search_path = ''
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 4. RLS ---------------------------------------------------------------------

alter table profiles enable row level security;
alter table students enable row level security;
alter table orders   enable row level security;

-- lecture : tout utilisateur connecté (= staff)
drop policy if exists read_profiles on profiles;
drop policy if exists read_students on students;
drop policy if exists read_orders   on orders;
create policy read_profiles on profiles for select using (auth.role() = 'authenticated');
create policy read_students on students for select using (auth.role() = 'authenticated');
create policy read_orders   on orders   for select using (auth.role() = 'authenticated');

-- création / modification : staff
drop policy if exists ins_students on students;
drop policy if exists upd_students on students;
drop policy if exists ins_orders   on orders;
drop policy if exists upd_orders   on orders;
create policy ins_students on students for insert with check (auth.role() = 'authenticated');
create policy upd_students on students for update using (auth.role() = 'authenticated');
create policy ins_orders   on orders   for insert with check (auth.role() = 'authenticated');
create policy upd_orders   on orders   for update using (auth.role() = 'authenticated');

-- suppression + gestion des rôles : admin uniquement
drop policy if exists del_students on students;
drop policy if exists del_orders   on orders;
drop policy if exists upd_profiles on profiles;
create policy del_students on students for delete using (is_admin());
create policy del_orders   on orders   for delete using (is_admin());
create policy upd_profiles on profiles for update using (is_admin() or id = auth.uid());

-- 5. REALTIME : diffuser les changements aux postes connectés ----------------

alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table students;

-- ============================================================================
-- APRÈS EXÉCUTION :
--  1) Authentication → Users → Add user : créer un compte staff (email + mdp).
--     Renseigner le nom dans "User Metadata" : { "name": "M. Dupont" }
--  2) Promouvoir ce compte en admin (une fois) :
--     update profiles set role = 'admin'
--       where id = (select id from auth.users where email = 'admin@exemple.fr');
-- ============================================================================
