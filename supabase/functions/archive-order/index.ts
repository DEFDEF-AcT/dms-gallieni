// Edge Function : passerelle vers le script Google (Apps Script).
//   action "archive" (défaut) : archive un document en PDF sur le Drive.        (staff)
//   action "mail"             : envoie un ou plusieurs documents en PDF.         (staff)
//   action "photo"            : dépose une photo d'état d'entrée dans
//                               <client>/<véhicule>/<date>/.          (tout utilisateur connecté :
//                               un élève réceptionne aussi un véhicule)
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
    if (!prof) return json({ ok: false, error: "Profil introuvable" });
    const isStaff = ["admin", "enseignant"].includes(prof.role);

    const body = await req.json();
    const action = body.action === "mail" ? "mail" : body.action === "photo" ? "photo" : "archive";
    if (action !== "photo" && !isStaff)
      return json({ ok: false, error: "Réservé aux enseignants et aux administrateurs" });

    let payload: Record<string, unknown>;
    if (action === "photo") {
      const dataUrl = String(body.dataUrl ?? "");
      if (!/^data:image\/(jpeg|png);base64,/.test(dataUrl)) return json({ ok: false, error: "Image invalide" });
      if (dataUrl.length > 8_000_000) return json({ ok: false, error: "Image trop lourde (6 Mo au maximum)" });
      const name = String(body.name ?? "").replace(/[^\w.\- àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]+/g, "_").slice(0, 120);
      if (!name) return json({ ok: false, error: "Nom de fichier manquant" });
      const folderId = typeof body.folderId === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(body.folderId) ? body.folderId : "";
      const path = Array.isArray(body.path)
        ? body.path.map((x: unknown) => String(x ?? "").trim().slice(0, 100)).filter(Boolean) : [];
      // Arborescence imposée : <client> / <véhicule> / <date>
      if (!folderId && path.length !== 3) return json({ ok: false, error: "Dossier de destination invalide" });
      payload = { secret: scriptSecret, action: "photo", name, dataUrl, ...(folderId ? { folderId } : { path }) };
    } else if (action === "mail") {
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
      // Google a répondu par une page web au lieu de JSON. On consigne de quoi
      // l'identifier (visible dans les journaux Supabase) et on oriente le diagnostic.
      const titre = ((/<title[^>]*>([^<]*)<\/title>/i.exec(txt) || [])[1] || "").trim().slice(0, 120);
      // Texte visible de la page : sur une page d'erreur Apps Script, c'est le
      // message lui-même (ex. « SyntaxError … (ligne 12, fichier "Code") »).
      const visible = txt.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
        .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 300);
      let hote = ""; try { hote = new URL(r.url).host; } catch { /* ignore */ }
      console.error("[passerelle] réponse non JSON du script", JSON.stringify({
        action, status: r.status, hote, titre, visible, taille: txt.length,
      }));
      const connexion = /accounts\.google\.com/.test(hote) || /sign in|connexion|se connecter|anmelden/i.test(titre);
      const introuvable = r.status === 404 || /not found|introuvable|n'existe pas|nicht gefunden|unable to open|impossible d'ouvrir/i.test(titre);
      res = { ok: false, error: connexion
        ? "Le script Google demande une connexion : dans Apps Script → Déployer → Gérer les déploiements → ✏️, " +
          "« Exécuter en tant que » = Moi et « Qui a accès » = Tout le monde, puis Déployer."
        : introuvable
        ? "L'adresse du script Google ne correspond plus à un déploiement actif (déploiement supprimé ou archivé ?). " +
          "Comparez l'URL /exec de Gérer les déploiements avec le secret APPS_SCRIPT_URL de Supabase."
        : "Le script Google s'est arrêté sur une erreur" + (visible ? " : « " + visible + " »" : "") +
          " (HTTP " + r.status + (titre ? ", « " + titre + " »" : "") + ")." };
    }

    // Un script à jour signe sa réponse (`photo`, `mailed`). Un script resté à
    // l'ancienne version ignore l'action et bascule sur l'archivage : on le
    // reconnaît à l'absence de marqueur ou à son message « html et orderNum requis ».
    // Une vraie erreur du script (quota de courriels, dossier invalide…) est, elle,
    // transmise telle quelle.
    const perime = (marqueur: string) =>
      (res?.ok === true && res?.[marqueur] !== true) || res?.error === "html et orderNum requis";
    if (action === "photo" && perime("photo")) {
      return json({
        ok: false,
        error: "Le script Google ne sait pas encore enregistrer les photos : il doit être mis à jour" +
               " (docs/apps-script.gs) puis redéployé en « Nouvelle version ».",
      });
    }
    if (action === "mail" && perime("mailed")) {
      return json({
        ok: false,
        error: "Le script Google n'a pas traité l'envoi — il est enregistré mais pas redéployé." +
               " Dans Apps Script : Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version → Déployer.",
      });
    }
    return json(res);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
