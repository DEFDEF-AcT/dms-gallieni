// Edge Function : gestion des comptes élèves (« Étudiant Technicien »).
// Crée/supprime/réinitialise des comptes Supabase Auth avec la clé service_role
// (jamais exposée au frontend).
//
// Qui peut quoi :
//   - administrateur : tout, y compris créer des comptes du personnel ;
//   - enseignant     : créer des élèves, puis supprimer / réinitialiser
//                      UNIQUEMENT ceux qu'il a lui-même créés (profiles.created_by) ;
//   - élève          : aucun accès.
//
// Déploiement (dashboard Supabase → Edge Functions → manage-students → Deploy,
// ou `supabase functions deploy manage-students`). Les variables SUPABASE_URL /
// SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY sont injectées par Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Domaine interne des emails synthétiques (l'utilisateur ne le voit jamais ; il tape son identifiant).
const DOMAIN = "eleve.gallieni.local";

// Normalise un identifiant (ex. un nom complet) en partie locale d'email valide.
// « Jean Martin » → « jean.martin ». DOIT être identique à slugId() côté frontend.
function slugId(s: string): string {
  return String(s).normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
}

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

    // 2) Vérifier le rôle de l'appelant (via service role)
    const admin = createClient(url, serviceKey);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
    const callerRole = prof?.role;
    if (callerRole !== "admin" && callerRole !== "enseignant")
      return json({ ok: false, error: "Réservé au personnel (enseignant ou administrateur)" });
    const isAdminCaller = callerRole === "admin";
    // Un enseignant ne peut agir que sur les élèves QU'IL A CRÉÉS.
    const ownsTarget = async (targetId: string) => {
      const { data: t } = await admin.from("profiles").select("role, created_by").eq("id", targetId).single();
      return { target: t, owned: t?.role === "eleve" && t?.created_by === user.id };
    };

    const { action, name, grp, password, id, identifier } = await req.json();

    if (action === "create") {
      if (!name || !password) return json({ ok: false, error: "Nom et mot de passe requis" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      // L'identifiant de connexion de l'élève EST son nom complet.
      const ident = String(name).trim();
      const local = slugId(ident);
      if (!local) return json({ ok: false, error: "Nom invalide" });
      // unicité (insensible à la casse) — deux élèves de même nom impossibles
      const { data: clash } = await admin.from("profiles").select("id").ilike("identifier", ident);
      if (clash && clash.length) return json({ ok: false, error: "Un élève portant ce nom existe déjà" });
      const email = `${local}@${DOMAIN}`;
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name: ident, role: "eleve", grp: grp ?? "", identifier: ident },
      });
      if (cErr) return json({ ok: false, error: "Création impossible (nom déjà utilisé ?) : " + cErr.message });
      // Traçabilité : qui a créé cet élève (un enseignant ne gérera que les siens)
      await admin.from("profiles").update({ created_by: user.id }).eq("id", created.user.id);
      return json({ ok: true, identifier: ident, id: created.user.id, name: ident, grp: grp ?? "" });
    }

    if (action === "create_teacher") {
      if (!isAdminCaller) return json({ ok: false, error: "Créer un compte du personnel est réservé à l'administrateur" });
      const ident = String(identifier ?? "").trim();
      if (!ident || !name || !password) return json({ ok: false, error: "Identifiant, nom et mot de passe requis" });
      if (/[@\s]/.test(ident)) return json({ ok: false, error: "Identifiant sans espace ni @" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      // unicité de l'identifiant (insensible à la casse)
      const { data: clash } = await admin.from("profiles").select("id").ilike("identifier", ident);
      if (clash && clash.length) return json({ ok: false, error: "Identifiant déjà utilisé" });
      const email = `${slugId(ident)}@${DOMAIN}`;
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
      const { target, owned } = await ownsTarget(id);
      if (target?.role === "admin") return json({ ok: false, error: "Impossible de supprimer un administrateur" });
      if (!isAdminCaller && !owned)
        return json({ ok: false, error: "Vous ne pouvez supprimer que les élèves que vous avez créés" });
      const { error: dErr } = await admin.auth.admin.deleteUser(id);
      if (dErr) return json({ ok: false, error: dErr.message });
      return json({ ok: true });
    }

    if (action === "reset_password") {
      if (!id || !password) return json({ ok: false, error: "id et mot de passe requis" });
      if (String(password).length < 6) return json({ ok: false, error: "Mot de passe : 6 caractères minimum" });
      if (!isAdminCaller) {
        const { owned } = await ownsTarget(id);
        if (!owned) return json({ ok: false, error: "Vous ne pouvez réinitialiser que les élèves que vous avez créés" });
      }
      const { error: rErr } = await admin.auth.admin.updateUserById(id, { password });
      if (rErr) return json({ ok: false, error: rErr.message });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Action inconnue" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
