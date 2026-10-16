// Edge Function : passerelle vers le script Google (Apps Script).
//   action "archive" (défaut) : archive un document en PDF sur le Drive.
//   action "mail"             : envoie un ou plusieurs documents en PDF par courriel.
// Le frontend ne connaît jamais l'URL ni le secret du script Google : c'est cette
// fonction (côté serveur) qui les détient et relaie l'envoi (ce qui règle aussi le CORS).
//
// Secrets à définir dans Supabase (Edge Functions → Secrets) :
//   APPS_SCRIPT_URL    = URL /exec de l'application web Apps Script
//   APPS_SCRIPT_SECRET = même secret que la constante SECRET du script
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const scriptUrl = Deno.env.get("APPS_SCRIPT_URL");
    const scriptSecret = Deno.env.get("APPS_SCRIPT_SECRET");
    if (!scriptUrl || !scriptSecret) return json({ ok: false, error: "Archivage non configuré (secrets APPS_SCRIPT_* manquants)" });

    const authHeader = req.headers.get("Authorization") || "";
    // L'appelant doit être connecté et faire partie du staff.
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ ok: false, error: "Non authentifié" });
    const admin = createClient(url, serviceKey);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (!prof || !["admin", "enseignant"].includes(prof.role))
      return json({ ok: false, error: "Réservé aux enseignants et aux administrateurs" });

    const body = await req.json();
    const action = body.action === "mail" ? "mail" : "archive";

    let payload: Record<string, unknown>;
    if (action === "mail") {
      const to = String(body.to ?? "").trim();
      const docs = Array.isArray(body.docs) ? body.docs : [];
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ ok: false, error: "Adresse électronique invalide" });
      if (docs.length === 0) return json({ ok: false, error: "Aucun document à envoyer" });
      if (docs.length > 6) return json({ ok: false, error: "6 documents au maximum par envoi" });
      for (const d of docs) {
        if (!d || typeof d.html !== "string" || !d.html) return json({ ok: false, error: "Document vide" });
      }
      payload = {
        secret: scriptSecret, action: "mail", to,
        subject: String(body.subject ?? "").slice(0, 200) || "Lycée Gallieni – Atelier BTS MV",
        body: String(body.body ?? "").slice(0, 5000),
        from: prof.role === "admin" || prof.role === "enseignant" ? String(body.from ?? "") : "",
        docs: docs.map((d: { html: string; name?: string }) => ({
          html: d.html, name: String(d.name ?? "document").replace(/[^\w.-]+/g, "_").slice(0, 80),
        })),
      };
    } else {
      const { html, folder, orderNum } = body;
      if (!html || !orderNum) return json({ ok: false, error: "Passerelle : html et orderNum requis" });
      payload = { secret: scriptSecret, action: "archive", html, folder: folder || "Client sans nom", orderNum };
    }

    // Relai vers le script Google (conversion PDF, classement Drive, envoi).
    const r = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    const txt = await r.text();
    let res: Record<string, unknown>;
    try { res = JSON.parse(txt); }
    catch {
      // Une page HTML au lieu de JSON = Google réclame une connexion : l'application
      // web n'est pas publiée en accès libre (ou son URL /exec a changé).
      res = txt.trimStart().startsWith("<")
        ? { ok: false, error: "Le script Google a renvoyé une page de connexion au lieu de données. " +
            "Dans Apps Script → Déployer → Gérer les déploiements → ✏️ : « Exécuter en tant que » = Moi, " +
            "« Qui a accès » = Tout le monde, puis Déployer. Vérifiez aussi que l'URL /exec affichée " +
            "est bien celle enregistrée dans le secret APPS_SCRIPT_URL." }
        : { ok: false, error: "Réponse inattendue du script : " + txt.slice(0, 200) };
    }

    // Un script à jour confirme l'envoi par `mailed`. Sans ce marqueur, c'est
    // l'ancienne version qui répond : le code est enregistré mais pas redéployé.
    if (action === "mail" && res?.mailed !== true) {
      const d = typeof res?.error === "string" ? " Réponse du script : « " + res.error + " »." : "";
      return json({
        ok: false,
        error: "Le script Google n'a pas traité l'envoi — il est enregistré mais pas redéployé." +
               " Dans Apps Script : Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version → Déployer." + d,
      });
    }
    return json(res);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
