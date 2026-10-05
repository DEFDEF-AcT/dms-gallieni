-- ============================================================================
-- DMS Atelier BTS MV — Lycée Gallieni
-- Schéma Supabase : à exécuter dans le SQL Editor du projet (une seule fois).
-- ============================================================================
-- Modèle : seul le STAFF (admin/enseignant) a un compte (auth.users + profiles).
-- Les ÉLÈVES sont de simples fiches (table students), sans compte.
-- ----------------------------------------------------------------------------

-- 1. TABLES -----------------------------------------------------------------

-- Profils liés 1-1 à auth.users. role: admin | enseignant | eleve
-- (les élèves « Étudiant Technicien » ont aussi un compte, avec droits réduits).
create table if not exists profiles (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null,
  role       text not null default 'enseignant' check (role in ('admin','enseignant','eleve')),
  grp        text default '',          -- groupe / classe de l'élève (ex. G1-MV)
  identifier text,                     -- identifiant de connexion élève (= son nom complet)
  created_by uuid references profiles(id) on delete set null,  -- qui a créé ce compte (élève)
  created_at timestamptz default now()
);

-- (DÉPRÉCIÉ) Ancienne table de fiches élèves sans compte. Conservée pour
-- compatibilité, mais l'app utilise désormais les profils (role='eleve').
create table if not exists students (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  grp        text default '',
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
  -- OR « véhicule électrique / hybride » (NULL = OR standard) :
  -- { energy, vin, firstReg, clientAddress, clientEmail, clientContact,
  --   opType: non_elec|hors_tension|voisinage|sous_tension,
  --   quoteAmount, returnDate, returnTime,
  --   steps: { b2vl|consign|interrupt|resume|endwork|deconsign : {name,date,time,visa} } }
  ev                jsonb,
  created_by        text default '',
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- 2. NUMÉROTATION OR-AAAA-XXXX (atomique, anti-collision multi-postes) -------

create table if not exists order_counters (
  year int primary key,
  last int not null default 0
);

-- security definer : le trigger écrit dans order_counters en tant que propriétaire
-- (contourne RLS) ; sinon « new row violates RLS policy for table order_counters ».
create or replace function set_order_num() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  y int := extract(year from now())::int;
  n int;
begin
  if new.order_num is null then
    insert into public.order_counters(year, last) values (y, 1)
      on conflict (year) do update set last = public.order_counters.last + 1
      returning last into n;
    new.order_num := 'OR-' || y || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end;
$$;

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
declare r text := coalesce(new.raw_user_meta_data->>'role', 'enseignant');
begin
  -- rôle lu depuis les metadata (name/role/grp) ; fallback sûr si valeur invalide
  if r not in ('admin','enseignant','eleve') then r := 'enseignant'; end if;
  insert into public.profiles(id, name, role, grp, identifier)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name', new.email),
          r,
          coalesce(new.raw_user_meta_data->>'grp', ''),
          new.raw_user_meta_data->>'identifier')
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

-- helper : l'utilisateur courant fait-il partie du staff (admin ou enseignant) ?
-- Sert à empêcher les élèves de créer des OR / gérer des comptes.
create or replace function is_staff() returns boolean
  language sql security definer stable set search_path = ''
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role in ('admin','enseignant'));
$$;

-- nom du profil de l'utilisateur courant (sert au filtrage des OR par élève affecté)
create or replace function current_name() returns text
  language sql security definer stable set search_path = ''
as $$ select name from public.profiles where id = auth.uid(); $$;

-- 4. RLS ---------------------------------------------------------------------

alter table profiles enable row level security;
alter table students enable row level security;
alter table orders   enable row level security;

-- lecture profils/élèves : tout utilisateur connecté
drop policy if exists read_profiles on profiles;
drop policy if exists read_students on students;
drop policy if exists read_orders   on orders;
create policy read_profiles on profiles for select using (auth.role() = 'authenticated');
create policy read_students on students for select using (auth.role() = 'authenticated');
-- lecture des OR : le staff voit tout ; un élève ne voit QUE les OR où son nom
-- figure dans les élèves affectés (assigned_students). Le `?` teste l'appartenance.
create policy read_orders   on orders   for select
  using ( is_staff() or assigned_students ? current_name() or created_by = current_name() );

-- création / modification : staff
drop policy if exists ins_students on students;
drop policy if exists upd_students on students;
drop policy if exists ins_orders   on orders;
drop policy if exists upd_orders   on orders;
create policy ins_students on students for insert with check (auth.role() = 'authenticated');
create policy upd_students on students for update using (auth.role() = 'authenticated');
-- création d'OR : staff uniquement (les élèves ne peuvent pas créer d'ordre)
-- création d'OR : ouverte à tout utilisateur connecté (élèves compris)
create policy ins_orders   on orders   for insert with check (auth.role() = 'authenticated');
-- modification : staff partout ; élève sur les OR où il est affecté OU qu'il a créés
create policy upd_orders   on orders   for update
  using ( is_staff() or assigned_students ? current_name() or created_by = current_name() );

-- Clôture d'un OR : réservée au staff. L'app masque déjà le bouton aux élèves ;
-- ce garde-fou empêche de contourner la règle par un appel direct à l'API.
create or replace function guard_order_completion() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'termine'
     and coalesce(old.status, '') <> 'termine'
     and auth.role() = 'authenticated'      -- laisse passer le service_role
     and not public.is_staff() then
    raise exception 'Seul un enseignant ou un administrateur peut terminer un ordre de réparation.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_completion on orders;
create trigger trg_order_completion before update on orders
  for each row execute function guard_order_completion();

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
-- DOCUMENTS : Estimations (devis) et Factures — réservés au STAFF
-- ============================================================================
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('estimate','invoice')),
  doc_num      text unique,                       -- EST-AAAA-XXXX / FA-AAAA-XXXX
  order_id     uuid references orders(id) on delete set null,
  client_name  text default '', client_phone text default '',
  plate text default '', brand text default '', model text default '',
  year text default '', km text default '',
  items        jsonb default '[]'::jsonb,          -- [{label, qty, unitPrice}]
  tva_rate     numeric default 20,        -- l'application crée les documents à 0
  -- 'ttc' : prix saisis TVA incluse (défaut de l'application, tarifs atelier TTC)
  -- 'ht'  : la TVA s'ajoute au total des lignes
  price_mode   text not null default 'ht' check (price_mode in ('ht','ttc')),
  signature    text default '',                    -- accord client (estimations)
  notes        text default '',
  valid_until  date,                               -- validité (devis) / échéance (facture)
  created_by   text default '',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Numérotation par type + année
create table if not exists doc_counters (
  kind text, year int, last int not null default 0,
  primary key (kind, year)
);
create or replace function set_doc_num() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare y int := extract(year from now())::int; n int; p text;
begin
  if new.doc_num is null then
    p := case new.kind when 'estimate' then 'EST' when 'invoice' then 'FA' else 'DOC' end;
    insert into public.doc_counters(kind, year, last) values (new.kind, y, 1)
      on conflict (kind, year) do update set last = public.doc_counters.last + 1
      returning last into n;
    new.doc_num := p || '-' || y || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end; $$;
drop trigger if exists trg_doc_num on documents;
create trigger trg_doc_num before insert on documents
  for each row execute function set_doc_num();

drop trigger if exists trg_documents_touch on documents;
create trigger trg_documents_touch before update on documents
  for each row execute function touch_updated_at();

-- RLS : staff uniquement (les élèves n'y ont aucun accès)
alter table documents enable row level security;
drop policy if exists read_documents on documents;
drop policy if exists ins_documents  on documents;
drop policy if exists upd_documents  on documents;
drop policy if exists del_documents  on documents;
-- Documents : le staff voit tout ; un élève ne voit/modifie QUE ceux qu'il a créés.
create policy read_documents on documents for select using (is_staff() or created_by = current_name());
create policy ins_documents  on documents for insert with check (auth.role() = 'authenticated');
create policy upd_documents  on documents for update using (is_staff() or created_by = current_name());
create policy del_documents  on documents for delete using (is_admin());

alter publication supabase_realtime add table documents;

-- ----------------------------------------------------------------------------
-- MIGRATION (bases déjà en service) : traçabilité VE/VH
--   alter table orders add column if not exists ev jsonb;
-- MIGRATION : créer la table vehicle_history ci-dessous.
-- MIGRATION : créer la table tariffs ci-dessous (avec son jeu de départ).
-- MIGRATION : alter table documents add column if not exists price_mode text
--   not null default 'ht' check (price_mode in ('ht','ttc'));
-- MIGRATION : clôture réservée au staff → (re)créer guard_order_completion()
--   et le déclencheur trg_order_completion ci-dessus.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- TARIFS DE L'ATELIER
-- Lecture : tout utilisateur connecté (alimente les boutons des estimations et
-- des factures). Écriture : administrateurs uniquement.
-- ============================================================================
create table if not exists tariffs (
  id         uuid primary key default gen_random_uuid(),
  grp        text not null default 'Divers',   -- groupe affiché (Main-d'œuvre, Climatisation…)
  short      text not null default '',         -- libellé du bouton
  label      text not null default '',         -- libellé porté sur le devis / la facture
  hint       text default '',                  -- précision affichée sous le bouton
  price      numeric not null default 0,       -- prix unitaire HT
  unit       text default '',                  -- h, g, forfait…
  pos        int not null default 0,           -- ordre d'affichage dans le groupe
  active     boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists trg_tariffs_touch on tariffs;
create trigger trg_tariffs_touch before update on tariffs
  for each row execute function touch_updated_at();

alter table tariffs enable row level security;
drop policy if exists read_tariffs on tariffs;
drop policy if exists ins_tariffs  on tariffs;
drop policy if exists upd_tariffs  on tariffs;
drop policy if exists del_tariffs  on tariffs;
create policy read_tariffs on tariffs for select using (auth.role() = 'authenticated');
create policy ins_tariffs  on tariffs for insert with check (is_admin());
create policy upd_tariffs  on tariffs for update using (is_admin());
create policy del_tariffs  on tariffs for delete using (is_admin());

alter publication supabase_realtime add table tariffs;

-- Jeu de départ (taux horaires + forfaits climatisation). Modifiable ensuite
-- depuis l'application : Administration → 💶 Tarifs.
insert into tariffs (grp, short, label, hint, price, unit, pos)
select * from (values
  ('Main-d''œuvre','T1 · Maintenance périodique','T1 – Main-d''œuvre : maintenance périodique','Toutes opérations de maintenance périodique',20,'h',1),
  ('Main-d''œuvre','T2 · Maintenance corrective','T2 – Main-d''œuvre : maintenance corrective','Toutes opérations de maintenance corrective',30,'h',2),
  ('Main-d''œuvre','T3 · Diagnostic','T3 – Main-d''œuvre : diagnostic','',40,'h',3),
  ('Climatisation','Maintenance circuit frigorigène','Maintenance du circuit de fluide frigorigène : contrôle d''étanchéité, nettoyage du circuit, recharge, contrôle de fonctionnement','Tarif T1 · temps selon barème constructeur',20,'h',1),
  ('Climatisation','Recharge R134a','Recharge fluide frigorigène R134a','Véhicule avant 2013 · quantité en grammes',0.08,'g',2),
  ('Climatisation','Recharge R1234yf','Recharge fluide frigorigène R1234yf','Véhicule après 2013 · quantité en grammes',0.12,'g',3),
  ('Climatisation','Diagnostic gestion thermique','Diagnostic de l''efficacité de la gestion thermique de l''habitacle','Gratuit',0,'forfait',4),
  ('Climatisation','Diagnostic de fuite','Diagnostic de fuite selon la réglementation en vigueur : injection d''azote et/ou de traceur','',5,'forfait',5),
  ('Frais annexes','Gestion des déchets industriels','Participation aux frais de gestion des déchets industriels','Ligne facultative : à ajouter selon l''intervention',5,'forfait',1)
) as v(grp, short, label, hint, price, unit, pos)
where not exists (select 1 from tariffs);

-- ============================================================================
-- HISTORIQUE D'ENTRETIEN DES VÉHICULES (identifié par la plaque)
-- Complète l'historique automatique (ordres, estimations, factures) : on y
-- saisit ce qui n'est pas passé par l'atelier — entretien antérieur,
-- intervention extérieure, contrôle technique…
-- Lecture : tout utilisateur connecté. Écriture : enseignants et administrateurs.
-- ============================================================================
create table if not exists vehicle_history (
  id         uuid primary key default gen_random_uuid(),
  plate      text not null,
  brand      text default '',                 -- secours si le véhicule n'a aucun OR
  model      text default '',
  date       date,
  km         text default '',
  kind       text not null default 'entretien',  -- entretien|reparation|controle|diagnostic|pneus|autre
  label      text not null default '',
  details    text default '',
  created_by text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists vehicle_history_plate_idx on vehicle_history (upper(plate));

drop trigger if exists trg_vehicle_history_touch on vehicle_history;
create trigger trg_vehicle_history_touch before update on vehicle_history
  for each row execute function touch_updated_at();

alter table vehicle_history enable row level security;
drop policy if exists read_vehicle_history on vehicle_history;
drop policy if exists ins_vehicle_history  on vehicle_history;
drop policy if exists upd_vehicle_history  on vehicle_history;
drop policy if exists del_vehicle_history  on vehicle_history;
create policy read_vehicle_history on vehicle_history for select using (auth.role() = 'authenticated');
create policy ins_vehicle_history  on vehicle_history for insert with check (is_staff());
create policy upd_vehicle_history  on vehicle_history for update using (is_staff());
create policy del_vehicle_history  on vehicle_history for delete using (is_staff());

alter publication supabase_realtime add table vehicle_history;

-- ============================================================================
-- APRÈS EXÉCUTION :
--  1) Authentication → Users → Add user : créer un compte staff (email + mdp).
--     Renseigner le nom dans "User Metadata" : { "name": "M. Dupont" }
--  2) Promouvoir ce compte en admin (une fois) :
--     update profiles set role = 'admin'
--       where id = (select id from auth.users where email = 'admin@exemple.fr');
-- ============================================================================
