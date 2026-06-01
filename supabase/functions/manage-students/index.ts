// Edge Function : gestion des comptes élèves (« Étudiant Technicien »).
// Réservée à l'administrateur. Crée/supprime/réinitialise des comptes Supabase Auth
// en utilisant la clé service_role (jamais exposée au frontend).
//
// Déploiement (dashboard Supabase → Edge Functions → Create a new function,
// nom EXACT « manage-students », coller ce code, Deploy). Les variables
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY sont injectées
// automatiquement par Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Domaine interne des emails synthétiques (l'élève ne le voit jamais ; il tape « Etudiant1 »).
const DOMAIN = "eleve.gallieni.local";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";

    // 1) Identifier l'appelant à partir de son jeton
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await asUser.auth.getUser();
    if (uErr || !user) return json({ ok: false, error: "Non authentifié" });

    // 2) Vérifier qu'il est admin (via service role)
    const admin = createClient(url, serviceKey);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "admin") return json({ ok: false, error: "Réservé à l'administrateur" });

    const { action, name, grp, password, id, identifier } = await req.json();

    if (action === "create") {
      if (!name || !password) return json({ ok: false, error: "Nom et mot de passe requis" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      // Identifiant auto « EtudiantN »
      const { data: existing } = await admin.from("profiles").select("identifier").eq("role", "eleve");
      let max = 0;
      for (const r of existing ?? []) {
        const m = /^Etudiant(\d+)$/i.exec(r.identifier ?? "");
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      const identifier = "Etudiant" + (max + 1);
      const email = `${identifier.toLowerCase()}@${DOMAIN}`;
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, role: "eleve", grp: grp ?? "", identifier },
      });
      if (cErr) return json({ ok: false, error: cErr.message });
      return json({ ok: true, identifier, id: created.user.id, name, grp: grp ?? "" });
    }

    if (action === "create_teacher") {
      const ident = String(identifier ?? "").trim();
      if (!ident || !name || !password) return json({ ok: false, error: "Identifiant, nom et mot de passe requis" });
      if (/[@\s]/.test(ident)) return json({ ok: false, error: "Identifiant sans espace ni @" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      // unicité de l'identifiant (insensible à la casse)
      const { data: clash } = await admin.from("profiles").select("id").ilike("identifier", ident);
      if (clash && clash.length) return json({ ok: false, error: "Identifiant déjà utilisé" });
      const email = `${ident.toLowerCase()}@${DOMAIN}`;
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, role: "enseignant", identifier: ident },
      });
      if (cErr) return json({ ok: false, error: cErr.message });
      return json({ ok: true, identifier: ident, id: created.user.id, name });
    }

    if (action === "delete") {
      if (!id) return json({ ok: false, error: "id requis" });
      if (id === user.id) return json({ ok: false, error: "Impossible de supprimer son propre compte" });
      const { data: target } = await admin.from("profiles").select("role").eq("id", id).single();
      if (target?.role === "admin") return json({ ok: false, error: "Impossible de supprimer un administrateur" });
      const { error: dErr } = await admin.auth.admin.deleteUser(id);
      if (dErr) return json({ ok: false, error: dErr.message });
      return json({ ok: true });
    }

    if (action === "reset_password") {
      if (!id || !password) return json({ ok: false, error: "id et mot de passe requis" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      const { error: rErr } = await admin.auth.admin.updateUserById(id, { password });
      if (rErr) return json({ ok: false, error: rErr.message });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Action inconnue" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
