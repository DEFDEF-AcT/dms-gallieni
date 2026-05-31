# DMS – Atelier BTS Maintenance des Véhicules · Lycée Gallieni

Application web de gestion d'atelier (Dealer Management System) : ordres de réparation,
affectation pédagogique des élèves, suivi des travaux, signature client, export CSV et PDF.

- **Frontend** : React 19 + Vite (statique, hébergé sur GitHub Pages)
- **Backend** : Supabase (PostgreSQL + Auth + Realtime)
- **Accès** : navigateur sur PC Linux, tablette ou téléphone, sans installation

Seul le **personnel** (enseignants / administration) possède un compte. Les **élèves**
sont de simples fiches affectables aux ordres.

---

## 1. Configuration de Supabase (une seule fois)

1. Projet Supabase en région **EU (Francfort)** recommandée pour le RGPD.
2. **SQL Editor** → coller et exécuter [`supabase/schema.sql`](supabase/schema.sql)
   (tables, numérotation auto `OR-AAAA-XXXX`, politiques RLS, realtime).
3. **Authentication → Users → Add user** : créer un compte (email + mot de passe).
   Dans *User Metadata*, renseigner : `{ "name": "M. Dupont" }`.
4. Promouvoir ce compte en administrateur (SQL Editor) :
   ```sql
   update profiles set role = 'admin'
     where id = (select id from auth.users where email = 'admin@exemple.fr');
   ```

## 2. Développement local

```bash
cp .env.example .env.local      # puis renseigner URL + clé anon (Project Settings → API)
npm install
npm run dev
```

## 3. Déploiement (GitHub Pages)

1. Pousser le dépôt sur GitHub sous le nom **`dms-gallieni`**
   (le `base` de [`vite.config.js`](vite.config.js) doit correspondre au nom du dépôt).
2. **Settings → Secrets and variables → Actions** → ajouter :
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. **Settings → Pages** → *Source* : **GitHub Actions**.
4. Chaque `push` sur `main` build et déploie automatiquement
   (workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

URL finale : `https://<utilisateur>.github.io/dms-gallieni/`

> La clé `anon` est **publique par conception** ; la sécurité des données repose
> sur les politiques **RLS** définies dans `schema.sql`.

## Scripts

| Commande          | Effet                          |
|-------------------|--------------------------------|
| `npm run dev`     | serveur de développement       |
| `npm run build`   | build de production (`dist/`)  |
| `npm run preview` | prévisualiser le build         |
| `npm run lint`    | ESLint                         |
