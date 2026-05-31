import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Message explicite en dev/prod si les variables d'env manquent.
  console.error(
    "[DMS] Variables d'environnement Supabase manquantes. " +
    "Renseignez VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY (voir .env.example)."
  );
}

export const supabase = createClient(url, anon);
