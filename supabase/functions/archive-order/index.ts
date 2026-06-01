// Edge Function : passerelle d'archivage d'un ordre de réparation sur Google Drive.
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
    if (!prof || !["admin", "enseignant"].includes(prof.role)) return json({ ok: false, error: "Réservé au staff" });

    const { html, folder, orderNum } = await req.json();
    if (!html || !orderNum) return json({ ok: false, error: "html et orderNum requis" });

    // Relai vers le script Google (qui convertit en PDF et classe par dossier).
    const r = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: scriptSecret, html, folder: folder || "Client sans nom", orderNum }),
      redirect: "follow",
    });
    const txt = await r.text();
    let res: unknown;
    try { res = JSON.parse(txt); } catch { res = { ok: false, error: "Réponse inattendue du script: " + txt.slice(0, 200) }; }
    return json(res);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
