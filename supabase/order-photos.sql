-- ============================================================================
-- PHOTOS D'ÉTAT D'ENTRÉE — à exécuter une fois dans Supabase → SQL Editor.
-- (Peut être relancé sans risque : tout est en « if not exists ».)
--
-- Les originaux (pleine résolution, horodatés) vivent sur Google Drive :
--   <racine> / <client> / <véhicule> / <date> /
-- Cette table garde, pour chaque photo, une miniature et le lien Drive : c'est
-- ce qui permet de les afficher dans l'application et sur l'ordre de réparation
-- sans que chacun ait accès au Drive.
-- ============================================================================
create table if not exists order_photos (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  zone        text not null default '',     -- avant, avant_droit, …, compteur, interieur, dommage
  label       text not null default '',     -- libellé lisible : « 3/4 avant droit »
  damage      boolean not null default false,
  note        text default '',
  thumb       text default '',              -- miniature JPEG (data URL)
  drive_id    text default '',
  drive_url   text default '',
  folder_url  text default '',              -- dossier Drive <client>/<véhicule>/<date>
  taken_at    timestamptz,                  -- instant de la prise de vue
  -- true : photo prise à l'ouverture de l'ordre, AVANT la signature du client
  -- (la signature couvre alors l'état constaté) ; false : ajoutée ensuite.
  at_intake   boolean not null default false,
  created_by  text default '',
  created_at  timestamptz default now()
);
create index if not exists order_photos_order_idx on order_photos (order_id);

alter table order_photos enable row level security;

-- Une photo est visible de qui voit l'ordre : la sous-requête sur `orders`
-- applique d'elle-même les règles de l'ordre (staff : tout ; élève : ses ordres).
drop policy if exists read_order_photos on order_photos;
drop policy if exists ins_order_photos  on order_photos;
drop policy if exists upd_order_photos  on order_photos;
drop policy if exists del_order_photos  on order_photos;
create policy read_order_photos on order_photos for select
  using (exists (select 1 from orders o where o.id = order_photos.order_id));
-- Ajout : tout utilisateur connecté, sur un ordre qu'il voit (un élève réceptionne aussi).
create policy ins_order_photos on order_photos for insert
  with check (auth.role() = 'authenticated'
              and exists (select 1 from orders o where o.id = order_photos.order_id));
-- Correction d'une remarque et retrait : enseignants et administrateurs.
create policy upd_order_photos on order_photos for update using (is_staff());
create policy del_order_photos on order_photos for delete using (is_staff());

do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_photos') then
    alter publication supabase_realtime add table order_photos;
  end if;
end $$;
