import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";
import {
  listOrders, insertOrder, updateOrder as dbUpdateOrder, deleteOrder,
  listStudents, listStaff,
  createStudent, createTeacher, deleteAccount, resetPassword,
  archiveOrder,
  listDocuments, insertDocument, updateDocument, deleteDocument,
  countInspectionsBy,
  listTariffs, insertTariff, updateTariff, deleteTariff,
  listVehicleHistory, insertVehicleHistory, updateVehicleHistory, deleteVehicleHistory,
} from "./data";

// Montants / TVA
const num = (v) => { const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const eur = (n) => num(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
// Quantité à la française sur les documents : 1.5 → « 1,5 », 650 → « 650 ».
const qte = (q) => { const n = Number(q); return (q === "" || q == null || !Number.isFinite(n)) ? String(q ?? "") : n.toLocaleString("fr-FR"); };
function docTotals(doc) {
  const somme = (doc.items || []).reduce((s, it) => s + num(it.qty) * num(it.unitPrice), 0);
  const taux = num(doc.tvaRate);
  if (doc.priceMode === "ttc") {
    // prix payés par le client : on retrouve le HT par division (« dont TVA »)
    const ttc = somme, ht = taux ? ttc / (1 + taux / 100) : ttc;
    return { ht, tva: ttc - ht, ttc, ttcMode: true };
  }
  const tva = somme * taux / 100;
  return { ht: somme, tva, ttc: somme + tva, ttcMode: false };
}
const isTTC = (doc) => doc?.priceMode === "ttc";
const DOC_LABEL = { estimate: "Estimation", invoice: "Facture" };

// Historique d'entretien : une plaque = une clé, quelle que soit sa ponctuation
// (« AB-123-CD », « ab 123 cd » et « AB123CD » désignent le même véhicule).
const plateKey = (p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Affichage canonique : « ab 123 cd » → « AB-123-CD ». Les plaques d'un autre
// format (anciennes, étrangères) sont simplement mises en majuscules.
const plateFmt = (p) => {
  const k = plateKey(p);
  const m = /^([A-Z]{2})(\d{3})([A-Z]{2})$/.exec(k);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : String(p ?? "").toUpperCase().trim();
};
const VH_KINDS = [
  { v:"entretien",  l:"Entretien périodique", ico:"🛠", col:"#1d4ed8", bg:"#dbeafe" },
  { v:"reparation", l:"Réparation",           ico:"🔧", col:"#b45309", bg:"#fef3c7" },
  { v:"controle",   l:"Contrôle technique",   ico:"✅", col:"#15803d", bg:"#dcfce7" },
  { v:"diagnostic", l:"Diagnostic",           ico:"🔎", col:"#7c3aed", bg:"#ede9fe" },
  { v:"pneus",      l:"Pneumatiques",         ico:"🛞", col:"#0f766e", bg:"#ccfbf1" },
  { v:"autre",      l:"Autre",                ico:"📌", col:"#475569", bg:"#f1f5f9" },
];
const vhKind = (v) => VH_KINDS.find(k => k.v === v) || VH_KINDS[VH_KINDS.length - 1];
// « 95000 » → « 95 000 » ; une valeur non numérique est laissée telle quelle.
const kmTxt = (k) => {
  const n = Number(String(k ?? "").replace(/\s/g, ""));
  return (k && Number.isFinite(n) && n > 0) ? n.toLocaleString("fr-FR") : String(k ?? "");
};

// Fiche de chaque véhicule connu de l'atelier, reconstituée depuis les ordres,
// les documents et les interventions saisies à la main. Les informations les
// plus récentes l'emportent.
function buildVehicles(orders, documents, history) {
  const rows = [];
  (orders || []).forEach(o => rows.push({ plate:o.plate, date:o.exitDate||o.entryDate||o.createdAt||"",
    brand:o.brand, model:o.model, year:o.year, km:o.km,
    client:o.vtype === "peda" ? "Véhicule pédagogique" : (o.clientName || ""), src:"or" }));
  (documents || []).forEach(d => rows.push({ plate:d.plate, date:(d.createdAt||"").slice(0,10),
    brand:d.brand, model:d.model, year:d.year, km:d.km, client:d.clientName || "", src:"doc" }));
  (history || []).forEach(h => rows.push({ plate:h.plate, date:h.date||(h.createdAt||"").slice(0,10),
    brand:h.brand, model:h.model, year:"", km:h.km, client:"", src:"vh" }));
  const map = new Map();
  rows.filter(r => plateKey(r.plate))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))   // du plus ancien au plus récent
      .forEach(r => {
        const k = plateKey(r.plate);
        const v = map.get(k) || { key:k, plate:r.plate, brand:"", model:"", year:"", km:"", client:"",
                                  last:"", nOrders:0, nDocs:0, nNotes:0 };
        if (r.plate) v.plate = plateFmt(r.plate);
        for (const f of ["brand", "model", "year", "km", "client"]) if (r[f]) v[f] = r[f];
        if (String(r.date) > String(v.last)) v.last = r.date;
        if (r.src === "or") v.nOrders++; else if (r.src === "doc") v.nDocs++; else v.nNotes++;
        map.set(k, v);
      });
  return [...map.values()].sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

// Groupes de tarifs présents dans le catalogue, dans l'ordre d'affichage.
const tarifGroups = (list) => (list||[]).reduce((a,t) => a.includes(t.group) ? a : [...a, t.group], []);
// Archive un OR en PDF sur le Drive (asynchrone, non bloquant).
function archiveToDrive(order, notify) {
  archiveOrder({ html: orderHTML(order), folder: orderFolder(order), orderNum: order.orderNum })
    .then(() => notify && notify("Ordre archivé sur le Drive"))
    .catch((e) => { console.error("[DMS] archivage Drive", e); notify && notify("Archivage Drive non effectué : " + (e.message || e), "error"); });
}

// Domaine interne des identifiants (doit correspondre à l'Edge Function).
const STUDENT_DOMAIN = "eleve.gallieni.local";
// Logo de l'établissement affiché dans l'app (écran de connexion, barre latérale, en-tête)
const LOGO = import.meta.env.BASE_URL + "logo.png";
// Normalise un identifiant (nom complet) en partie locale d'email. DOIT être
// identique au slugId() de l'Edge Function. « Jean Martin » → « jean.martin ».
const slugId = (s) => String(s).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
// Un email (avec @) est laissé tel quel ; sinon on dérive depuis l'identifiant/nom.
const toLoginEmail = (v) => v.includes("@") ? v.trim() : slugId(v) + "@" + STUDENT_DOMAIN;

const VS = {
  en_attente: { label: "En attente", col: "#F59E0B" },
  en_cours:   { label: "En cours",   col: "#60A5FA" },
  termine:    { label: "Terminé",   col: "#34D399" },
};
const C = {
  bg:"#eff6ff", card:"#ffffff", side:"#dbeafe", hdr:"#e0f2fe",
  acc:"#2563eb", bdr:"#bfdbfe", txt:"#102a43", sub:"#334155", mut:"#64748b"
};
const ROLE_STYLE = {
  admin:      { bg:"#fee2e2", cl:"#b91c1c" },
  enseignant: { bg:"#dbeafe", cl:"#1d4ed8" },
  eleve:      { bg:"#dcfce7", cl:"#15803d" },
};
const ROLE_LABEL = { admin:"Administrateur", enseignant:"Enseignant", eleve:"Étudiant Technicien" };
const roleLabel = (r) => ROLE_LABEL[r] || r;
// Classes des étudiants (BTS Maintenance des Véhicules)
const CLASSES = ["STS 1 VL", "STS 2 VL", "STS 1 VTR", "STS 2 VTR"];

const gid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);
const today = () => new Date().toISOString().slice(0,10);
const tNow  = () => new Date().toTimeString().slice(0,5);
const fD    = (d) => d ? new Date(d).toLocaleDateString("fr-FR") : "—";
const esc   = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const TASKS0 = [
  "Vidange moteur + filtre à huile","Remplacement filtre à air",
  "Contrôle plaquettes frein AV","Contrôle plaquettes frein AR",
  "Contrôle des niveaux","Diagnostic électronique OBD",
  "Contrôle pneumatiques","Contrôle éclairage / signalisation",
  "Contrôle batterie / charge","Climatisation : contrôle / recharge",
  "Remplacement courroie de distribution","Contrôle géométrie",
];

// ── Véhicules électriques / hybrides (VE/VH) ────────────────────────────────
// Trame « OR VE VH » : §5 « Type d'opération » + traçabilité de la mise en
// sécurité électrique de la batterie de traction (consignation BCL).
// Un OR standard porte `ev = null` ; un OR VE/VH porte l'objet ci-dessous.
const EV_ENERGIES = [
  "", "Électrique (EL)", "Hybride rechargeable (EE / GL)",
  "Hybride non rechargeable (EH / GH)", "Hydrogène – pile à combustible (H2)", "Autre",
];
const EV_OPS = [
  { v:"non_elec",     l:"Opération non électrique",            s:"Aucune intervention sur le circuit haute tension.",   col:"#15803d", bg:"#dcfce7" },
  { v:"hors_tension", l:"Opération électrique – hors tension", s:"Consignation obligatoire avant toute intervention.",  col:"#1d4ed8", bg:"#dbeafe" },
  { v:"voisinage",    l:"Opération électrique – au voisinage", s:"Zone de voisinage HT : habilitation B2VL requise.",   col:"#b45309", bg:"#fef3c7" },
  { v:"sous_tension", l:"Opération électrique – sous tension", s:"Opération à haut risque : encadrement obligatoire.",  col:"#b91c1c", bg:"#fee2e2" },
];
const evOp = (v) => EV_OPS.find(o => o.v === v) || EV_OPS[0];
// Les 6 lignes de traçabilité de la trame, dans l'ordre chronologique.
const EV_STEPS = [
  { id:"b2vl",      lbl:"Chargé de travaux B2VL",               who:"Chargé de travaux (B2VL)",
    txt:"est désigné pour conduire l'intervention et encadrer le personnel." },
  { id:"consign",   lbl:"Consignation / Mise hors tension",     who:"Chargé de consignation (BCL)",
    txt:"atteste avoir consigné / mis hors tension le véhicule désigné." },
  { id:"interrupt", lbl:"Interruption des travaux",
    txt:"Le chargé de travaux avise que les travaux sont interrompus et que son personnel est informé." },
  { id:"resume",    lbl:"Reprise des travaux",
    txt:"Le chargé de travaux avise que les travaux sont repris et que son personnel est informé." },
  { id:"endwork",   lbl:"Fin de travaux",
    txt:"Le chargé de travaux avise que les travaux sont terminés et que son personnel est informé." },
  { id:"deconsign", lbl:"Déconsignation / Remise sous tension", who:"Chargé de consignation (BCL)",
    txt:"atteste avoir déconsigné / remis sous tension le véhicule désigné." },
];
const evStep0 = () => ({ name:"", date:"", time:"", visa:"" });
const EV0 = () => ({
  energy:"", vin:"", firstReg:"",
  clientAddress:"", clientEmail:"", clientContact:"",
  opType:"non_elec", quoteAmount:"", returnDate:"", returnTime:"",
  steps: EV_STEPS.reduce((a, st) => { a[st.id] = evStep0(); return a; }, {}),
});
const evStep  = (ev, id) => (ev && ev.steps && ev.steps[id]) || evStep0();
const evDone  = (st) => !!(st && (st.date || st.visa));
// Consigné mais pas encore déconsigné → la batterie de traction est hors tension.
const evOpen  = (ev) => !!ev && ev.opType !== "non_elec" && evDone(evStep(ev,"consign")) && !evDone(evStep(ev,"deconsign"));
// Opération électrique dont la consignation n'est pas horodatée → interdiction d'intervenir.
const evTodo  = (ev) => !!ev && ev.opType !== "non_elec" && !evDone(evStep(ev,"consign"));
const evWhen  = (st) => evDone(st) ? fD(st.date) + (st.time ? " à " + st.time : "") : "";

// ── Données Supabase (remplace localStorage) ──
// Collection générique : fetch initial + abonnement realtime (refetch sur
// changement) pour synchroniser tous les postes connectés.
// `dep` (ex. l'id de l'utilisateur connecté) : recharge dès qu'il change, pour
// éviter un 1er chargement non authentifié (qui renvoie vide via RLS) au démarrage.
function useCollection(listFn, table, dep) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    listFn()
      .then(setItems)
      .catch((e) => console.error("[DMS] chargement " + table, e))
      .finally(() => setLoading(false));
  }, [listFn, table]);
  useEffect(() => {
    reload();
    const ch = supabase
      .channel("rt-" + table)
      .on("postgres_changes", { event: "*", schema: "public", table }, reload)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [reload, table, dep]);
  return { items, setItems, loading, reload };
}

function useOrders(dep) {
  const { items, loading, reload } = useCollection(listOrders, "orders", dep);
  const addOrder = useCallback(async (o) => { const r = await insertOrder(o); reload(); return r; }, [reload]);
  const editOrder = useCallback(async (id, patch) => { const r = await dbUpdateOrder(id, patch); reload(); return r; }, [reload]);
  const removeOrder = useCallback(async (id) => { await deleteOrder(id); reload(); }, [reload]);
  return { orders: items, loading, addOrder, editOrder, removeOrder, reload };
}

// Élèves = profils role='eleve'. Gérés via l'Edge Function (admin) ; reload après mutation.
function useStudents(dep) {
  const { items, loading, reload } = useCollection(listStudents, "profiles", dep);
  return { students: items, loading, reloadStudents: reload };
}

function useTariffs(dep) {
  const { items, reload } = useCollection(listTariffs, "tariffs", dep);
  return { tariffs: items, reloadTariffs: reload };
}
function useVehicleHistory(dep) {
  const { items, reload } = useCollection(listVehicleHistory, "vehicle_history", dep);
  const addVh    = useCallback(async (v) => { const r = await insertVehicleHistory(v); reload(); return r; }, [reload]);
  const editVh   = useCallback(async (id, patch) => { const r = await updateVehicleHistory(id, patch); reload(); return r; }, [reload]);
  const removeVh = useCallback(async (id) => { await deleteVehicleHistory(id); reload(); }, [reload]);
  return { vehicleHistory: items, addVh, editVh, removeVh };
}
function useDocuments(dep) {
  const { items, loading, reload } = useCollection(listDocuments, "documents", dep);
  const addDocument = useCallback(async (o) => { const r = await insertDocument(o); reload(); return r; }, [reload]);
  const editDocument = useCallback(async (id, patch) => { const r = await updateDocument(id, patch); reload(); return r; }, [reload]);
  const removeDocument = useCallback(async (id) => { await deleteDocument(id); reload(); }, [reload]);
  return { documents: items, loading, addDocument, editDocument, removeDocument };
}

// Session : compte staff connecté → { id, name, role }.
function useSession() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(false);
  useEffect(() => {
    let active = true;
    const loadProfile = async (session) => {
      if (!session) { if (active) { setUser(null); setReady(true); } return; }
      const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
      if (!active) return;
      setUser({
        id: session.user.id,
        name: data?.name || session.user.email,
        role: data?.role || "enseignant",
      });
      setReady(true);
    };
    supabase.auth.getSession().then(({ data }) => loadProfile(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      loadProfile(session);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  return { user, ready, recovery, clearRecovery: () => setRecovery(false) };
}

function useDesktop() {
  const [d, sd] = useState(window.innerWidth >= 1024);
  useEffect(() => {
    const f = () => sd(window.innerWidth >= 1024);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return d;
}

// ── CSV Export ──
function csvExport(rows, fname) {
  const csv = rows.map(r => r.map(c => `"${String(c == null ? "" : c).replace(/"/g,'""')}"`).join(";")).join("\n");
  const b = new Blob(["\ufeff"+csv], { type:"text/csv;charset=utf-8;" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = fname; a.click();
}
function toCSV(orders) {
  const H = ["N° OR","Réf.","Immat.","Marque","Modèle","Année","KM","Type","Client/Enseignant","Élèves","Motif","Date d'entrée","Heure","Date de sortie","Statut","Tâches OK","Tâches total","Observations","Ventes add.","Signature accord","Créé par",
             "VE/VH","Énergie","VIN","Type d'opération","Consignation","Déconsignation"];
  return [H, ...orders.map(o => [
    o.orderNum, o.fileRef||"", o.plate, o.brand, o.model, o.year||"", o.km||"",
    o.vtype==="peda"?"Pédagogique":"Client",
    o.vtype==="client"?(o.clientName||""):(o.teacher||""),
    o.students||"", o.reason||"", fD(o.entryDate), o.entryTime||"", fD(o.exitDate),
    VS[o.status]?VS[o.status].label:"",
    o.tasks?o.tasks.filter(t=>t.done).length:0, o.tasks?o.tasks.length:0,
    o.observations||"", o.additionalSales||"", o.signature?"Oui":"Non", o.createdBy||"",
    o.ev?"Oui":"Non", o.ev?.energy||"", o.ev?.vin||"", o.ev?evOp(o.ev.opType).l:"",
    o.ev?evWhen(evStep(o.ev,"consign")):"", o.ev?evWhen(evStep(o.ev,"deconsign")):""
  ])];
}

// ── PDF ──
function orderHTML(order) {
  const isPeda = order.vtype === "peda";
  const sLabel = VS[order.status] ? VS[order.status].label : "En attente";
  const sColor = order.status==="termine" ? "#065f46" : order.status==="en_cours" ? "#1e40af" : "#92400e";
  const sBg    = order.status==="termine" ? "#d1fae5" : order.status==="en_cours" ? "#dbeafe" : "#fef3c7";
  const ev = order.ev || null;
  const tasksHTML = ev
    ? `<table class="wk"><thead><tr><th class="c" style="width:9%">Rep.</th><th>Désignation des travaux</th><th class="c" style="width:17%">Temps estimé</th><th class="r" style="width:17%">Montant HT</th></tr></thead><tbody>${
        (order.tasks||[]).map((t,i) =>
          `<tr${i%2?' style="background:#f9f9f9"':''}><td class="c">${i+1}</td><td>${t.done?'<span class="ok">&#10003;</span> ':""}${esc(t.label)}${t.done&&t.doneBy?` <span class="tby">(${esc(t.doneBy)})</span>`:""}</td><td class="c">${esc(t.est||"")}</td><td class="r">${t.amount?eur(t.amount):""}</td></tr>`
        ).join("") || `<tr><td colspan="4" style="color:#999">Aucun travail demandé</td></tr>`
      }</tbody></table>`
    : `<div class="tasks">${(order.tasks||[]).map((t,i) =>
        `<div class="ti${i%2===1?" odd":""}"><div class="cb${t.done?" ck":""}">${t.done?"&#10003;":""}</div><span${t.done?" class=\"td\"":" "}>${esc(t.label)}</span>${t.done&&t.doneBy?`<span class="tby">${esc(t.doneBy)}</span>`:""}</div>`
      ).join("")}</div>`;
  // §5 de la trame : type d'opération + traçabilité de la mise en sécurité électrique
  const evBlock = !ev ? "" : (() => {
    const cell = (on) => `<td class="oc${on?" on":""}">${on?"&#10003;":""}</td>`;
    const rows = EV_STEPS.map(st => {
      const v = evStep(ev, st.id);
      const who = st.who ? `<b>${esc(v.name||"………………………………")}</b> ` : "";
      return `<tr><td class="el">${esc(st.lbl)}</td><td>${who}${esc(st.txt)}</td>`
        + `<td class="c">${v.date?fD(v.date):"…… / …… / ……"}${v.time?"<br>à "+esc(v.time):""}</td>`
        + `<td class="c vz">${esc(v.visa||"")}</td></tr>`;
    }).join("");
    return `<div class="sec"><div class="sh">Type d'opération pour véhicule électrique ou hybride</div>
      <table class="opt"><thead>
        <tr><th rowspan="2" style="width:25%">Opération non électrique</th><th colspan="3">Opération électrique</th></tr>
        <tr><th style="width:25%">Hors tension</th><th style="width:25%">Au voisinage</th><th style="width:25%">Sous tension</th></tr></thead>
        <tbody><tr>${cell(ev.opType==="non_elec")}${cell(ev.opType==="hors_tension")}${cell(ev.opType==="voisinage")}${cell(ev.opType==="sous_tension")}</tr></tbody></table>
      <table class="trc"><thead><tr><th style="width:24%">Étape</th><th>Attestation</th><th class="c" style="width:19%">Date / Heure</th><th class="c" style="width:13%">Visa</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  })();
  // §6 de la trame : engagement et accord (montant annoncé, restitution)
  const engBlock = !ev ? "" : `<div class="sec"><div class="sh">Engagement et accord</div><div class="grid g3">
      <div><div class="lb">Montant prévisionnel annoncé</div><div class="vl">${ev.quoteAmount?esc(ev.quoteAmount)+" € TTC":"—"}</div></div>
      <div><div class="lb">Restitution convenue le</div><div class="vl">${ev.returnDate?fD(ev.returnDate):"—"}${ev.returnTime?" à "+esc(ev.returnTime):""}</div></div>
      <div><div class="lb">Dépassement</div><div class="vl" style="font-weight:normal;">Rappel du client avant tout dépassement</div></div>
    </div></div>`;
  const sigHTML = order.signature
    ? `<img src="${order.signature}" style="max-height:72px;max-width:100%;display:block;margin:auto;"/>`
    : `<div style="font-size:11px;color:#bbb;text-align:center;line-height:80px;">Non signée</div>`;
  const exitBlock = order.exitDate ? `
    <div class="sec"><div class="sh">Sortie du véhicule</div>
      <div class="grid g3">
        <div><div class="lb">Date de sortie</div><div class="vl">${fD(order.exitDate)}</div></div>
        <div><div class="lb">Heure de sortie</div><div class="vl">${esc(order.exitTime||"—")}</div></div>
        <div><div class="lb">État</div><div class="vl">${esc(order.exitCondition||"—")}</div></div>
      </div>
    </div>` : "";
  const personBlock = isPeda ? `
    <div class="sec"><div class="sh">BTS MV – Affectation pédagogique</div>
      <div class="grid g2">
        <div><div class="lb">Enseignant responsable</div><div class="vl">${esc(order.teacher||"—")}</div></div>
        <div><div class="lb">Élèves affectés</div><div class="vl">${esc(order.students||"—")}</div></div>
      </div>
    </div>` : `
    <div class="sec"><div class="sh">Client</div>
      <div class="grid g2">
        <div><div class="lb">Nom du client</div><div class="vl">${esc(order.clientName||"—")}</div></div>
        <div><div class="lb">Téléphone</div><div class="vl">${esc(order.clientPhone||"—")}</div></div>
      </div>${ev?`
      <div class="grid g3" style="margin-top:6px;">
        <div><div class="lb">Adresse</div><div class="vl">${esc(ev.clientAddress||"—")}</div></div>
        <div><div class="lb">Adresse électronique</div><div class="vl">${esc(ev.clientEmail||"—")}</div></div>
        <div><div class="lb">Moyen de contact retenu</div><div class="vl">${esc(ev.clientContact||"—")}</div></div>
      </div>`:""}
    </div>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(order.orderNum)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;}.page{padding:12mm 15mm;max-width:210mm;margin:0 auto;}.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:10px;margin-bottom:14px;}.bn{font-size:20px;font-weight:bold;color:#1d4ed8;}.bs{font-size:10px;color:#555;margin-top:2px;}.on{font-size:22px;font-weight:bold;color:#1d4ed8;text-align:right;}.om{font-size:10px;color:#555;text-align:right;margin-top:2px;}.sec{margin-bottom:10px;}.sh{background:#1d4ed8;color:#fff;padding:4px 10px;font-size:11px;font-weight:bold;margin-bottom:6px;}.grid{display:grid;gap:6px 10px;}.g2{grid-template-columns:1fr 1fr;}.g3{grid-template-columns:1fr 1fr 1fr;}.g5{grid-template-columns:repeat(5,1fr);}.lb{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;}.vl{font-size:12px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;min-height:17px;}.bdg{display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:bold;}.tasks{display:grid;grid-template-columns:1fr 1fr;gap:0;}.ti{display:flex;align-items:center;gap:6px;padding:4px 5px;border-bottom:1px dotted #e5e5e5;font-size:11px;}.ti.odd{background:#f9f9f9;}.cb{width:13px;height:13px;border:1.5px solid #555;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;font-weight:bold;}.ck{border-color:#059669;background:#d1fae5;color:#059669;}.td{color:#059669;text-decoration:line-through;}.tby{margin-left:auto;font-size:9px;color:#888;white-space:nowrap;}.tb{border:1px solid #ddd;padding:6px 8px;min-height:52px;font-size:11px;line-height:1.5;white-space:pre-wrap;}.sr{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;padding-top:12px;border-top:2px solid #1d4ed8;}.sl{font-size:10px;color:#333;font-weight:bold;margin-bottom:5px;}.sb{border:1px solid #999;height:82px;display:flex;align-items:center;justify-content:center;background:#fafafa;overflow:hidden;}.sn{font-size:9px;color:#888;text-align:center;margin-top:3px;}.foot{margin-top:14px;padding-top:8px;border-top:1px solid #ddd;font-size:9px;color:#aaa;text-align:center;}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}.warn{border:1.5px solid #b91c1c;background:#fef2f2;color:#b91c1c;padding:6px 10px;font-size:10.5px;font-weight:bold;margin-bottom:10px;}table.opt,table.trc,table.wk{width:100%;border-collapse:collapse;font-size:10.5px;}table.opt th,table.trc th,table.wk th{background:#1d4ed8;color:#fff;padding:4px 6px;font-size:9.5px;text-align:left;border:1px solid #1d4ed8;}table.opt td,table.trc td,table.wk td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;}table.opt{margin-bottom:6px;}table.opt th{text-align:center;}.oc{height:24px;text-align:center;font-size:15px;font-weight:bold;color:#111;}.oc.on{background:#dbeafe;color:#1d4ed8;}.trc .el{font-weight:bold;background:#f4f7ff;}.trc .vz{background:#fafafa;}td.c,th.c{text-align:center;}td.r,th.r{text-align:right;}.wk .ok{color:#059669;font-weight:bold;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.page{padding:8mm 12mm;}}</style>
</head><body><div class="page">
<div class="hdr"><div><div class="bn">Lycée Gallieni</div><div class="bs">Atelier BTS Maintenance des Véhicules</div><div class="bs" style="font-weight:bold;margin-top:5px;font-size:12px;">ORDRE DE RÉPARATION${ev?" – VÉHICULE ÉLECTRIQUE / HYBRIDE":""}</div></div>
<div><div class="on">${esc(order.orderNum)}</div><div class="om">Réf. dossier : ${esc(order.fileRef||"—")}</div><div class="om">Entrée le ${fD(order.entryDate)} à ${esc(order.entryTime||"—")}</div><div class="om">Créé par : ${esc(order.createdBy||"—")}</div>
<div class="om" style="margin-top:5px;"><span style="background:${sBg};color:${sColor};padding:2px 10px;border-radius:20px;font-size:10px;font-weight:bold;">${sLabel}</span></div></div></div>
<div class="sec"><div class="sh">Véhicule</div><div class="grid g5">
<div><div class="lb">Immatriculation</div><div class="vl" style="font-size:14px;">${esc(order.plate)}</div></div>
<div><div class="lb">Marque</div><div class="vl">${esc(order.brand)}</div></div>
<div><div class="lb">Modèle</div><div class="vl">${esc(order.model)}</div></div>
<div><div class="lb">Année</div><div class="vl">${esc(order.year||"—")}</div></div>
<div><div class="lb">Kilométrage</div><div class="vl">${order.km?esc(order.km)+" km":"—"}</div></div></div>${ev?`
<div class="grid g3" style="margin-top:6px;">
<div><div class="lb">Énergie (repère P.3)</div><div class="vl">${esc(ev.energy||"—")}</div></div>
<div><div class="lb">VIN – 17 caractères (repère E)</div><div class="vl">${esc(ev.vin||"—")}</div></div>
<div><div class="lb">1re immatriculation (repère B)</div><div class="vl">${ev.firstReg?fD(ev.firstReg):"—"}</div></div></div>`:""}
<div style="margin-top:7px;"><span class="bdg" style="background:${isPeda?"#ffedd5":"#dbeafe"};color:${isPeda?"#9a3412":"#1e40af"};">${isPeda?"🎓 Véhicule pédagogique":"👤 Véhicule client"}</span>${ev?`<span class="bdg" style="background:#fef9c3;color:#a16207;margin-left:6px;">⚡ Véhicule électrique / hybride</span>`:""}</div></div>
${ev&&ev.opType!=="non_elec"?`<div class="warn">⚠ Opération sur le circuit haute tension : la batterie de traction doit être mise en sécurité (consignation) par un chargé de consignation BCL avant toute intervention.</div>`:""}
${personBlock}
<div class="sec"><div class="sh">Motif d'entrée / Réclamation</div><div class="tb">${esc(order.reason||"—")}</div></div>
<div class="sec"><div class="sh">Travaux ${ev?"demandés":"à réaliser"}</div>${tasksHTML}</div>
${evBlock}
<div class="twocol">
<div class="sec"><div class="sh">Observations à signaler au client</div><div class="tb">${esc(order.observations||"—")}</div></div>
<div class="sec"><div class="sh">Ventes additionnelles prévues</div><div class="tb">${esc(order.additionalSales||"—")}</div></div>
</div>
${exitBlock}
${engBlock}
<div class="sr">
<div><div class="sl">Signature du client${ev?", précédée de la mention « bon pour accord »":" (accord pour les travaux)"}</div><div class="sb">${sigHTML}</div><div class="sn">${esc(order.clientName||(isPeda?order.teacher||"":""))}</div></div>
<div><div class="sl">${ev?"Nom et signature du réceptionnaire":"Visa du technicien / enseignant"}</div><div class="sb"><div style="font-size:11px;color:#ccc;text-align:center;line-height:80px;">..................................</div></div><div class="sn">${isPeda?esc(order.teacher||""):""}</div></div>
</div>
<div class="foot">Lycée Gallieni – BTS Maintenance des Véhicules &nbsp;|&nbsp; ${esc(order.orderNum)} &nbsp;|&nbsp; Imprimé le ${new Date().toLocaleDateString("fr-FR")}</div>
</div></body></html>`;
  return html;
}

// Dossier de destination sur le Drive : nom du client, ou « Pédagogique ».
function orderFolder(order) {
  return order.vtype === "peda" ? "Pédagogique" : (order.clientName || "").trim() || "Client sans nom";
}

function generatePDF(order) {
  const html = orderHTML(order);
  try {
    const blob = new Blob([html], { type:"text/html;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (w) { setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 800); }
    else { const a = document.createElement("a"); a.href = url; a.download = order.orderNum+".html"; a.click(); }
  } catch { alert("Impossible d'ouvrir la fenêtre d'impression. Vérifiez les fenêtres surgissantes."); }
}

// ── PDF Estimation / Facture ──
function docHTML(doc) {
  const isEst = doc.kind === "estimate";
  const t = docTotals(doc);
  const rows = (doc.items||[]).map((it,i)=>{
    const lt=(Number(it.qty)||0)*(Number(it.unitPrice)||0);
    return `<tr${i%2?' style="background:#f9f9f9"':''}><td>${esc(it.label||"")}</td><td class="r">${esc(qte(it.qty))}${it.unit?" "+esc(it.unit):""}</td><td class="r">${eur(it.unitPrice)}</td><td class="r">${eur(lt)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#999">Aucune ligne</td></tr>`;
  const sigBlock = isEst ? `<div class="sr">
    <div><div class="sl">Bon pour accord — Signature du client</div><div class="sb">${doc.signature?`<img src="${doc.signature}" style="max-height:72px;max-width:100%;display:block;margin:auto;"/>`:`<div style="color:#bbb;line-height:80px;text-align:center;font-size:11px;">Non signée</div>`}</div><div class="sn">${esc(doc.clientName||"")}</div></div>
    <div><div class="sl">Cachet / Visa atelier</div><div class="sb"></div></div></div>` : "";
  const dateLine = isEst
    ? (doc.validUntil?`<div class="om">Valable jusqu'au ${fD(doc.validUntil)}</div>`:"")
    : (doc.validUntil?`<div class="om">Échéance : ${fD(doc.validUntil)}</div>`:"");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.docNum||"")}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;}.page{padding:12mm 15mm;max-width:210mm;margin:0 auto;}.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:10px;margin-bottom:14px;}.bn{font-size:20px;font-weight:bold;color:#1d4ed8;}.bs{font-size:10px;color:#555;margin-top:2px;}.on{font-size:22px;font-weight:bold;color:#1d4ed8;text-align:right;}.om{font-size:10px;color:#555;text-align:right;margin-top:2px;}.sec{margin-bottom:10px;}.sh{background:#1d4ed8;color:#fff;padding:4px 10px;font-size:11px;font-weight:bold;margin-bottom:6px;}.grid{display:grid;gap:6px 10px;}.g2{grid-template-columns:1fr 1fr;}.vl{font-size:13px;font-weight:bold;}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}th{background:#1d4ed8;color:#fff;text-align:left;padding:5px 8px;font-size:10px;white-space:nowrap;}td{padding:5px 8px;border-bottom:1px solid #eee;}td.r,th.r{text-align:right;white-space:nowrap;}.tot{margin-top:10px;margin-left:auto;width:55%;}.tot div{display:flex;justify-content:space-between;padding:3px 8px;font-size:12px;}.tot .ttc{background:#1d4ed8;color:#fff;font-weight:bold;font-size:13px;border-radius:4px;}.tb{border:1px solid #ddd;padding:6px 8px;min-height:40px;font-size:11px;white-space:pre-wrap;}.sr{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;padding-top:12px;border-top:2px solid #1d4ed8;}.sl{font-size:10px;color:#333;font-weight:bold;margin-bottom:5px;}.sb{border:1px solid #999;height:82px;background:#fafafa;overflow:hidden;}.sn{font-size:9px;color:#888;text-align:center;margin-top:3px;}.foot{margin-top:14px;padding-top:8px;border-top:1px solid #ddd;font-size:9px;color:#aaa;text-align:center;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style>
</head><body><div class="page">
<div class="hdr"><div><div class="bn">Lycée Gallieni</div><div class="bs">Atelier BTS Maintenance des Véhicules</div><div class="bs" style="font-weight:bold;margin-top:5px;font-size:13px;">${isEst?"DEVIS / ESTIMATION":"FACTURE"}</div></div>
<div><div class="on">${esc(doc.docNum||"")}</div><div class="om">Date : ${fD(doc.createdAt||today())}</div>${dateLine}<div class="om">Établi par : ${esc(doc.createdBy||"—")}</div></div></div>
<div class="grid g2">
<div class="sec"><div class="sh">Client</div><div class="vl">${esc(doc.clientName||"—")}</div><div class="bs">${esc(doc.clientPhone||"")}</div></div>
<div class="sec"><div class="sh">Véhicule</div><div class="vl">${esc(doc.plate||"—")}</div><div class="bs">${esc(doc.brand||"")} ${esc(doc.model||"")} ${doc.year?"("+esc(doc.year)+")":""} ${doc.km?"· "+esc(doc.km)+" km":""}</div></div></div>
<div class="sec"><div class="sh">Détail des prestations</div>
<table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">PU${isTTC(doc)?(num(doc.tvaRate)?" TTC":""):" HT"}</th><th class="r">Total${isTTC(doc)?(num(doc.tvaRate)?" TTC":""):" HT"}</th></tr></thead><tbody>${rows}</tbody></table>
${isTTC(doc)&&num(doc.tvaRate)?`<div style="font-size:9.5px;color:#666;margin-top:4px;">Prix indiqués toutes taxes comprises.</div>`:""}
<div class="tot">${num(doc.tvaRate)?`<div><span>Total HT</span><span>${eur(t.ht)}</span></div><div><span>TVA (${esc(String(doc.tvaRate??0))} %)</span><span>${eur(t.tva)}</span></div>`:`<div><span>TVA non applicable - 0%</span><span>${eur(0)}</span></div>`}<div class="ttc"><span>Total${num(doc.tvaRate)?" TTC":""}</span><span>${eur(t.ttc)}</span></div></div></div>
${doc.notes?`<div class="sec"><div class="sh">Notes</div><div class="tb">${esc(doc.notes)}</div></div>`:""}
${sigBlock}
<div class="foot">Lycée Gallieni – BTS Maintenance des Véhicules &nbsp;|&nbsp; ${esc(doc.docNum||"")} &nbsp;|&nbsp; Imprimé le ${new Date().toLocaleDateString("fr-FR")}</div>
</div></body></html>`;
}
function generateDocPDF(doc){
  const html=docHTML(doc);
  try{ const blob=new Blob([html],{type:"text/html;charset=utf-8;"}); const url=URL.createObjectURL(blob); const w=window.open(url,"_blank");
    if(w){setTimeout(()=>{try{w.print();}catch{/* ignore */}},800);} else {const a=document.createElement("a");a.href=url;a.download=(doc.docNum||"document")+".html";a.click();}
  }catch{ alert("Impossible d'ouvrir l'impression. Vérifiez les fenêtres surgissantes."); }
}
function archiveDocToDrive(doc,notify){
  archiveOrder({ html:docHTML(doc), folder:(doc.clientName||"").trim()||"Client sans nom", orderNum:doc.docNum })
    .then(()=>notify&&notify("Document archivé sur le Drive"))
    .catch(e=>{console.error("[DMS] archive doc",e);notify&&notify("Archivage Drive non effectué : "+(e.message||e),"error");});
}

// ── UI primitives ──
function Btn({ children, onClick, disabled, sm, ghost, danger, full, style: ex }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: sm?"5px 12px":"9px 18px", borderRadius:7, cursor: disabled?"not-allowed":"pointer",
      fontSize: sm?12:14, fontWeight:500, width: full?"100%":undefined, opacity: disabled?0.5:1,
      background: ghost?"transparent":danger?"#dc2626":C.acc, color: ghost?C.sub:"#fff",
      border: ghost?"1px solid "+C.bdr:"none", transition:"opacity .15s", ...(ex||{})
    }}>{children}</button>
  );
}
function Badge({ status }) {
  const m = VS[status]||VS.en_attente;
  return <span style={{ background:m.col+"22", color:m.col, border:"1px solid "+m.col+"44", padding:"2px 10px", borderRadius:999, fontSize:12, fontWeight:600 }}>{m.label}</span>;
}
function Inp({ label, value, onChange, type, placeholder, readOnly, style: ex }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      {label && <label style={{ fontSize:12, color:C.sub, fontWeight:500 }}>{label}</label>}
      <input type={type||"text"} value={value} onChange={e => onChange&&onChange(e.target.value)}
        placeholder={placeholder} readOnly={readOnly}
        style={{ background:"#f1f5f9", border:"1px solid "+C.bdr, borderRadius:6, padding:"8px 10px", color:readOnly?C.mut:C.txt, fontSize:13, outline:"none", ...(ex||{}) }}/>
    </div>
  );
}
function Sel({ label, value, onChange, opts }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      {label && <label style={{ fontSize:12, color:C.sub, fontWeight:500 }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ background:"#f1f5f9", border:"1px solid "+C.bdr, borderRadius:6, padding:"8px 10px", color:C.txt, fontSize:13, outline:"none" }}>
        {opts.map(o => <option key={o.v!=null?o.v:o} value={o.v!=null?o.v:o}>{o.l!=null?o.l:o}</option>)}
      </select>
    </div>
  );
}
function TA({ label, value, onChange, onBlur, placeholder, rows, readOnly }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      {label && <label style={{ fontSize:12, color:C.sub, fontWeight:500 }}>{label}</label>}
      <textarea value={value} onChange={e => onChange&&onChange(e.target.value)} onBlur={onBlur||undefined} rows={rows||3}
        placeholder={placeholder} readOnly={readOnly}
        style={{ background:"#f1f5f9", border:"1px solid "+C.bdr, borderRadius:6, padding:"8px 10px", color:C.txt, fontSize:13, outline:"none", resize:"vertical", fontFamily:"inherit" }}/>
    </div>
  );
}
function Crd({ children, style: ex }) {
  return <div style={{ background:C.card, borderRadius:12, padding:16, border:"1px solid "+C.bdr, ...(ex||{}) }}>{children}</div>;
}
function SecTitle({ children }) {
  return <h3 style={{ color:"#2563eb", fontSize:13, fontWeight:700, margin:"16px 0 10px", paddingBottom:6, borderBottom:"1px solid "+C.bdr }}>{children}</h3>;
}

function SigPad({ onSave, init }) {
  const cv = useRef(); const dr = useRef(false);
  const [has, sh] = useState(!!init);
  useEffect(() => {
    if (init && cv.current) {
      const img = new Image();
      img.onload = () => { if (cv.current) cv.current.getContext("2d").drawImage(img,0,0); sh(true); };
      img.src = init;
    }
  }, []);
  const getPos = (e) => {
    const r=cv.current.getBoundingClientRect(), sx=cv.current.width/r.width, sy=cv.current.height/r.height;
    const s=e.touches?e.touches[0]:e;
    return [(s.clientX-r.left)*sx, (s.clientY-r.top)*sy];
  };
  const dn=(e)=>{e.preventDefault();dr.current=true;const[x,y]=getPos(e);const ctx=cv.current.getContext("2d");ctx.beginPath();ctx.moveTo(x,y);};
  const mv=(e)=>{if(!dr.current)return;e.preventDefault();const[x,y]=getPos(e);const ctx=cv.current.getContext("2d");ctx.strokeStyle="#1e3a8a";ctx.lineWidth=2;ctx.lineCap="round";ctx.lineTo(x,y);ctx.stroke();sh(true);};
  const up=(e)=>{e.preventDefault();dr.current=false;};
  return (
    <div>
      <canvas ref={cv} width={500} height={130}
        style={{ width:"100%", background:"#fff", borderRadius:8, cursor:"crosshair", touchAction:"none", border:"2px solid "+C.bdr, display:"block" }}
        onMouseDown={dn} onMouseMove={mv} onMouseUp={up} onMouseLeave={up}
        onTouchStart={dn} onTouchMove={mv} onTouchEnd={up}/>
      <div style={{ display:"flex", gap:8, marginTop:6 }}>
        <Btn sm ghost onClick={() => { cv.current.getContext("2d").clearRect(0,0,500,130); sh(false); if(onSave) onSave(""); }}>Effacer</Btn>
        <Btn sm disabled={!has} onClick={() => { if(onSave) onSave(cv.current.toDataURL()); }}>Valider la signature</Btn>
      </div>
    </div>
  );
}

// URL de retour des emails Supabase (respecte le base path GitHub Pages).
const APP_URL = window.location.origin + import.meta.env.BASE_URL;

function AuthCard({ children }) {
  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:C.bg, padding:16 }}>
      <div style={{ background:C.card, borderRadius:16, padding:32, width:"100%", maxWidth:380, border:"1px solid "+C.bdr, boxShadow:"0 12px 40px rgba(37,99,235,.15)" }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <img src={LOGO} alt="DMS Atelier BTS MV – Lycée Gallieni" style={{ width:104, height:104, borderRadius:"50%", display:"block", margin:"0 auto 12px" }}/>
          <h1 style={{ color:C.txt, fontSize:22, fontWeight:700, margin:0 }}>DMS – Atelier BTS MV</h1>
          <p style={{ color:C.mut, fontSize:13, marginTop:6 }}>Lycée Gallieni</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginView() {
  const [mode,setMode]=useState("login"); // "login" | "forgot"
  const [u,su]=useState(""); const [p,sp]=useState(""); const [err,se]=useState(""); const [msg,sm]=useState(""); const [busy,sb]=useState(false);
  const go=async()=>{
    se(""); sb(true);
    const { error } = await supabase.auth.signInWithPassword({ email: toLoginEmail(u), password: p });
    sb(false);
    if (error) se("Identifiants incorrects");
    // En cas de succès, onAuthStateChange (useSession) bascule l'application.
  };
  const sendReset=async()=>{
    se(""); sm("");
    if(!u.trim()){se("Saisis ton e-mail");return;}
    sb(true);
    const { error } = await supabase.auth.resetPasswordForEmail(u.trim(), { redirectTo: APP_URL });
    sb(false);
    if(error){se(error.message);return;}
    sm("Si un compte existe pour cet e-mail, un lien de réinitialisation vient d'être envoyé.");
  };
  if(mode==="forgot")return(
    <AuthCard>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }} onKeyDown={e=>{if(e.key==="Enter"&&!busy)sendReset();}}>
        <p style={{ color:C.sub, fontSize:13, margin:0 }}>Saisis ton e-mail : tu recevras un lien pour définir un nouveau mot de passe.</p>
        <Inp label="E-mail" value={u} onChange={su} type="email" placeholder="prenom.nom@exemple.fr"/>
        {err && <p style={{ color:"#f87171", fontSize:13, textAlign:"center", margin:0 }}>{err}</p>}
        {msg && <p style={{ color:"#059669", fontSize:13, textAlign:"center", margin:0 }}>{msg}</p>}
        <Btn full onClick={sendReset} disabled={busy}>{busy?"Envoi…":"Envoyer le lien"}</Btn>
        <button onClick={()=>{setMode("login");se("");sm("");}} style={{ background:"none", border:"none", color:"#2563eb", cursor:"pointer", fontSize:13 }}>← Retour à la connexion</button>
      </div>
    </AuthCard>
  );
  return (
    <AuthCard>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }} onKeyDown={e=>{if(e.key==="Enter"&&!busy)go();}}>
        <Inp label="E-mail (staff) ou nom complet (élève)" value={u} onChange={su} placeholder="prenom.nom@… ou Jean Martin"/>
        <Inp label="Mot de passe" value={p} onChange={sp} type="password" placeholder="••••••••"/>
        {err && <p style={{ color:"#f87171", fontSize:13, textAlign:"center", margin:0 }}>{err}</p>}
        <Btn full onClick={go} disabled={busy}>{busy?"Connexion…":"Se connecter"}</Btn>
        <button onClick={()=>{setMode("forgot");se("");sm("");}} style={{ background:"none", border:"none", color:"#2563eb", cursor:"pointer", fontSize:13 }}>Mot de passe oublié ? (staff)</button>
      </div>
      <div style={{ marginTop:20, padding:12, background:"#f1f5f9", borderRadius:8, fontSize:12, color:C.mut, textAlign:"center" }}>
        Staff : e-mail + mot de passe · Élèves : nom complet + mot de passe.
      </div>
    </AuthCard>
  );
}

// Écran de définition d'un nouveau mot de passe (après clic sur le lien email).
function ResetPasswordView({ notify, onDone }) {
  const [p,sp]=useState(""); const [p2,sp2]=useState(""); const [err,se]=useState(""); const [busy,sb]=useState(false);
  const go=async()=>{
    se("");
    if(p.length<6){se("6 caractères minimum");return;}
    if(p!==p2){se("Les deux mots de passe ne correspondent pas");return;}
    sb(true);
    const { error } = await supabase.auth.updateUser({ password:p });
    sb(false);
    if(error){se(error.message);return;}
    notify("Mot de passe modifié. Reconnecte-toi.");
    onDone();
  };
  return (
    <AuthCard>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }} onKeyDown={e=>{if(e.key==="Enter"&&!busy)go();}}>
        <p style={{ color:C.sub, fontSize:13, margin:0 }}>Définis ton nouveau mot de passe.</p>
        <Inp label="Nouveau mot de passe" value={p} onChange={sp} type="password" placeholder="••••••••"/>
        <Inp label="Confirmer" value={p2} onChange={sp2} type="password" placeholder="••••••••"/>
        {err && <p style={{ color:"#f87171", fontSize:13, textAlign:"center", margin:0 }}>{err}</p>}
        <Btn full onClick={go} disabled={busy}>{busy?"Enregistrement…":"Modifier le mot de passe"}</Btn>
      </div>
    </AuthCard>
  );
}

const NAV = [
  { id:"dashboard", ico:"📊", lbl:"Tableau de bord" },
  { id:"orders",    ico:"🔧", lbl:"Ordres de réparation" },
  { id:"vehicles",  ico:"🚙", lbl:"Historique véhicules" },
  { id:"estimates", ico:"🧾", lbl:"Estimations" },
  { id:"invoices",  ico:"💶", lbl:"Factures" },
  { id:"history",   ico:"📋", lbl:"Historique" },
  { id:"admin",     ico:"⚙️", lbl:"Administration", staff:true },
  { id:"account",   ico:"👤", lbl:"Mon compte", staff:true },
];
function Sidebar({ user, page, nav, logout }) {
  const isStaff = user.role !== "eleve";
  const rs = ROLE_STYLE[user.role]||{ bg:"#e2e8f0", cl:C.sub };
  return (
    <div style={{ width:220, background:C.side, borderRight:"1px solid "+C.bdr, display:"flex", flexDirection:"column", height:"100vh", flexShrink:0 }}>
      <div style={{ padding:"20px 16px 16px", borderBottom:"1px solid "+C.bdr }}>
        <div style={{ color:"#3b82f6", fontWeight:700, fontSize:14, marginBottom:8, display:"flex", alignItems:"center", gap:8 }}><img src={LOGO} alt="" style={{ width:26, height:26, borderRadius:"50%", flexShrink:0 }}/>DMS Gallieni</div>
        <div style={{ color:C.txt, fontSize:13, fontWeight:600 }}>{user.name}</div>
        <span style={{ fontSize:11, padding:"2px 8px", borderRadius:999, fontWeight:600, marginTop:4, display:"inline-block", background:rs.bg, color:rs.cl }}>{roleLabel(user.role)}</span>
      </div>
      <nav style={{ flex:1, padding:"12px 8px", display:"flex", flexDirection:"column", gap:2 }}>
        {NAV.filter(n => !n.staff||isStaff).map(n => (
          <button key={n.id} onClick={() => nav(n.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:8, border:"none", cursor:"pointer", textAlign:"left", fontSize:14, fontWeight:page===n.id?600:400, background:page===n.id?C.acc:"transparent", color:page===n.id?"#fff":C.sub }}>
            <span>{n.ico}</span>{n.lbl}
          </button>
        ))}
      </nav>
      <div style={{ padding:"12px 8px", borderTop:"1px solid "+C.bdr }}>
        <button onClick={logout} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:8, border:"none", cursor:"pointer", width:"100%", background:"transparent", color:C.sub, fontSize:14 }}>
          🚪 Déconnexion
        </button>
      </div>
    </div>
  );
}

function Dashboard({ orders, nav, selOrd }) {
  const active = orders.filter(o => o.status !== "termine");
  const stats = [
    { l:"En atelier",   v:active.length,                                              c:"#2563eb" },
    { l:"En attente",   v:orders.filter(o=>o.status==="en_attente").length,            c:"#f59e0b" },
    { l:"En cours",     v:orders.filter(o=>o.status==="en_cours").length,              c:"#3b82f6" },
    { l:"Terminés",     v:orders.filter(o=>o.status==="termine").length,               c:"#059669" },
    { l:"Clients",      v:active.filter(o=>o.vtype==="client").length,                 c:"#a78bfa" },
    { l:"Pédagogiques", v:active.filter(o=>o.vtype==="peda").length,                  c:"#fb923c" },
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <h2 style={{ color:C.txt, fontSize:20, fontWeight:700, margin:0 }}>📊 Tableau de bord</h2>
        <Btn onClick={() => nav("new-order")}>+ Nouvel ordre de réparation</Btn>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
        {stats.map(s => <Crd key={s.l} style={{ textAlign:"center" }}><div style={{ fontSize:34, fontWeight:700, color:s.c }}>{s.v}</div><div style={{ fontSize:12, color:C.sub, marginTop:4 }}>{s.l}</div></Crd>)}
      </div>
      <div>
        <h3 style={{ color:C.txt, fontSize:16, fontWeight:600, marginBottom:12 }}>🚗 Véhicules en atelier</h3>
        {active.length===0
          ? <Crd><p style={{ color:C.mut, textAlign:"center", margin:0 }}>Aucun véhicule en atelier</p></Crd>
          : <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))", gap:12 }}>
              {active.map(o => <OrdCard key={o.id} o={o} onClick={() => { selOrd(o.id); nav("order-detail"); }}/>)}
            </div>
        }
      </div>
    </div>
  );
}
function OrdCard({ o, onClick }) {
  const dn=o.tasks?o.tasks.filter(t=>t.done).length:0, tot=o.tasks?o.tasks.length:0;
  const isPeda = o.vtype==="peda";
  return (
    <div onClick={onClick} style={{ background:C.card, borderRadius:12, padding:16, border:"1px solid "+C.bdr, cursor:"pointer" }}
      onMouseEnter={e => e.currentTarget.style.borderColor="#3b82f6"}
      onMouseLeave={e => e.currentTarget.style.borderColor=C.bdr}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
        <div>
          <div style={{ color:"#3b82f6", fontWeight:700, fontSize:12 }}>{o.orderNum}</div>
          <div style={{ color:C.txt, fontWeight:600, fontSize:15 }}>{o.plate}</div>
          <div style={{ color:C.sub, fontSize:13 }}>{o.brand} {o.model} {o.year?"("+o.year+")":""}</div>
        </div>
        <Badge status={o.status}/>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap" }}>
        <span style={{ fontSize:11, padding:"2px 8px", borderRadius:999, fontWeight:600, background:isPeda?"#ffedd5":"#dbeafe", color:isPeda?"#9a3412":"#1d4ed8" }}>
          {isPeda?"🎓 Pédagogique":"👤 Client"}
        </span>
        {o.ev && <span style={{ fontSize:11, padding:"2px 8px", borderRadius:999, fontWeight:600, background:"#fef9c3", color:"#a16207" }}>⚡ VE/VH</span>}
        {o.km && <span style={{ fontSize:11, color:C.mut }}>📍 {Number(o.km).toLocaleString("fr-FR")} km</span>}
        {o.signature && <span style={{ fontSize:11, color:"#059669" }}>✍ Signé</span>}
      </div>
      {tot>0 && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.mut, marginBottom:3 }}><span>Avancement</span><span>{dn}/{tot}</span></div>
          <div style={{ background:"#e2e8f0", borderRadius:999, height:6, overflow:"hidden" }}>
            <div style={{ width:Math.round(dn/tot*100)+"%", background:"#3b82f6", height:"100%", borderRadius:999 }}/>
          </div>
        </div>
      )}
      <div style={{ marginTop:8, fontSize:11, color:C.mut }}>Entrée : {fD(o.entryDate)}</div>
      {isPeda && o.students && <div style={{ marginTop:4, fontSize:11, color:"#c2410c" }}>👥 {o.students}</div>}
    </div>
  );
}

function OrdersList({ orders, nav, selOrd }) {
  const [flt,sf]=useState("active"); const [q,sq]=useState("");
  const shown = orders.filter(o => {
    const ok = flt==="active"?o.status!=="termine":flt==="all"?true:o.status===flt;
    return ok && (!q||[o.plate,o.brand,o.model,o.clientName,o.orderNum,o.students].join(" ").toLowerCase().includes(q.toLowerCase()));
  });
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <h2 style={{ color:C.txt, fontSize:20, fontWeight:700, margin:0 }}>🔧 Ordres de réparation</h2>
        <Btn onClick={() => nav("new-order")}>+ Nouvel ordre de réparation</Btn>
      </div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        {[["active","Actifs"],["en_attente","En attente"],["en_cours","En cours"],["termine","Terminés"],["all","Tous"]].map(([v,l]) => (
          <button key={v} onClick={() => sf(v)} style={{ padding:"6px 14px", borderRadius:6, cursor:"pointer", fontSize:13, border:"1px solid "+(flt===v?"#2563eb":C.bdr), background:flt===v?C.acc:"transparent", color:flt===v?"#fff":C.sub }}>{l}</button>
        ))}
      </div>
      <input value={q} onChange={e => sq(e.target.value)} placeholder="🔍 Immatriculation, marque, client, n° OR..."
        style={{ background:C.card, border:"1px solid "+C.bdr, borderRadius:8, padding:"10px 14px", color:C.txt, fontSize:13, outline:"none" }}/>
      {shown.length===0
        ? <Crd><p style={{ color:C.mut, textAlign:"center", margin:0 }}>Aucun ordre de réparation</p></Crd>
        : <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {shown.map(o => {
              const isPeda=o.vtype==="peda";
              return (
                <div key={o.id} onClick={() => { selOrd(o.id); nav("order-detail"); }}
                  style={{ background:C.card, borderRadius:10, padding:"13px 16px", border:"1px solid "+C.bdr, cursor:"pointer", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}
                  onMouseEnter={e => e.currentTarget.style.background="#dbeafe"}
                  onMouseLeave={e => e.currentTarget.style.background=C.card}>
                  <div style={{ flex:1, minWidth:180 }}>
                    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:4 }}>
                      <span style={{ color:"#3b82f6", fontWeight:700, fontSize:12 }}>{o.orderNum}</span>
                      <Badge status={o.status}/>
                      <span style={{ fontSize:11, color:isPeda?"#c2410c":"#1d4ed8" }}>{isPeda?"🎓":"👤"}</span>
                      {o.signature && <span style={{ fontSize:11, color:"#059669" }}>✍</span>}
                    </div>
                    <div style={{ color:C.txt, fontWeight:600 }}>{o.plate} – {o.brand} {o.model}</div>
                    <div style={{ color:C.sub, fontSize:12 }}>{isPeda?(o.teacher||"—"):(o.clientName||"—")}</div>
                  </div>
                  <div style={{ textAlign:"right", color:C.mut, fontSize:12 }}>
                    <div>Entrée : {fD(o.entryDate)}</div>
                    <div>{(o.tasks?o.tasks.filter(t=>t.done).length:0)}/{o.tasks?o.tasks.length:0} tâches</div>
                  </div>
                </div>
              );
            })}
          </div>
      }
    </div>
  );
}

// Sélection d'élèves regroupés par classe : un menu déroulant par classe, cases à cocher.
function StudentPicker({ students, selected, onToggle }) {
  const [open, setOpen] = useState({});
  const groups = {};
  (students || []).forEach(s => { const g = s.group || "Sans classe"; (groups[g] = groups[g] || []).push(s); });
  const order = [...CLASSES.filter(c => groups[c]), ...Object.keys(groups).filter(g => !CLASSES.includes(g))];
  if (order.length === 0) return <p style={{ color:C.mut, fontSize:13, margin:0 }}>Aucun élève. Crée des comptes dans Administration → 🎓 Élèves.</p>;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {order.map(g => {
        const list = groups[g];
        const selCount = list.filter(s => selected.includes(s.name)).length;
        const isOpen = !!open[g];
        return (
          <div key={g} style={{ border:"1px solid "+C.bdr, borderRadius:8, overflow:"hidden" }}>
            <button type="button" onClick={() => setOpen(p => ({ ...p, [g]: !p[g] }))}
              style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 12px", background:"#f1f5f9", border:"none", cursor:"pointer", color:C.txt, fontSize:13, fontWeight:600 }}>
              <span>{isOpen ? "▾" : "▸"} {g}</span>
              <span style={{ color: selCount ? "#059669" : C.mut, fontSize:12 }}>{selCount}/{list.length} sélectionné{selCount>1?"s":""}</span>
            </button>
            {isOpen && (
              <div style={{ padding:"6px 12px", display:"flex", flexDirection:"column", gap:2 }}>
                {list.map(s => (
                  <label key={s.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 0", cursor:"pointer", color:C.txt, fontSize:13 }}>
                    <input type="checkbox" checked={selected.includes(s.name)} onChange={() => onToggle(s.name)} />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NewOrderForm({ addOrder, teachers, students, user, nav, selOrd, notify }) {
  const [busy,sbusy] = useState(false);
  const [f,sf] = useState({
    plate:"", brand:"", model:"", year:"", km:"", vtype:"client",
    clientName:"", clientPhone:"", entryDate:today(), entryTime:tNow(),
    reason:"", fileRef:"",
    teacher: user.role==="enseignant"?user.name:"",
    selStu:[], custTask:"", observations:"", additionalSales:"",
    tasks: TASKS0.map(t => ({ id:gid(), label:t, done:false, doneBy:"", doneAt:"", est:"", amount:"" })),
    signature:"",
    ev:null,              // null = OR standard ; objet = OR véhicule électrique/hybride
  });
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  const isEv=!!f.ev;
  const setEv=(k,v)=>sf(p=>({...p,ev:{...p.ev,[k]:v}}));
  const setEvStep=(id,k,v)=>sf(p=>({...p,ev:{...p.ev,steps:{...p.ev.steps,[id]:{...p.ev.steps[id],[k]:v}}}}));
  const setTask=(id,k,v)=>sf(p=>({...p,tasks:p.tasks.map(t=>t.id===id?{...t,[k]:v}:t)}));
  const addTask=()=>{if(!f.custTask.trim())return;set("tasks",[...f.tasks,{id:gid(),label:f.custTask.trim(),done:false,doneBy:"",doneAt:"",est:"",amount:""}]);set("custTask","");};
  const togStu=(n)=>set("selStu",f.selStu.includes(n)?f.selStu.filter(s=>s!==n):[...f.selStu,n]);
  const submit=async()=>{
    if(!f.plate.trim()||!f.brand.trim()||!f.model.trim()){notify("Immatriculation, marque et modèle sont obligatoires","error");return;}
    const o={
      fileRef:f.fileRef,
      plate:f.plate.toUpperCase(),brand:f.brand,model:f.model,year:f.year,km:f.km,
      vtype:f.vtype,clientName:f.clientName,clientPhone:f.clientPhone,
      entryDate:f.entryDate,entryTime:f.entryTime,reason:f.reason,
      teacher:f.teacher,assignedStudents:f.vtype==="peda"?f.selStu:[],
      tasks:f.tasks,observations:f.observations,additionalSales:f.additionalSales,
      signature:f.signature,status:"en_attente",exitDate:"",exitTime:"",exitCondition:"",
      ev:f.ev,
      createdBy:user.name,
    };
    sbusy(true);
    try {
      const created=await addOrder(o);
      selOrd(created.id);nav("order-detail");notify((f.ev?"Ordre VE/VH ":"Ordre de réparation ")+created.orderNum+" créé");
      archiveToDrive(created, notify);   // archivage PDF sur le Drive (création)
    } catch(e){ console.error(e); notify("Erreur lors de la création : "+(e.message||e),"error"); }
    finally { sbusy(false); }
  };
  return (
    <div style={{ maxWidth:900, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:12 }}>
        <h2 style={{ color:C.txt, fontSize:20, fontWeight:700, margin:0 }}>📋 Nouvel ordre de réparation</h2>
        <Btn ghost sm onClick={() => nav("orders")}>← Retour</Btn>
      </div>
      <div style={{ display:"flex", borderBottom:"1px solid "+C.bdr, marginBottom:16, overflowX:"auto" }}>
        {[{ id:"std", l:"📋 OR standard" },{ id:"ev", l:"⚡ OR véhicule électrique / hybride" }].map(t => {
          const on = (t.id==="ev") === isEv;
          return (
            <button key={t.id} type="button" onClick={() => sf(p => ({ ...p, ev: t.id==="ev" ? (p.ev||EV0()) : null }))}
              style={{ padding:"10px 16px", border:"none", background:"transparent", cursor:"pointer", fontSize:13, whiteSpace:"nowrap",
                fontWeight:on?700:400, color:on?"#2563eb":C.sub, borderBottom:on?"2px solid #3b82f6":"2px solid transparent", marginBottom:-1 }}>
              {t.l}
            </button>
          );
        })}
      </div>
      {isEv && (
        <div style={{ background:"#fef9c3", border:"1px solid #fde047", borderRadius:10, padding:"12px 14px", marginBottom:16, fontSize:13, color:"#854d0e" }}>
          <b>⚡ Ordre de réparation « véhicule électrique ou hybride »</b><br/>
          Ce formulaire ajoute la traçabilité de la <b>mise en sécurité électrique de la batterie de traction</b> :
          type d'opération, consignation, interruption, reprise, fin de travaux et déconsignation.
          Habilitations requises : <b>B2VL</b> (chargé de travaux) et <b>BCL</b> (chargé de consignation).
        </div>
      )}
      <Crd>
        <SecTitle>🚗 Véhicule</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
          <Inp label="Immatriculation *" value={f.plate} onChange={v=>set("plate",v)} placeholder="AB-123-CD"/>
          <Inp label="Marque *" value={f.brand} onChange={v=>set("brand",v)} placeholder="Peugeot"/>
          <Inp label="Modèle *" value={f.model} onChange={v=>set("model",v)} placeholder="308 SW"/>
          <Inp label="Année" value={f.year} onChange={v=>set("year",v)} placeholder="2020"/>
          <Inp label="Kilométrage" value={f.km} onChange={v=>set("km",v)} placeholder="45000"/>
          <Sel label="Type de véhicule" value={f.vtype} onChange={v=>set("vtype",v)} opts={[{v:"client",l:"👤 Véhicule client"},{v:"peda",l:"🎓 Véhicule pédagogique"}]}/>
          {isEv && <Sel label="Énergie (repère P.3)" value={f.ev.energy} onChange={v=>setEv("energy",v)} opts={EV_ENERGIES.map(e=>({v:e,l:e||"— Choisir —"}))}/>}
          {isEv && <Inp label="VIN – 17 caractères (repère E)" value={f.ev.vin} onChange={v=>setEv("vin",v.toUpperCase())} placeholder="VF3XXXXXXXXXXXXXX"/>}
          {isEv && <Inp label="1re immatriculation (repère B)" value={f.ev.firstReg} onChange={v=>setEv("firstReg",v)} type="date"/>}
        </div>
        <SecTitle>📁 Dossier</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
          <Inp label="N° d'ordre de réparation" value="Généré automatiquement" onChange={()=>{}} readOnly/>
          <Inp label="Référence dossier" value={f.fileRef} onChange={v=>set("fileRef",v)} placeholder="REF-2025-001"/>
          <Inp label="Date d'entrée *" value={f.entryDate} onChange={v=>set("entryDate",v)} type="date"/>
          <Inp label="Heure d'entrée *" value={f.entryTime} onChange={v=>set("entryTime",v)} type="time"/>
        </div>
        {f.vtype==="client" ? (
          <div>
            <SecTitle>👤 Client</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Inp label="Nom du client" value={f.clientName} onChange={v=>set("clientName",v)} placeholder="M. Dupont"/>
              <Inp label="Téléphone" value={f.clientPhone} onChange={v=>set("clientPhone",v)} placeholder="06 12 34 56 78"/>
              {isEv && <Inp label="Moyen de contact retenu" value={f.ev.clientContact} onChange={v=>setEv("clientContact",v)} placeholder="Téléphone, SMS, courriel…"/>}
              {isEv && <Inp label="Adresse" value={f.ev.clientAddress} onChange={v=>setEv("clientAddress",v)} placeholder="12 rue des Ateliers, 31000 Toulouse"/>}
              {isEv && <Inp label="Adresse électronique" value={f.ev.clientEmail} onChange={v=>setEv("clientEmail",v)} placeholder="client@exemple.fr"/>}
            </div>
          </div>
        ) : (
          <div>
            <SecTitle>🎓 BTS MV – Affectation pédagogique</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Sel label="Enseignant responsable" value={f.teacher} onChange={v=>set("teacher",v)} opts={[{v:"",l:"— Choisir —"},...teachers.map(t=>({v:t.name,l:t.name}))]}/>
            </div>
            <div style={{ marginTop:12 }}>
              <label style={{ fontSize:12, color:C.sub, fontWeight:500, display:"block", marginBottom:8 }}>Élèves affectés (par classe)</label>
              <StudentPicker students={students} selected={f.selStu} onToggle={togStu}/>
            </div>
          </div>
        )}
        <SecTitle>🔍 Motif d'entrée</SecTitle>
        <TA value={f.reason} onChange={v=>set("reason",v)} placeholder={isEv?"Décrire le motif d'entrée dans les termes du client…":"Décrire le motif d'entrée…"} rows={3}/>
        {isEv && (
          <div>
            <SecTitle>⚡ Type d'opération pour véhicule électrique ou hybride</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(250px,1fr))", gap:8, marginBottom:12 }}>
              {EV_OPS.map(op => {
                const on = f.ev.opType===op.v;
                return (
                  <label key={op.v} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", borderRadius:8, cursor:"pointer",
                    background:on?op.bg:"#f1f5f9", border:"1px solid "+(on?op.col:C.bdr) }}>
                    <input type="radio" name="evop" checked={on} onChange={()=>setEv("opType",op.v)} style={{ marginTop:2, flexShrink:0 }}/>
                    <span>
                      <span style={{ display:"block", fontSize:13, fontWeight:600, color:on?op.col:C.txt }}>{op.l}</span>
                      <span style={{ fontSize:11, color:C.mut }}>{op.s}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Inp label="Chargé de travaux B2VL" value={f.ev.steps.b2vl.name} onChange={v=>setEvStep("b2vl","name",v)} placeholder="Nom et prénom"/>
              <Inp label="Date de prise en charge" value={f.ev.steps.b2vl.date} onChange={v=>setEvStep("b2vl","date",v)} type="date"/>
              <Inp label="Heure" value={f.ev.steps.b2vl.time} onChange={v=>setEvStep("b2vl","time",v)} type="time"/>
            </div>
            <p style={{ color:C.mut, fontSize:12, margin:"10px 0 0" }}>
              Consignation, interruption, reprise, fin de travaux et déconsignation sont horodatées <b>en atelier</b>,
              dans l'onglet « ⚡ Sécurité électrique » de l'ordre de réparation.
            </p>
          </div>
        )}
        <SecTitle>☑️ Travaux {isEv?"demandés":"à réaliser"}</SecTitle>
        <p style={{ color:C.mut, fontSize:12, margin:"0 0 10px" }}>Listez les travaux prévus. Les cases seront <b>cochées par le technicien en atelier</b> au fur et à mesure de la réalisation (onglet Travaux de l'ordre).</p>
        {isEv ? (
          <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:10 }}>
            {f.tasks.map((t,i) => (
              <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", padding:"6px 8px", borderRadius:6, background:"#f8fafc", border:"1px solid "+C.bdr }}>
                <span style={{ width:20, textAlign:"center", fontSize:12, color:C.mut, flexShrink:0 }}>{i+1}</span>
                <span style={{ flex:"1 1 180px", fontSize:13, color:C.txt }}>{t.label}</span>
                <Inp value={t.est} onChange={v=>setTask(t.id,"est",v)} placeholder="Temps est." style={{ width:104, background:"#fff" }}/>
                <Inp value={t.amount} onChange={v=>setTask(t.id,"amount",v)} placeholder="Montant HT" style={{ width:104, background:"#fff" }}/>
                <button onClick={e=>{e.preventDefault();set("tasks",f.tasks.filter(x=>x.id!==t.id));}} title="Retirer ce travail" style={{ background:"none", border:"none", color:C.mut, cursor:"pointer", fontSize:16, padding:0, lineHeight:1, flexShrink:0 }}>×</button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))", gap:8, marginBottom:10 }}>
            {f.tasks.map(t => (
              <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderRadius:6, background:"#f1f5f9", border:"1px solid "+C.bdr, fontSize:13, color:C.txt }}>
                <span style={{ width:15, height:15, borderRadius:3, border:"2px solid "+C.bdr, background:"#fff", flexShrink:0 }}/>
                <span style={{ flex:1 }}>{t.label}</span>
                <button onClick={e=>{e.preventDefault();set("tasks",f.tasks.filter(x=>x.id!==t.id));}} title="Retirer ce travail" style={{ background:"none", border:"none", color:C.mut, cursor:"pointer", fontSize:16, padding:0, lineHeight:1 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display:"flex", gap:8 }}>
          <input value={f.custTask} onChange={e=>set("custTask",e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addTask();}} placeholder="Ajouter une tâche personnalisée…"
            style={{ flex:1, background:"#f1f5f9", border:"1px solid "+C.bdr, borderRadius:6, padding:"8px 10px", color:C.txt, fontSize:13, outline:"none", fontFamily:"inherit" }}/>
          <Btn sm onClick={addTask}>+ Ajouter</Btn>
        </div>
        <SecTitle>📝 Notes</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:12 }}>
          <TA label="Observations à signaler au client" value={f.observations} onChange={v=>set("observations",v)} placeholder="Anomalies constatées…"/>
          <TA label="Ventes additionnelles à prévoir" value={f.additionalSales} onChange={v=>set("additionalSales",v)} placeholder="Pièces, accessoires…"/>
        </div>
        {isEv && (
          <div>
            <SecTitle>🤝 Engagement et accord</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Inp label="Montant prévisionnel annoncé (€ TTC)" value={f.ev.quoteAmount} onChange={v=>setEv("quoteAmount",v)} placeholder="450"/>
              <Inp label="Restitution convenue le" value={f.ev.returnDate} onChange={v=>setEv("returnDate",v)} type="date"/>
              <Inp label="À (heure)" value={f.ev.returnTime} onChange={v=>setEv("returnTime",v)} type="time"/>
            </div>
            <p style={{ color:C.mut, fontSize:12, margin:"8px 0 0" }}>Le client est rappelé avant tout dépassement du montant annoncé.</p>
          </div>
        )}
        <SecTitle>✍ Signature du client (accord pour les travaux)</SecTitle>
        <div style={{ background:"#f1f5f9", borderRadius:10, padding:16, border:"1px solid "+C.bdr }}>
          <p style={{ color:C.sub, fontSize:12, marginBottom:12 }}>Le client certifie avoir pris connaissance des travaux à réaliser et donne son accord.</p>
          {f.signature ? (
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
                <span style={{ color:"#059669", fontSize:13, fontWeight:600 }}>✅ Signature enregistrée</span>
                <Btn sm ghost onClick={()=>set("signature","")}>Refaire la signature</Btn>
              </div>
              <img src={f.signature} alt="Signature" style={{ maxHeight:80, background:"#fff", borderRadius:6, padding:4, display:"block" }}/>
            </div>
          ) : (
            <SigPad onSave={v=>set("signature",v)} init={f.signature}/>
          )}
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:10, marginTop:20, paddingTop:16, borderTop:"1px solid "+C.bdr }}>
          <Btn ghost onClick={()=>nav("orders")}>Annuler</Btn>
          <Btn onClick={submit} disabled={busy}>{busy?"Création…":(isEv?"⚡ Créer l'OR véhicule électrique / hybride":"✅ Créer l'ordre de réparation")}</Btn>
        </div>
      </Crd>
    </div>
  );
}


// ── Historique d'entretien des véhicules ───────────────────────────────────
// Recherche ouverte à tous ; saisie réservée aux enseignants et administrateurs.

function VhModal({ init, plate, user, onSave, onClose }) {
  const [f,sf]=useState(()=> init
    ? {...init}
    : { plate:plate||"", brand:"", model:"", date:today(), km:"", kind:"entretien", label:"", details:"" });
  const [busy,sbusy]=useState(false);
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  const ok=async()=>{
    if(!plateKey(f.plate)){alert("L'immatriculation est obligatoire.");return;}
    if(!f.label.trim()){alert("Indiquez la nature de l'intervention.");return;}
    sbusy(true);
    try{ await onSave({...f, plate:f.plate.toUpperCase().trim(), label:f.label.trim(), createdBy:init?init.createdBy:user.name}); }
    finally{ sbusy(false); }
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>
      <div style={{background:C.card,borderRadius:16,padding:24,width:"100%",maxWidth:560,border:"1px solid "+C.bdr,maxHeight:"92vh",overflowY:"auto"}}>
        <h3 style={{color:C.txt,fontSize:18,fontWeight:700,marginBottom:4}}>{init?"✏️ Modifier l'intervention":"➕ Ajouter une intervention"}</h3>
        <p style={{color:C.sub,fontSize:13,marginBottom:16}}>Pour consigner ce qui n'est pas passé par l'atelier : entretien antérieur, intervention extérieure, contrôle technique…</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12,marginBottom:12}}>
          <Inp label="Immatriculation *" value={f.plate} onChange={v=>set("plate",v.toUpperCase())} placeholder="AB-123-CD"/>
          <Inp label="Date" value={f.date} onChange={v=>set("date",v)} type="date"/>
          <Inp label="Kilométrage" value={f.km} onChange={v=>set("km",v)} placeholder="92000"/>
          <Sel label="Nature" value={f.kind} onChange={v=>set("kind",v)} opts={VH_KINDS.map(k=>({v:k.v,l:k.ico+" "+k.l}))}/>
          <Inp label="Marque" value={f.brand} onChange={v=>set("brand",v)} placeholder="Peugeot"/>
          <Inp label="Modèle" value={f.model} onChange={v=>set("model",v)} placeholder="308 SW"/>
        </div>
        <div style={{marginBottom:12}}>
          <Inp label="Intervention *" value={f.label} onChange={v=>set("label",v)} placeholder="Vidange + filtre à huile"/>
        </div>
        <div style={{marginBottom:20}}>
          <TA label="Détails" value={f.details} onChange={v=>set("details",v)} placeholder="Pièces posées, atelier, remarques…" rows={3}/>
        </div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
          <Btn ghost onClick={onClose}>Annuler</Btn>
          <Btn onClick={ok} disabled={busy}>{busy?"Enregistrement…":"✅ Enregistrer"}</Btn>
        </div>
      </div>
    </div>
  );
}

function VehiclesView({ orders, documents, vehicleHistory, user, nav, selOrd, openDoc, addVh, editVh, removeVh, notify }) {
  const [q,sq]=useState(""); const [sel,ssel]=useState(null); const [modal,smodal]=useState(null);
  const isStaff=user.role!=="eleve";
  const vehicles=buildVehicles(orders,documents,vehicleHistory);
  const needle=q.trim().toLowerCase(), nKey=plateKey(q);
  const shown=!needle?vehicles:vehicles.filter(v=>
    (nKey&&v.key.includes(nKey))||[v.plate,v.brand,v.model,v.client].join(" ").toLowerCase().includes(needle));
  const v=sel?vehicles.find(x=>x.key===sel):null;

  const save=async(data)=>{
    try{
      if(modal&&modal.edit){ await editVh(modal.edit.id,data); notify("Intervention modifiée"); }
      else { await addVh(data); notify("Intervention ajoutée à l'historique"); }
      smodal(null);
      if(!sel) ssel(plateKey(data.plate));
    }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const del=async(h)=>{
    if(!window.confirm("Supprimer « "+h.label+" » de l'historique ?"))return;
    try{ await removeVh(h.id); notify("Intervention supprimée"); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };

  // ── Fiche d'un véhicule ──
  if(v){
    const k=v.key;
    const items=[
      ...orders.filter(o=>plateKey(o.plate)===k).map(o=>({t:"or",id:o.id,date:o.entryDate||(o.createdAt||"").slice(0,10),o})),
      ...documents.filter(d=>plateKey(d.plate)===k).map(d=>({t:d.kind,id:d.id,date:(d.createdAt||"").slice(0,10),d})),
      ...vehicleHistory.filter(h=>plateKey(h.plate)===k).map(h=>({t:"vh",id:h.id,date:h.date||(h.createdAt||"").slice(0,10),h})),
    ].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    return (
      <div style={{maxWidth:900,margin:"0 auto"}}>
        <Btn ghost sm onClick={()=>ssel(null)} style={{marginBottom:12}}>← Tous les véhicules</Btn>
        <Crd style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
            <div>
              <h2 style={{color:C.txt,fontSize:22,fontWeight:700,margin:0,letterSpacing:.5}}>🚙 {v.plate}</h2>
              <div style={{color:C.sub,fontSize:14,marginTop:4}}>{[v.brand,v.model,v.year&&"("+v.year+")"].filter(Boolean).join(" ")||"Véhicule non identifié"}</div>
              {v.client&&<div style={{color:C.mut,fontSize:12,marginTop:2}}>{v.client}</div>}
            </div>
            {isStaff&&<Btn sm onClick={()=>smodal({plate:v.plate})}>➕ Ajouter une intervention</Btn>}
          </div>
          <div style={{display:"flex",gap:16,flexWrap:"wrap",marginTop:12,paddingTop:12,borderTop:"1px solid "+C.bdr,fontSize:13}}>
            <span style={{color:C.sub}}>Dernier passage : <b style={{color:C.txt}}>{v.last?fD(v.last):"—"}</b></span>
            {v.km&&<span style={{color:C.sub}}>Dernier kilométrage connu : <b style={{color:C.txt}}>{kmTxt(v.km)} km</b></span>}
            <span style={{color:C.mut}}>{v.nOrders} OR · {v.nDocs} document(s) · {v.nNotes} saisie(s)</span>
          </div>
        </Crd>
        {items.length===0
          ? <Crd><p style={{color:C.mut,fontSize:13,margin:0}}>Aucune intervention enregistrée pour ce véhicule.</p></Crd>
          : <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {items.map(it=>{
                if(it.t==="or"){ const o=it.o, dn=(o.tasks||[]).filter(t=>t.done).length, tot=(o.tasks||[]).length;
                  return (
                    <Crd key={"or"+it.id} style={{borderLeft:"4px solid #3b82f6"}}>
                      <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                        <div>
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:999,background:"#dbeafe",color:"#1d4ed8"}}>🔧 Ordre de réparation</span>
                          <span style={{color:C.mut,fontSize:12,marginLeft:8}}>{fD(it.date)}</span>
                          {o.ev&&<span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:999,background:"#fef9c3",color:"#a16207",marginLeft:6}}>⚡ VE/VH</span>}
                        </div>
                        <Btn sm ghost onClick={()=>{selOrd(o.id);nav("order-detail");}}>Ouvrir</Btn>
                      </div>
                      <div style={{color:C.txt,fontSize:14,fontWeight:600,marginTop:8}}>{o.orderNum}</div>
                      {o.reason&&<div style={{color:C.sub,fontSize:13,marginTop:2}}>{o.reason}</div>}
                      <div style={{color:C.mut,fontSize:12,marginTop:6}}>
                        <Badge status={o.status}/> <span style={{marginLeft:8}}>{dn}/{tot} travaux réalisés</span>
                        {o.km&&<span style={{marginLeft:8}}>· {kmTxt(o.km)} km</span>}
                      </div>
                    </Crd>
                  );
                }
                if(it.t==="estimate"||it.t==="invoice"){ const d=it.d, est=it.t==="estimate";
                  return (
                    <Crd key={"d"+it.id} style={{borderLeft:"4px solid "+(est?"#a78bfa":"#059669")}}>
                      <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                        <div>
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:999,background:est?"#ede9fe":"#dcfce7",color:est?"#6d28d9":"#15803d"}}>{est?"🧾 Estimation":"💶 Facture"}</span>
                          <span style={{color:C.mut,fontSize:12,marginLeft:8}}>{fD(it.date)}</span>
                        </div>
                        <Btn sm ghost onClick={()=>openDoc(d.id,d.kind)}>Ouvrir</Btn>
                      </div>
                      <div style={{color:C.txt,fontSize:14,fontWeight:600,marginTop:8}}>{d.docNum} · {eur(docTotals(d).ttc)}</div>
                      <div style={{color:C.mut,fontSize:12,marginTop:2}}>{(d.items||[]).length} ligne(s) · {d.createdBy}</div>
                    </Crd>
                  );
                }
                const h=it.h, kd=vhKind(h.kind);
                return (
                  <Crd key={"h"+it.id} style={{borderLeft:"4px solid "+kd.col}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap",alignItems:"center"}}>
                      <div>
                        <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:999,background:kd.bg,color:kd.col}}>{kd.ico} {kd.l}</span>
                        <span style={{color:C.mut,fontSize:12,marginLeft:8}}>{fD(it.date)}</span>
                      </div>
                      {isStaff&&(
                        <div style={{display:"flex",gap:6}}>
                          <Btn sm ghost onClick={()=>smodal({edit:h})}>✏️ Modifier</Btn>
                          <Btn sm ghost danger onClick={()=>del(h)}>🗑</Btn>
                        </div>
                      )}
                    </div>
                    <div style={{color:C.txt,fontSize:14,fontWeight:600,marginTop:8}}>{h.label}</div>
                    {h.details&&<div style={{color:C.sub,fontSize:13,marginTop:2,whiteSpace:"pre-wrap"}}>{h.details}</div>}
                    <div style={{color:C.mut,fontSize:12,marginTop:6}}>{h.km?kmTxt(h.km)+" km · ":""}saisi par {h.createdBy||"—"}</div>
                  </Crd>
                );
              })}
            </div>}
        {modal&&<VhModal init={modal.edit} plate={modal.plate} user={user} onSave={save} onClose={()=>smodal(null)}/>}
      </div>
    );
  }

  // ── Liste / recherche ──
  return (
    <div style={{maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>🚙 Historique d'entretien des véhicules</h2>
        {isStaff&&<Btn sm onClick={()=>smodal({plate:q.trim().toUpperCase()})}>➕ Ajouter une intervention</Btn>}
      </div>
      <Crd style={{marginBottom:14}}>
        <input value={q} onChange={e=>sq(e.target.value)} placeholder="Rechercher une immatriculation, une marque, un modèle, un client…"
          style={{width:"100%",background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:8,padding:"11px 14px",color:C.txt,fontSize:15,outline:"none",fontFamily:"inherit"}}/>
        <p style={{color:C.mut,fontSize:12,margin:"8px 0 0"}}>
          {vehicles.length} véhicule(s) connu(s) de l'atelier. La ponctuation de la plaque n'a pas d'importance : « ab123cd » trouve « AB-123-CD ».
        </p>
      </Crd>
      {shown.length===0?(
        <Crd>
          <p style={{color:C.mut,fontSize:13,margin:0}}>
            {vehicles.length===0?"Aucun véhicule enregistré pour le moment.":"Aucun véhicule ne correspond à cette recherche."}
          </p>
          {isStaff&&plateKey(q)&&(
            <div style={{marginTop:12}}>
              <Btn sm onClick={()=>smodal({plate:q.trim().toUpperCase()})}>➕ Créer l'historique de « {q.trim().toUpperCase()} »</Btn>
            </div>
          )}
        </Crd>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
          {shown.map(x=>(
            <div key={x.key} onClick={()=>ssel(x.key)} style={{background:C.card,borderRadius:12,padding:16,border:"1px solid "+C.bdr,cursor:"pointer"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor="#3b82f6"}
              onMouseLeave={e=>e.currentTarget.style.borderColor=C.bdr}>
              <div style={{color:C.txt,fontWeight:700,fontSize:17,letterSpacing:.5}}>{x.plate}</div>
              <div style={{color:C.sub,fontSize:13,marginTop:2}}>{[x.brand,x.model].filter(Boolean).join(" ")||"—"}{x.year?" ("+x.year+")":""}</div>
              {x.client&&<div style={{color:C.mut,fontSize:12,marginTop:2}}>{x.client}</div>}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
                {x.nOrders>0&&<span style={{fontSize:11,padding:"2px 8px",borderRadius:999,background:"#dbeafe",color:"#1d4ed8"}}>{x.nOrders} OR</span>}
                {x.nDocs>0&&<span style={{fontSize:11,padding:"2px 8px",borderRadius:999,background:"#dcfce7",color:"#15803d"}}>{x.nDocs} doc.</span>}
                {x.nNotes>0&&<span style={{fontSize:11,padding:"2px 8px",borderRadius:999,background:"#fef3c7",color:"#b45309"}}>{x.nNotes} saisie(s)</span>}
              </div>
              <div style={{color:C.mut,fontSize:11,marginTop:10}}>Dernier passage : {x.last?fD(x.last):"—"}</div>
            </div>
          ))}
        </div>
      )}
      {modal&&<VhModal init={modal.edit} plate={modal.plate} user={user} onSave={save} onClose={()=>smodal(null)}/>}
    </div>
  );
}

function OrderDetail({ orderId, orders, editOrder, removeOrder, isAdmin, user, nav, notify, students }) {
  const [tab,st]=useState("tasks"); const [showExit,sse]=useState(false); const [newTask,snt]=useState("");
  const o=orders.find(x=>x.id===orderId);
  const [obs,setObs]=useState(o?o.observations||"":""); const [adds,setAdds]=useState(o?o.additionalSales||"":"");
  useEffect(()=>{ if(o){ setObs(o.observations||""); setAdds(o.additionalSales||""); } },[orderId]); // eslint-disable-line
  if(!o)return<p style={{color:C.txt}}>Ordre introuvable.</p>;
  const canEdit=true;                     // tâches + notes : éditables par tous (staff + élèves)
  const isStaff=user.role!=="eleve";      // démarrage / sortie véhicule : staff uniquement
  const isPeda=o.vtype==="peda";
  const upd=async(u)=>{ try{ await editOrder(orderId,u); }catch(e){ console.error(e); notify("Erreur lors de l'enregistrement","error"); } };
  const togTask=tid=>{
    if(!canEdit)return;
    const tasks=o.tasks.map(t=>{if(t.id!==tid)return t;const d=!t.done;return{...t,done:d,doneBy:d?user.name:"",doneAt:d?new Date().toISOString():""};});
    upd({tasks,status:o.status==="en_attente"?"en_cours":o.status});
  };
  const addT=()=>{if(!newTask.trim())return;upd({tasks:[...o.tasks,{id:gid(),label:newTask.trim(),done:false,doneBy:"",doneAt:"",est:"",amount:""}]});snt("");};
  const dn=o.tasks?o.tasks.filter(t=>t.done).length:0,tot=o.tasks?o.tasks.length:0,pct=tot?Math.round(dn/tot*100):0;
  const TABS=[{id:"tasks",l:"☑️ Travaux"},...(o.ev?[{id:"ev",l:"⚡ Sécurité électrique"}]:[]),{id:"notes",l:"📝 Notes"},{id:"sig",l:"✍ Accord client"},...(o.exitDate?[{id:"exit",l:"🚪 Sortie"}]:[])];
  const evSet=(id,patch)=>upd({ev:{...o.ev,steps:{...(o.ev.steps||{}),[id]:{...evStep(o.ev,id),...patch}}}});
  return (
    <div style={{maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div>
          <Btn ghost sm onClick={()=>nav("orders")} style={{marginBottom:8}}>← Retour</Btn>
          <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>{o.orderNum} – {o.plate}</h2>
          <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap",alignItems:"center"}}>
            <Badge status={o.status}/>
            <span style={{fontSize:12,fontWeight:600,color:isPeda?"#c2410c":"#1d4ed8"}}>{isPeda?"🎓 Pédagogique":"👤 Client"}</span>
            <span style={{fontSize:13,color:C.sub}}>{o.brand} {o.model} {o.year?"("+o.year+")":""}</span>
            {o.ev&&<span style={{fontSize:12,fontWeight:600,padding:"2px 8px",borderRadius:999,background:"#fef9c3",color:"#a16207"}}>⚡ VE/VH</span>}
            {o.signature&&<span style={{fontSize:12,color:"#059669"}}>✍ Signé</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn sm ghost onClick={()=>generatePDF(o)} style={{borderColor:"#3b82f6",color:"#2563eb"}}>📄 PDF</Btn>
          {isStaff&&<Btn sm ghost onClick={()=>archiveToDrive(o,notify)} style={{borderColor:"#16a34a",color:"#059669"}}>📁 Archiver Drive</Btn>}
          {isStaff&&o.status!=="termine"&&(
            <>
              {o.status==="en_attente"&&<Btn sm onClick={()=>{upd({status:"en_cours"});notify("Intervention démarrée");}}>▶ Démarrer</Btn>}
            </>
          )}
        </div>
      </div>
      <Crd style={{marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,fontSize:13}}>
          {[{k:"N° OR",v:o.orderNum},{k:"Réf. dossier",v:o.fileRef||"—"},{k:"Entrée",v:fD(o.entryDate)+" "+o.entryTime},{k:isPeda?"Enseignant":"Client",v:isPeda?(o.teacher||"—"):(o.clientName||"—")}]
            .concat(o.clientPhone?[{k:"Tel.",v:o.clientPhone}]:[],o.students?[{k:"Élèves",v:o.students}]:[],[{k:"Avancement",v:dn+"/"+tot+" ("+pct+"%)"}])
            .map(item=>(
              <div key={item.k}>
                <div style={{color:C.mut,fontSize:11,marginBottom:2}}>{item.k}</div>
                <div style={{color:C.txt,fontWeight:500,wordBreak:"break-word"}}>{item.v}</div>
              </div>
            ))}
        </div>
        {o.reason&&<div style={{marginTop:12,paddingTop:12,borderTop:"1px solid "+C.bdr,fontSize:13,color:C.sub}}><b>Motif : </b><span style={{color:C.txt}}>{o.reason}</span></div>}
      </Crd>
      {isStaff&&(
        <Crd style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:10}}>
            <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,margin:0}}>🎓 Élèves affectés</h3>
            {o.assignedStudents.length>0&&<span style={{color:C.sub,fontSize:12}}>{o.assignedStudents.length} affecté(s)</span>}
          </div>
          <StudentPicker students={students} selected={o.assignedStudents}
            onToggle={(name)=>{const sel=o.assignedStudents.includes(name);const na=sel?o.assignedStudents.filter(n=>n!==name):[...o.assignedStudents,name];upd({assignedStudents:na});}}/>
        </Crd>
      )}
      <div style={{display:"flex",borderBottom:"1px solid "+C.bdr,marginBottom:14,overflowX:"auto"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>st(t.id)} style={{padding:"10px 16px",border:"none",background:"transparent",cursor:"pointer",fontSize:13,whiteSpace:"nowrap",fontWeight:tab===t.id?700:400,color:tab===t.id?"#2563eb":C.sub,borderBottom:tab===t.id?"2px solid #3b82f6":"2px solid transparent",marginBottom:-1}}>{t.l}</button>
        ))}
      </div>
      {tab==="tasks"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1,background:"#f1f5f9",borderRadius:999,height:8,overflow:"hidden"}}>
              <div style={{width:pct+"%",background:"#3b82f6",height:"100%",borderRadius:999,transition:"width .3s"}}/>
            </div>
            <span style={{color:C.sub,fontSize:13,whiteSpace:"nowrap"}}>{dn}/{tot} ({pct}%)</span>
          </div>
          {o.tasks&&o.tasks.map(t=>(
            <div key={t.id} onClick={()=>canEdit&&togTask(t.id)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderRadius:8,background:t.done?"#dcfce7":"#f1f5f9",border:"1px solid "+(t.done?"#16a34a44":C.bdr),cursor:canEdit?"pointer":"default"}}>
              <div style={{width:20,height:20,borderRadius:4,flexShrink:0,background:t.done?"#16a34a":"transparent",border:"2px solid "+(t.done?"#16a34a":"#4b5563"),display:"flex",alignItems:"center",justifyContent:"center"}}>
                {t.done&&<span style={{color:"#fff",fontSize:12,fontWeight:700}}>✓</span>}
              </div>
              <span style={{flex:1,fontSize:14,color:t.done?"#15803d":C.txt,textDecoration:t.done?"line-through":"none"}}>{t.label}</span>
              {o.ev&&t.est&&<span style={{fontSize:11,color:C.mut,whiteSpace:"nowrap"}}>⏱ {t.est}</span>}
              {o.ev&&t.amount&&<span style={{fontSize:11,color:C.mut,whiteSpace:"nowrap"}}>{eur(t.amount)} HT</span>}
              {t.done&&t.doneBy&&<span style={{fontSize:11,color:C.mut,whiteSpace:"nowrap"}}>{t.doneBy} · {fD(t.doneAt)}</span>}
            </div>
          ))}
          {canEdit&&o.status!=="termine"&&(
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <input value={newTask} onChange={e=>snt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addT();}} placeholder="Ajouter une tâche…"
                style={{flex:1,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"8px 10px",color:C.txt,fontSize:13,outline:"none",fontFamily:"inherit"}}/>
              <Btn sm onClick={addT}>+</Btn>
            </div>
          )}
        </div>
      )}
      {tab==="ev"&&o.ev&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Crd>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,padding:"4px 12px",borderRadius:999,background:evOp(o.ev.opType).bg,color:evOp(o.ev.opType).col}}>{evOp(o.ev.opType).l}</span>
              {o.ev.energy&&<span style={{fontSize:12,color:C.sub}}>🔋 {o.ev.energy}</span>}
              {o.ev.vin&&<span style={{fontSize:12,color:C.mut}}>VIN {o.ev.vin}</span>}
              {o.ev.firstReg&&<span style={{fontSize:12,color:C.mut}}>1re immat. {fD(o.ev.firstReg)}</span>}
            </div>
            <div style={{marginTop:10,padding:"10px 12px",borderRadius:8,fontSize:13,fontWeight:600,
              background:evTodo(o.ev)?"#fee2e2":evOpen(o.ev)?"#dcfce7":"#f1f5f9",
              color:evTodo(o.ev)?"#b91c1c":evOpen(o.ev)?"#15803d":C.sub}}>
              {o.ev.opType==="non_elec"
                ? "Opération non électrique : aucune consignation de la batterie de traction requise."
                : evTodo(o.ev)
                  ? "⛔ Batterie de traction NON consignée — aucune intervention sur le circuit haute tension."
                  : evOpen(o.ev)
                    ? "✅ Véhicule consigné (hors tension) depuis le "+evWhen(evStep(o.ev,"consign"))+" — déconsignation à effectuer en fin de travaux."
                    : "🔌 Véhicule déconsigné / remis sous tension le "+evWhen(evStep(o.ev,"deconsign"))+"."}
            </div>
          </Crd>
          {EV_STEPS.map(st=>{
            const v=evStep(o.ev,st.id), ok=evDone(v);
            return (
              <Crd key={st.id} style={{borderLeft:"4px solid "+(ok?"#16a34a":C.bdr)}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:6}}>
                  <h4 style={{margin:0,fontSize:14,fontWeight:700,color:ok?"#15803d":C.txt}}>{ok?"✅":"⬜"} {st.lbl}</h4>
                  <div style={{display:"flex",gap:8}}>
                    {!ok&&<Btn sm onClick={()=>evSet(st.id,{date:today(),time:tNow(),visa:user.name})}>⏱ Horodater maintenant</Btn>}
                    {ok&&<Btn sm ghost onClick={()=>{if(window.confirm("Effacer l'horodatage de « "+st.lbl+" » ?"))evSet(st.id,{date:"",time:"",visa:""});}}>↺ Effacer</Btn>}
                  </div>
                </div>
                <p style={{color:C.sub,fontSize:12,margin:"0 0 10px"}}>{st.who?<b>{v.name||"…"} </b>:null}{st.txt}</p>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10}}>
                  {st.who&&<Inp label={st.who} value={v.name} onChange={val=>evSet(st.id,{name:val})} placeholder="Nom et prénom"/>}
                  <Inp label="Date" value={v.date} onChange={val=>evSet(st.id,{date:val})} type="date"/>
                  <Inp label="Heure" value={v.time} onChange={val=>evSet(st.id,{time:val})} type="time"/>
                  <Inp label="Visa" value={v.visa} onChange={val=>evSet(st.id,{visa:val})} placeholder="Initiales"/>
                </div>
              </Crd>
            );
          })}
          <p style={{color:C.mut,fontSize:12,margin:0}}>
            Les habilitations <b>B2VL</b> (chargé de travaux) et <b>BCL</b> (chargé de consignation) doivent être à jour.
            Ce relevé est repris intégralement sur le PDF de l'ordre de réparation.
          </p>
        </div>
      )}
      {tab==="notes"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <TA label="👁 Observations à signaler au client" value={obs} onChange={canEdit?setObs:null} onBlur={canEdit?()=>{if(obs!==(o.observations||""))upd({observations:obs});}:null} readOnly={!canEdit} placeholder={canEdit?"Anomalies constatées…":"Aucune observation"} rows={4}/>
          <TA label="🛒 Ventes additionnelles à prévoir" value={adds} onChange={canEdit?setAdds:null} onBlur={canEdit?()=>{if(adds!==(o.additionalSales||""))upd({additionalSales:adds});}:null} readOnly={!canEdit} placeholder={canEdit?"Pièces, accessoires…":"Aucune"} rows={4}/>
        </div>
      )}
      {tab==="sig"&&(
        <Crd>
          <h3 style={{color:"#2563eb",fontSize:15,fontWeight:700,marginBottom:4}}>✍ Accord du client pour les travaux</h3>
          <p style={{color:C.sub,fontSize:12,marginBottom:14}}>Signature recueillie lors de la création de l'ordre de réparation.</p>
          {o.signature?(
            <div>
              <div style={{color:"#059669",fontSize:13,fontWeight:600,marginBottom:10}}>✅ Document signé</div>
              <img src={o.signature} alt="Signature client" style={{maxWidth:400,background:"#fff",borderRadius:8,padding:6,display:"block",border:"1px solid "+C.bdr}}/>
              <div style={{color:C.mut,fontSize:12,marginTop:8}}>Signataire : {isPeda?(o.teacher||"—"):(o.clientName||"—")}</div>
            </div>
          ):(
            <div style={{color:"#f59e0b",fontSize:13}}>⚠️ Aucune signature enregistrée pour cet ordre de réparation.</div>
          )}
        </Crd>
      )}
      {tab==="exit"&&o.exitDate&&(
        <Crd>
          <h3 style={{color:"#059669",fontSize:15,fontWeight:700,marginBottom:12}}>🚪 Sortie enregistrée</h3>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,fontSize:13}}>
            <div><div style={{color:C.mut,fontSize:11}}>Date de sortie</div><div style={{color:C.txt}}>{fD(o.exitDate)} à {o.exitTime}</div></div>
            <div><div style={{color:C.mut,fontSize:11}}>État à la sortie</div><div style={{color:C.txt}}>{o.exitCondition||"—"}</div></div>
          </div>
        </Crd>
      )}
      {!isStaff&&o.status!=="termine"&&(
        <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid "+C.bdr,color:C.mut,fontSize:13}}>
          🔒 La clôture de l'ordre de réparation est réservée à l'enseignant ou à l'administrateur.
        </div>
      )}
      {isStaff&&(
        <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid "+C.bdr}}>
          {o.status!=="termine"?(
            <Btn full onClick={()=>{ if(evOpen(o.ev)&&!window.confirm("⚠️ La batterie de traction est encore consignée (hors tension).\n\nLa déconsignation / remise sous tension n'a pas été horodatée dans l'onglet « ⚡ Sécurité électrique ».\n\nTerminer quand même l'ordre de réparation ?"))return; sse(true); }} style={{background:"#065f46",fontSize:15,padding:"12px"}}>✅ Valider et terminer l'OR</Btn>
          ):(
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
              <span style={{color:"#059669",fontSize:14,fontWeight:600}}>✅ Ordre terminé{o.exitDate?" le "+fD(o.exitDate):""}</span>
              <Btn sm ghost onClick={()=>archiveToDrive(o,notify)} style={{borderColor:"#16a34a",color:"#059669"}}>📁 Archiver sur le Drive</Btn>
            </div>
          )}
          {isAdmin&&(
            <div style={{marginTop:14,paddingTop:12,borderTop:"1px dashed "+C.bdr,display:"flex",justifyContent:"flex-end"}}>
              <Btn sm ghost danger onClick={async()=>{ if(!window.confirm("Supprimer définitivement l'ordre "+o.orderNum+" ?\nAction irréversible (le PDF déjà archivé sur le Drive n'est pas supprimé)."))return; try{ await removeOrder(orderId); notify("Ordre supprimé"); nav("orders"); }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); } }}>🗑 Supprimer l'ordre</Btn>
            </div>
          )}
        </div>
      )}
      {showExit&&<ExitModal o={o} onOk={(d,archive)=>{upd({...d,status:"termine"});sse(false);st("exit");notify(archive?"Ordre terminé":"Ordre terminé (non archivé)");if(archive)archiveToDrive({...o,...d,status:"termine"},notify);}} onClose={()=>sse(false)}/>}
    </div>
  );
}

function ExitModal({ o, onOk, onClose }) {
  const [f,sf]=useState({exitDate:today(),exitTime:tNow(),exitCondition:""});
  const [archive,sa]=useState(true);
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:C.card,borderRadius:16,padding:24,width:"100%",maxWidth:480,border:"1px solid "+C.bdr}}>
        <h3 style={{color:C.txt,fontSize:18,fontWeight:700,marginBottom:4}}>✅ Terminer l'ordre de réparation</h3>
        <p style={{color:C.sub,fontSize:14,marginBottom:16}}>{o.plate} – {o.brand} {o.model} · l'OR sera marqué « terminé ».</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <Inp label="Date de sortie" value={f.exitDate} onChange={v=>set("exitDate",v)} type="date"/>
          <Inp label="Heure de sortie" value={f.exitTime} onChange={v=>set("exitTime",v)} type="time"/>
        </div>
        <div style={{marginBottom:16}}>
          <TA label="État du véhicule à la sortie" value={f.exitCondition} onChange={v=>set("exitCondition",v)} placeholder="Propre, réparation effectuée, client informé…" rows={3}/>
        </div>
        <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:8,marginBottom:20,cursor:"pointer",
          background:archive?"#dcfce7":"#f1f5f9",border:"1px solid "+(archive?"#16a34a":C.bdr)}}>
          <input type="checkbox" checked={archive} onChange={e=>sa(e.target.checked)} style={{marginTop:2,flexShrink:0}}/>
          <span>
            <span style={{display:"block",fontSize:13,fontWeight:600,color:archive?"#15803d":C.txt}}>📁 Archiver le PDF sur le Google Drive</span>
            <span style={{fontSize:11,color:C.mut}}>{archive?"Le PDF sera déposé dans le dossier « "+orderFolder(o)+" ».":"Aucun dépôt sur le Drive. Possible plus tard depuis l'ordre."}</span>
          </span>
        </label>
        <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
          <Btn ghost onClick={onClose}>Annuler</Btn>
          <Btn onClick={()=>onOk(f,archive)} style={{background:"#065f46"}}>✅ Valider et terminer</Btn>
        </div>
      </div>
    </div>
  );
}

function HistoryView({ orders, documents, nav, selOrd, openDoc }) {
  const [tab,st]=useState("orders");
  const [q,sq]=useState("");
  const ql=q.toLowerCase();
  const TABS=[["orders","🔧 Ordres"],["estimate","🧾 Estimations"],["invoice","💶 Factures"]];
  const ords=[...orders].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .filter(o=>!q||[o.plate,o.brand,o.model,o.clientName,o.orderNum,o.students].join(" ").toLowerCase().includes(ql));
  const docs=(documents||[]).filter(d=>d.kind===tab).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .filter(d=>!q||[d.docNum,d.clientName,d.plate,d.brand,d.model].join(" ").toLowerCase().includes(ql));
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>📋 Historique</h2>
        {tab==="orders"&&<Btn sm onClick={()=>csvExport(toCSV(orders),"DMS_Gallieni_"+today()+".csv")} style={{background:"#065f46"}}>⬇ Exporter CSV/Excel</Btn>}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {TABS.map(([id,l])=><button key={id} onClick={()=>st(id)} style={{padding:"8px 16px",borderRadius:6,cursor:"pointer",fontSize:13,border:"1px solid "+(tab===id?"#2563eb":C.bdr),background:tab===id?C.acc:"transparent",color:tab===id?"#fff":C.sub}}>{l}</button>)}
      </div>
      <input value={q} onChange={e=>sq(e.target.value)} placeholder="🔍 Rechercher..."
        style={{background:C.card,border:"1px solid "+C.bdr,borderRadius:8,padding:"10px 14px",color:C.txt,fontSize:13,outline:"none"}}/>
      {tab==="orders" ? (
        ords.length===0
          ?<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucune intervention enregistrée</p></Crd>
          :<div style={{display:"flex",flexDirection:"column",gap:8}}>
            {ords.map(o=>{const isPeda=o.vtype==="peda";return(
              <div key={o.id} onClick={()=>{selOrd(o.id);nav("order-detail");}}
                style={{background:C.card,borderRadius:10,padding:"13px 16px",border:"1px solid "+C.bdr,cursor:"pointer",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}
                onMouseEnter={e=>e.currentTarget.style.background="#dbeafe"} onMouseLeave={e=>e.currentTarget.style.background=C.card}>
                <div style={{flex:1,minWidth:180}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:4}}>
                    <span style={{color:"#3b82f6",fontWeight:700,fontSize:12}}>{o.orderNum}</span>
                    <Badge status={o.status}/>
                    <span style={{fontSize:11,color:isPeda?"#c2410c":"#1d4ed8"}}>{isPeda?"🎓":"👤"}</span>
                    {o.signature&&<span style={{fontSize:11,color:"#059669"}}>✍</span>}
                  </div>
                  <div style={{color:C.txt,fontWeight:600}}>{o.plate} – {o.brand} {o.model}</div>
                  <div style={{color:C.sub,fontSize:12}}>{isPeda?(o.teacher||"—"):(o.clientName||"—")}</div>
                </div>
                <div style={{textAlign:"right",color:C.mut,fontSize:12}}>
                  <div>Entrée : {fD(o.entryDate)}</div>
                  {o.exitDate&&<div>Sortie : {fD(o.exitDate)}</div>}
                </div>
              </div>
            );})}
          </div>
      ) : (
        docs.length===0
          ?<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucun document</p></Crd>
          :<div style={{display:"flex",flexDirection:"column",gap:8}}>
            {docs.map(d=>{const t=docTotals(d);return(
              <div key={d.id} onClick={()=>openDoc(d.id,d.kind)}
                style={{background:C.card,borderRadius:10,padding:"13px 16px",border:"1px solid "+C.bdr,cursor:"pointer",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}
                onMouseEnter={e=>e.currentTarget.style.background="#dbeafe"} onMouseLeave={e=>e.currentTarget.style.background=C.card}>
                <div style={{flex:1,minWidth:180}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:4}}>
                    <span style={{color:"#1d4ed8",fontWeight:700,fontSize:12}}>{d.docNum}</span>
                    {d.kind==="estimate"&&(d.signature?<span style={{fontSize:11,color:"#059669"}}>✍ Signé</span>:<span style={{fontSize:11,color:"#c2410c"}}>Non signé</span>)}
                  </div>
                  <div style={{color:C.txt,fontWeight:600}}>{d.clientName||"—"}</div>
                  <div style={{color:C.sub,fontSize:12}}>{d.plate} {d.brand} {d.model}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{color:C.txt,fontWeight:700}}>{eur(t.ttc)}</div>
                  <div style={{color:C.mut,fontSize:12}}>{fD(d.createdAt)}</div>
                </div>
              </div>
            );})}
          </div>
      )}
    </div>
  );
}

const TI = { background:"#f8fafc", border:"1px solid "+C.bdr, borderRadius:6, padding:"7px 9px", color:C.txt, fontSize:13, outline:"none", fontFamily:"inherit", width:"100%" };

function TariffRow({ t, onSave, onDelete }) {
  const snap=()=>({ group:t.group, short:t.short, label:t.label, hint:t.hint, price:String(t.price).replace(".", ","), unit:t.unit });
  const [f,sf]=useState(snap);
  useEffect(()=>{ sf(snap()); },[t.id,t.group,t.short,t.label,t.hint,t.price,t.unit]); // eslint-disable-line
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  // on n'écrit en base que si la valeur a réellement changé
  const blur=(k)=>{ const v=k==="price"?num(f.price):(f[k]||""); if(v!==(k==="price"?t.price:(t[k]||""))) onSave({[k]:v}); };
  const fld=(k,ph,extra)=>(
    <input value={f[k]} onChange={e=>set(k,e.target.value)} onBlur={()=>blur(k)} placeholder={ph}
      list={k==="group"?"tarif-groupes":undefined} style={{...TI,...(extra||{})}}/>
  );
  return (
    <div style={{border:"1px solid "+C.bdr,borderRadius:10,padding:12,background:t.active?C.card:"#f8fafc",opacity:t.active?1:.65}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:8}}>
        <div style={{flex:"1 1 150px"}}><label style={{fontSize:11,color:C.mut}}>Groupe</label>{fld("group","Main-d'œuvre")}</div>
        <div style={{flex:"2 1 220px"}}><label style={{fontSize:11,color:C.mut}}>Libellé du bouton</label>{fld("short","T1 · Maintenance périodique")}</div>
        <div style={{flex:"0 0 110px"}}><label style={{fontSize:11,color:C.mut}}>Prix TTC (€)</label>{fld("price","20",{textAlign:"right"})}</div>
        <div style={{flex:"0 0 90px"}}><label style={{fontSize:11,color:C.mut}}>Unité</label>{fld("unit","h, g, forfait")}</div>
      </div>
      <div style={{marginBottom:8}}><label style={{fontSize:11,color:C.mut}}>Libellé porté sur le devis / la facture</label>{fld("label","Main-d'œuvre : maintenance périodique")}</div>
      <div style={{marginBottom:8}}><label style={{fontSize:11,color:C.mut}}>Précision affichée sous le bouton (facultatif)</label>{fld("hint","Temps selon barème constructeur")}</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:C.sub,cursor:"pointer"}}>
          <input type="checkbox" checked={!t.active} onChange={e=>onSave({active:!e.target.checked})}/>
          Masquer ce tarif (sans le supprimer)
        </label>
        <span style={{fontSize:12,color:C.mut}}>
          {t.price===0?"Gratuit":eur(t.price)+(t.unit?" / "+t.unit:"")}
          <Btn sm ghost danger onClick={()=>onDelete(t)} style={{marginLeft:10}}>🗑 Supprimer</Btn>
        </span>
      </div>
    </div>
  );
}

function AdminPanel({ students, staff, orders, tariffs, reloadTariffs, isAdmin, notify, reloadStudents, reloadStaff, currentId }) {
  const [tab,st]=useState("students");
  const [nu,snu]=useState({name:"",group:CLASSES[0],password:""});
  const [busy,sbusy]=useState(false);
  const [lastCreated,setLastCreated]=useState(null); // {identifier,password} à communiquer à l'élève
  const [nt,snt]=useState({identifier:"",name:"",password:""});
  const [tbusy,stbusy]=useState(false);
  const [lastT,setLastT]=useState(null);
  const addTeacher=async()=>{
    if(!nt.identifier.trim()||!nt.name.trim()){notify("Identifiant et pseudo obligatoires","error");return;}
    if(nt.password.length<6){notify("Mot de passe : 6 caractères minimum","error");return;}
    stbusy(true);
    try{
      const r=await createTeacher({identifier:nt.identifier.trim(),name:nt.name.trim(),password:nt.password});
      setLastT({identifier:r.identifier,password:nt.password});
      snt({identifier:"",name:"",password:""});
      notify("Compte enseignant créé : "+r.identifier);
      reloadStaff();
    }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
    finally{ stbusy(false); }
  };
  const delStaff=async(s)=>{
    if(!window.confirm("Supprimer le compte de "+s.name+" ("+s.identifier+") ?"))return;
    try{ await deleteAccount(s.id); notify("Compte supprimé"); reloadStaff(); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const resetStaff=async(s)=>{
    const np=window.prompt("Nouveau mot de passe pour "+s.name+" :");
    if(np==null)return; if(np.length<6){notify("Mot de passe : 6 caractères minimum","error");return;}
    try{ await resetPassword(s.id,np); notify("Mot de passe réinitialisé"); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  // ── Tarifs (administrateurs uniquement) ──
  const saveTarif=async(t,patch)=>{
    try{ await updateTariff(t.id,patch); reloadTariffs(); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const delTarif=async(t)=>{
    if(!window.confirm("Supprimer le tarif « "+(t.short||t.label)+" » ?\nLes devis et factures déjà établis ne sont pas modifiés."))return;
    try{ await deleteTariff(t.id); reloadTariffs(); notify("Tarif supprimé"); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const addTarif=async(grp)=>{
    const sameGrp=(tariffs||[]).filter(x=>x.group===grp);
    try{
      await insertTariff({ group:grp||"Divers", short:"Nouveau tarif", label:"Nouveau tarif", hint:"",
        price:0, unit:"", pos:sameGrp.reduce((m,x)=>Math.max(m,x.pos||0),0)+1, active:true });
      reloadTariffs(); notify("Tarif ajouté — complétez ses champs");
    }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const [newGrp,setNewGrp]=useState("");
  const stats=[
    {l:"Total interventions",v:orders.length,c:"#2563eb"},{l:"En attente",v:orders.filter(o=>o.status==="en_attente").length,c:"#f59e0b"},
    {l:"En cours",v:orders.filter(o=>o.status==="en_cours").length,c:"#3b82f6"},{l:"Terminées",v:orders.filter(o=>o.status==="termine").length,c:"#059669"},
    {l:"Clients",v:orders.filter(o=>o.vtype==="client").length,c:"#a78bfa"},{l:"Pédagogiques",v:orders.filter(o=>o.vtype==="peda").length,c:"#fb923c"},
    {l:"Signés",v:orders.filter(o=>o.signature).length,c:"#059669"},{l:"Staff",v:staff.length,c:C.txt},{l:"Élèves",v:students.length,c:"#15803d"},
  ];
  const addStu=async()=>{
    if(!nu.name.trim()){notify("Le nom de l'élève est obligatoire","error");return;}
    if(nu.password.length<6){notify("Mot de passe : 6 caractères minimum","error");return;}
    sbusy(true);
    try{
      const r=await createStudent({name:nu.name.trim(),group:nu.group.trim(),password:nu.password});
      setLastCreated({identifier:r.identifier,password:nu.password});
      snu({name:"",group:CLASSES[0],password:""});
      notify("Compte élève créé : "+r.identifier);
      reloadStudents();
    }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
    finally{ sbusy(false); }
  };
  const delStu=async(u)=>{
    if(!window.confirm("Supprimer le compte de "+u.name+" ("+u.identifier+") ?"))return;
    try{ await deleteAccount(u.id); notify("Compte supprimé"); reloadStudents(); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  const resetStu=async(u)=>{
    const np=window.prompt("Nouveau mot de passe pour "+u.name+" ("+u.identifier+") :");
    if(np==null)return;
    if(np.length<6){notify("Mot de passe : 6 caractères minimum","error");return;}
    try{ await resetPassword(u.id,np); notify("Mot de passe réinitialisé"); }
    catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
  };
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>⚙️ Administration</h2>
        <Btn sm onClick={()=>csvExport(toCSV(orders),"DMS_Export_"+today()+".csv")} style={{background:"#065f46"}}>⬇ Export complet</Btn>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {[["students","🎓 Élèves"],["staff","👤 Personnel"],...(isAdmin?[["tariffs","💶 Tarifs"]]:[]),["stats","📊 Statistiques"]].map(([id,l])=>(
          <button key={id} onClick={()=>st(id)} style={{padding:"8px 16px",borderRadius:6,cursor:"pointer",fontSize:13,border:"1px solid "+(tab===id?"#2563eb":C.bdr),background:tab===id?C.acc:"transparent",color:tab===id?"#fff":C.sub}}>{l}</button>
        ))}
      </div>
      {tab==="students"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Crd>
              <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,marginBottom:12}}>Créer un compte élève</h3>
              <p style={{color:C.mut,fontSize:12,marginBottom:12}}>L'identifiant de connexion de l'élève est son <b>nom complet</b> (il se connectera en tapant son nom + le mot de passe). Deux élèves ne peuvent pas avoir le même nom. Vous pourrez gérer (réinitialiser / supprimer) <b>uniquement les élèves que vous créez</b> ; l'administrateur peut tous les gérer.</p>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:12}}>
                <Inp label="Nom complet *" value={nu.name} onChange={v=>snu(p=>({...p,name:v}))} placeholder="Jean Martin"/>
                <Sel label="Classe" value={nu.group} onChange={v=>snu(p=>({...p,group:v}))} opts={CLASSES.map(c=>({v:c,l:c}))}/>
                <Inp label="Mot de passe *" value={nu.password} onChange={v=>snu(p=>({...p,password:v}))} type="password" placeholder="6 caractères min."/>
              </div>
              <Btn sm onClick={addStu} disabled={busy}>{busy?"Création…":"+ Créer le compte élève"}</Btn>
              {lastCreated&&(
                <div style={{marginTop:12,padding:12,background:"#dcfce7",border:"1px solid #15803d",borderRadius:8,fontSize:13,color:"#166534"}}>
                  ✅ Compte créé — à communiquer à l'élève :<br/>
                  Identifiant : <b>{lastCreated.identifier}</b> · Mot de passe : <b>{lastCreated.password}</b>
                </div>
              )}
            </Crd>
          {students.length===0&&<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucun élève enregistré</p></Crd>}
          {students.map(u=>(
            <Crd key={u.id}>
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{flex:1}}>
                  <span style={{color:C.txt,fontWeight:600}}>{u.name}</span>
                  {u.group&&<span style={{marginLeft:8,fontSize:11,padding:"2px 8px",borderRadius:999,fontWeight:600,background:"#dcfce7",color:"#15803d"}}>{u.group}</span>}
                  {u.identifier&&<div style={{color:C.mut,fontSize:12,marginTop:2}}>🔑 {u.identifier}</div>}
                  {u.createdBy===currentId&&<div style={{color:"#059669",fontSize:11,marginTop:2}}>✓ créé par vous</div>}
                </div>
                {(isAdmin||u.createdBy===currentId)&&(
                  <div style={{display:"flex",gap:6}}>
                    <Btn sm ghost onClick={()=>resetStu(u)}>Réinit. mdp</Btn>
                    <Btn sm danger onClick={()=>delStu(u)}>Supprimer</Btn>
                  </div>
                )}
              </div>
            </Crd>
          ))}
        </div>
      )}
      {tab==="staff"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {isAdmin ? (
            <Crd>
              <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,marginBottom:12}}>Créer un compte enseignant</h3>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:12}}>
                <Inp label="Identifiant de connexion *" value={nt.identifier} onChange={v=>snt(p=>({...p,identifier:v}))} placeholder="jdupont"/>
                <Inp label="Pseudo affiché *" value={nt.name} onChange={v=>snt(p=>({...p,name:v}))} placeholder="M. Dupont"/>
                <Inp label="Mot de passe *" value={nt.password} onChange={v=>snt(p=>({...p,password:v}))} type="password" placeholder="6 caractères min."/>
              </div>
              <Btn sm onClick={addTeacher} disabled={tbusy}>{tbusy?"Création…":"+ Créer le compte enseignant"}</Btn>
              {lastT&&(
                <div style={{marginTop:12,padding:12,background:"#dcfce7",border:"1px solid #15803d",borderRadius:8,fontSize:13,color:"#166534"}}>
                  ✅ Compte créé — identifiant : <b>{lastT.identifier}</b> · mot de passe : <b>{lastT.password}</b>
                </div>
              )}
            </Crd>
          ) : (
            <Crd style={{background:"#f1f5f9"}}>
              <p style={{color:C.sub,fontSize:13,margin:0}}>La gestion des comptes du personnel est réservée à l'administrateur.</p>
            </Crd>
          )}
          {staff.map(s=>{const rs=ROLE_STYLE[s.role]||{bg:"#e2e8f0",cl:C.sub};const protege=s.role==="admin"||s.id===currentId;return(
            <Crd key={s.id}>
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{flex:1}}>
                  <span style={{color:C.txt,fontWeight:600}}>{s.name}</span>
                  {s.identifier&&<div style={{color:C.mut,fontSize:12,marginTop:2}}>🔑 {s.identifier}</div>}
                </div>
                <span style={{fontSize:11,padding:"2px 8px",borderRadius:999,fontWeight:600,background:rs.bg,color:rs.cl}}>{roleLabel(s.role)}</span>
                {isAdmin&&!protege&&(
                  <div style={{display:"flex",gap:6}}>
                    <Btn sm ghost onClick={()=>resetStaff(s)}>Réinit. mdp</Btn>
                    <Btn sm danger onClick={()=>delStaff(s)}>Supprimer</Btn>
                  </div>
                )}
              </div>
            </Crd>
          );})}
        </div>
      )}
      {tab==="tariffs"&&isAdmin&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <datalist id="tarif-groupes">{tarifGroups(tariffs).map(g=><option key={g} value={g}/>)}</datalist>
          <Crd>
            <h3 style={{color:"#2563eb",fontSize:15,fontWeight:700,margin:"0 0 6px"}}>💶 Tarifs de l'atelier</h3>
            <p style={{color:C.sub,fontSize:13,margin:0}}>
              Ces tarifs alimentent les boutons des <b>estimations</b> et des <b>factures</b>. Les modifications sont
              enregistrées dès que vous quittez un champ, et visibles immédiatement par tout le personnel.
              Les montants saisis ici sont ceux <b>payés par le client, toutes taxes comprises</b> : les documents sont
              établis en TTC (chaque document peut être basculé en HT si besoin). Les devis et factures déjà établis
              conservent leurs montants.
            </p>
          </Crd>
          {tarifGroups(tariffs).map(g=>(
            <Crd key={g}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:10}}>
                <h4 style={{margin:0,fontSize:14,fontWeight:700,color:C.txt}}>{g}</h4>
                <Btn sm ghost onClick={()=>addTarif(g)}>+ Ajouter un tarif dans « {g} »</Btn>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {tariffs.filter(t=>t.group===g).map(t=>(
                  <TariffRow key={t.id} t={t} onSave={patch=>saveTarif(t,patch)} onDelete={delTarif}/>
                ))}
              </div>
            </Crd>
          ))}
          <Crd>
            <h4 style={{margin:"0 0 8px",fontSize:14,fontWeight:700,color:C.txt}}>Nouveau groupe de tarifs</h4>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{flex:"1 1 220px"}}>
                <label style={{fontSize:11,color:C.mut}}>Nom du groupe</label>
                <input value={newGrp} onChange={e=>setNewGrp(e.target.value)} placeholder="Pneumatiques, Carrosserie…" style={TI}/>
              </div>
              <Btn sm onClick={()=>{ if(!newGrp.trim()){notify("Donnez un nom au groupe","error");return;} addTarif(newGrp.trim()); setNewGrp(""); }}>+ Créer le groupe</Btn>
            </div>
          </Crd>
          {(!tariffs||tariffs.length===0)&&(
            <Crd><p style={{color:C.mut,fontSize:13,margin:0}}>Aucun tarif pour le moment. Créez un groupe ci-dessus pour commencer.</p></Crd>
          )}
        </div>
      )}
      {tab==="stats"&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12}}>
          {stats.map(s=><Crd key={s.l} style={{textAlign:"center"}}><div style={{fontSize:34,fontWeight:700,color:s.c}}>{s.v}</div><div style={{fontSize:12,color:C.sub,marginTop:4}}>{s.l}</div></Crd>)}
        </div>
      )}
    </div>
  );
}

// ── Estimations / Factures ──
function DocsList({ kind, documents, openDoc, newDoc }) {
  const [q,sq]=useState("");
  const label=DOC_LABEL[kind];
  const list=documents.filter(d=>d.kind===kind)
    .filter(d=>!q||[d.docNum,d.clientName,d.plate,d.brand,d.model].join(" ").toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>{kind==="estimate"?"🧾 Estimations":"💶 Factures"}</h2>
        <Btn onClick={newDoc}>+ Nouvelle {label.toLowerCase()}</Btn>
      </div>
      <input value={q} onChange={e=>sq(e.target.value)} placeholder="🔍 N°, client, immatriculation..."
        style={{background:C.card,border:"1px solid "+C.bdr,borderRadius:8,padding:"10px 14px",color:C.txt,fontSize:13,outline:"none"}}/>
      {list.length===0
        ?<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucune {label.toLowerCase()}</p></Crd>
        :<div style={{display:"flex",flexDirection:"column",gap:8}}>
          {list.map(d=>{const t=docTotals(d);return(
            <div key={d.id} onClick={()=>openDoc(d.id,kind)}
              style={{background:C.card,borderRadius:10,padding:"13px 16px",border:"1px solid "+C.bdr,cursor:"pointer",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}
              onMouseEnter={e=>e.currentTarget.style.background="#dbeafe"} onMouseLeave={e=>e.currentTarget.style.background=C.card}>
              <div style={{flex:1,minWidth:180}}>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:4}}>
                  <span style={{color:"#1d4ed8",fontWeight:700,fontSize:12}}>{d.docNum}</span>
                  {kind==="estimate"&&(d.signature?<span style={{fontSize:11,color:"#059669"}}>✍ Signé</span>:<span style={{fontSize:11,color:"#c2410c"}}>Non signé</span>)}
                </div>
                <div style={{color:C.txt,fontWeight:600}}>{d.clientName||"—"}</div>
                <div style={{color:C.sub,fontSize:12}}>{d.plate} {d.brand} {d.model}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{color:C.txt,fontWeight:700}}>{eur(t.ttc)}</div>
                <div style={{color:C.mut,fontSize:12}}>{fD(d.createdAt)}</div>
              </div>
            </div>
          );})}
        </div>}
    </div>
  );
}

function DocForm({ kind, initial, orders, documents, tariffs, addDocument, editDocument, removeDocument, isAdmin, user, nav, notify }) {
  const label=DOC_LABEL[kind];
  const back=()=>nav(kind==="estimate"?"estimates":"invoices");
  const [d,sd]=useState(()=> initial ? {...initial} : { kind, orderId:"", clientName:"", clientPhone:"", plate:"", brand:"", model:"", year:"", km:"", items:[], tvaRate:0, priceMode:"ttc", signature:"", notes:"", validUntil:"" });
  const [busy,sbusy]=useState(false);
  const [srcEst,setSrcEst]=useState("");
  const isNew=!d.id;
  const estimates=(documents||[]).filter(x=>x.kind==="estimate");
  const fromEstimate=(eid)=>{ setSrcEst(eid); sd(p=>{
    const e=estimates.find(x=>x.id===eid);
    if(!e) return p;
    return {...p, orderId:e.orderId||p.orderId||"",
      clientName:e.clientName||"", clientPhone:e.clientPhone||"",
      plate:e.plate||"", brand:e.brand||"", model:e.model||"",
      year:e.year||"", km:e.km||"",
      items:(e.items&&e.items.length)?e.items.map(it=>({...it})):p.items,
      tvaRate:e.tvaRate??p.tvaRate, priceMode:e.priceMode||p.priceMode, notes:e.notes||p.notes };
  }); };
  const set=(k,v)=>sd(p=>({...p,[k]:v}));
  const linkOrder=(oid)=>sd(p=>{
    const o=orders.find(x=>x.id===oid);
    if(!o) return {...p,orderId:oid};
    return {...p,orderId:oid,
      clientName:p.clientName||o.clientName||"", clientPhone:p.clientPhone||o.clientPhone||"",
      plate:p.plate||o.plate||"", brand:p.brand||o.brand||"", model:p.model||o.model||"",
      year:p.year||o.year||"", km:p.km||o.km||"",
      items:(p.items&&p.items.length)?p.items:(o.tasks||[]).map(tk=>({label:tk.label,qty:1,unitPrice:0})),
    };
  });
  const addLine=()=>sd(p=>({...p,items:[...p.items,{label:"",qty:1,unitPrice:0,unit:""}]}));
  const addTarif=(t)=>sd(p=>({...p,items:[...p.items,{label:t.label||t.short,qty:1,unitPrice:t.price,unit:t.unit}]}));
  const tarifs=(tariffs||[]).filter(t=>t.active);
  const setLine=(i,k,v)=>sd(p=>({...p,items:p.items.map((it,j)=>j===i?{...it,[k]:v}:it)}));
  const delLine=(i)=>sd(p=>({...p,items:p.items.filter((_,j)=>j!==i)}));
  const t=docTotals(d);
  const save=async()=>{
    if(!d.clientName.trim()){notify("Le nom du client est obligatoire","error");return;}
    const clean={...d, tvaRate:num(d.tvaRate), priceMode:d.priceMode==="ht"?"ht":"ttc",
      items:d.items.map(it=>({label:it.label||"",qty:Number(it.qty)||0,unitPrice:Number(it.unitPrice)||0,unit:it.unit||""}))};
    sbusy(true);
    try{
      if(isNew){ const created=await addDocument({...clean,createdBy:user.name}); sd(created); notify(label+" créée : "+created.docNum); archiveDocToDrive(created,notify); }
      else { const upd=await editDocument(d.id,clean); sd(upd); notify(label+" enregistrée"); }
    }catch(e){ console.error(e); notify("Erreur : "+(e.message||e),"error"); }
    finally{ sbusy(false); }
  };
  const del=async()=>{ if(!window.confirm("Supprimer "+(d.docNum||"ce document")+" ?"))return; try{ await removeDocument(d.id); notify("Supprimé"); back(); }catch(e){console.error(e);notify("Erreur : "+(e.message||e),"error");} };
  return (
    <div style={{maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>{kind==="estimate"?"🧾":"💶"} {isNew?"Nouvelle "+label.toLowerCase():d.docNum}</h2>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {!isNew&&<Btn sm ghost onClick={()=>generateDocPDF(d)} style={{borderColor:"#1d4ed8",color:"#1d4ed8"}}>📄 PDF</Btn>}
          {!isNew&&<Btn sm ghost onClick={()=>archiveDocToDrive(d,notify)} style={{borderColor:"#16a34a",color:"#059669"}}>📁 Drive</Btn>}
          <Btn sm ghost onClick={back}>← Retour</Btn>
        </div>
      </div>
      <Crd>
        {kind==="invoice"&&estimates.length>0&&(
          <div style={{marginBottom:8}}>
            <SecTitle>📋 Reprendre une estimation (optionnel)</SecTitle>
            <Sel label="Estimation source" value={srcEst} onChange={fromEstimate} opts={[{v:"",l:"— Aucune —"},...estimates.map(e=>({v:e.id,l:e.docNum+" · "+(e.clientName||e.plate||"")+" · "+eur(docTotals(e).ttc)}))]}/>
            {srcEst&&<p style={{color:"#059669",fontSize:12,marginTop:6}}>✅ Données reprises de l'estimation (client, véhicule, lignes, TVA). Modifiables ci-dessous.</p>}
          </div>
        )}
        <SecTitle>🔗 Lier à un ordre de réparation (optionnel)</SecTitle>
        <Sel label="Ordre" value={d.orderId} onChange={linkOrder} opts={[{v:"",l:"— Aucun (saisie libre) —"},...orders.map(o=>({v:o.id,l:o.orderNum+" · "+(o.clientName||o.plate||"")}))]}/>
        <SecTitle>👤 Client</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
          <Inp label="Nom du client *" value={d.clientName} onChange={v=>set("clientName",v)} placeholder="M. Dupont"/>
          <Inp label="Téléphone" value={d.clientPhone} onChange={v=>set("clientPhone",v)} placeholder="06 12 34 56 78"/>
        </div>
        <SecTitle>🚗 Véhicule</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12}}>
          <Inp label="Immatriculation" value={d.plate} onChange={v=>set("plate",v)} placeholder="AB-123-CD"/>
          <Inp label="Marque" value={d.brand} onChange={v=>set("brand",v)}/>
          <Inp label="Modèle" value={d.model} onChange={v=>set("model",v)}/>
          <Inp label="Année" value={d.year} onChange={v=>set("year",v)}/>
          <Inp label="Km" value={d.km} onChange={v=>set("km",v)}/>
        </div>
        <SecTitle>💶 Tarifs de l'atelier</SecTitle>
        <p style={{color:C.mut,fontSize:12,margin:"0 0 10px"}}>Un clic ajoute la ligne au document ; il ne reste qu'à saisir la quantité (heures, grammes…). Les montants sont repris {isTTC(d)?<b>tels quels : ce sont ceux payés par le client (TTC)</b>:<b>comme des prix hors taxes</b>}.</p>
        {tarifs.length===0&&(
          <p style={{color:C.mut,fontSize:13,margin:"0 0 10px"}}>Aucun tarif enregistré. Un administrateur peut les définir dans <b>Administration → 💶 Tarifs</b>.</p>
        )}
        {tarifGroups(tarifs).map(g=>(
          <div key={g} style={{marginBottom:10}}>
            <div style={{fontSize:11,color:C.mut,fontWeight:700,textTransform:"uppercase",letterSpacing:.4,marginBottom:6}}>{g}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {tarifs.filter(t=>t.group===g).map(t=>(
                <button key={t.id} type="button" onClick={()=>addTarif(t)} title={t.label}
                  style={{flex:"1 1 200px",maxWidth:340,textAlign:"left",background:"#f8fafc",border:"1px solid "+C.bdr,borderRadius:8,padding:"8px 10px",cursor:"pointer",color:C.txt,fontFamily:"inherit"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="#3b82f6";e.currentTarget.style.background="#eff6ff";}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.bdr;e.currentTarget.style.background="#f8fafc";}}>
                  <span style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
                    <span style={{fontSize:13,fontWeight:600}}>{t.short||t.label}</span>
                    <span style={{fontSize:13,fontWeight:700,color:t.price===0?"#15803d":"#1d4ed8",whiteSpace:"nowrap"}}>{t.price===0?"Gratuit":eur(t.price)+(t.unit?" / "+t.unit:"")}</span>
                  </span>
                  {t.hint&&<span style={{display:"block",fontSize:11,color:C.mut,marginTop:2}}>{t.hint}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <SecTitle>📋 Lignes (prestations / pièces)</SecTitle>
        <div style={{display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap",marginBottom:12}}>
          <div style={{flex:"0 1 320px"}}>
            <Sel label="Prix saisis" value={isTTC(d)?"ttc":"ht"} onChange={v=>set("priceMode",v)}
              opts={[{v:"ttc",l:"TTC — montants payés par le client"},{v:"ht",l:"HT — la TVA s'ajoute au montant"}]}/>
          </div>
          <p style={{flex:"1 1 220px",color:C.mut,fontSize:12,margin:0}}>
            {isTTC(d)
              ? (num(d.tvaRate)>0
                  ? "Le total est la somme des lignes ; la TVA est calculée à l'intérieur de ce montant."
                  : "Le total est la somme des lignes. TVA à 0 % : aucune taxe n'est ajoutée ni décomptée.")
              : "La TVA est ajoutée au total des lignes pour obtenir le montant payé par le client."}
          </p>
        </div>
        <div style={{overflowX:"auto"}}>
         <div style={{minWidth:540,display:"flex",flexDirection:"column",gap:6}}>
          <div style={{display:"flex",gap:8,fontSize:11,color:C.mut,fontWeight:600,padding:"0 4px"}}>
            <span style={{flex:1}}>Désignation</span><span style={{width:62,textAlign:"right"}}>Qté</span><span style={{width:52}}>Unité</span><span style={{width:88,textAlign:"right"}}>{isTTC(d)?(num(d.tvaRate)>0?"PU TTC":"PU"):"PU HT"}</span><span style={{width:92,textAlign:"right"}}>Total</span><span style={{width:24}}/>
          </div>
          {d.items.map((it,i)=>{const lt=(Number(it.qty)||0)*(Number(it.unitPrice)||0);return(
            <div key={i} style={{display:"flex",gap:8,alignItems:"center"}}>
              <input value={it.label} onChange={e=>setLine(i,"label",e.target.value)} placeholder="Vidange, plaquettes..." style={{flex:1,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 9px",color:C.txt,fontSize:13,outline:"none"}}/>
              <input type="number" step="any" value={it.qty} onChange={e=>setLine(i,"qty",e.target.value)} style={{width:62,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 6px",color:C.txt,fontSize:13,outline:"none",textAlign:"right"}}/>
              <input value={it.unit||""} onChange={e=>setLine(i,"unit",e.target.value)} placeholder="h, g…" style={{width:52,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 6px",color:C.sub,fontSize:12,outline:"none"}}/>
              <input type="number" step="any" value={it.unitPrice} onChange={e=>setLine(i,"unitPrice",e.target.value)} style={{width:88,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 6px",color:C.txt,fontSize:13,outline:"none",textAlign:"right"}}/>
              <span style={{width:92,textAlign:"right",fontSize:13,fontWeight:600,color:C.txt}}>{eur(lt)}</span>
              <button onClick={()=>delLine(i)} style={{width:24,background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:18}}>×</button>
            </div>
          );})}
          <div><Btn sm ghost onClick={addLine}>+ Ajouter une ligne libre</Btn></div>
         </div>
        </div>
        <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
          <div style={{width:280,display:"flex",flexDirection:"column",gap:6}}>
            {num(d.tvaRate)>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.sub}}><span>Total HT</span><b style={{color:C.txt}}>{eur(t.ht)}</b></div>}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13,color:C.sub}}>
              <span style={{display:"flex",alignItems:"center",gap:6}}>TVA <input type="number" value={d.tvaRate} onChange={e=>set("tvaRate",e.target.value)} style={{width:54,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"3px 6px",color:C.txt,fontSize:12,textAlign:"right"}}/>%</span>
              <b style={{color:C.txt}}>{eur(t.tva)}</b>
            </div>
            {num(d.tvaRate)===0&&(
              <div style={{fontSize:11,color:C.mut,textAlign:"right",marginTop:-2}}>
                Le document portera la mention « TVA non applicable - 0% ».
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:700,color:"#1d4ed8",borderTop:"2px solid "+C.bdr,paddingTop:6}}><span>Total{num(d.tvaRate)>0?" TTC":""}</span><span>{eur(t.ttc)}</span></div>
          </div>
        </div>
        <SecTitle>📝 Notes & validité</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12}}>
          <TA label="Notes" value={d.notes} onChange={v=>set("notes",v)} placeholder="Conditions, remarques..." rows={3}/>
          <Inp label={kind==="estimate"?"Valable jusqu'au":"Échéance de paiement"} value={d.validUntil} onChange={v=>set("validUntil",v)} type="date"/>
        </div>
        {kind==="estimate"&&(
          <div>
            <SecTitle>✍ Signature du client (bon pour accord)</SecTitle>
            <div style={{background:"#f1f5f9",borderRadius:10,padding:16,border:"1px solid "+C.bdr}}>
              {d.signature?(
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                    <span style={{color:"#059669",fontSize:13,fontWeight:600}}>✅ Signée</span>
                    <Btn sm ghost onClick={()=>set("signature","")}>Refaire la signature</Btn>
                  </div>
                  <img src={d.signature} alt="Signature" style={{maxHeight:80,background:"#fff",borderRadius:6,padding:4,display:"block"}}/>
                </div>
              ):<SigPad onSave={v=>set("signature",v)}/>}
            </div>
          </div>
        )}
        <div style={{display:"flex",justifyContent:"space-between",gap:10,marginTop:20,paddingTop:16,borderTop:"1px solid "+C.bdr,flexWrap:"wrap"}}>
          <div>{!isNew&&isAdmin&&<Btn ghost danger onClick={del}>Supprimer</Btn>}</div>
          <div style={{display:"flex",gap:10}}>
            <Btn ghost onClick={back}>Annuler</Btn>
            <Btn onClick={save} disabled={busy}>{busy?"Enregistrement…":(isNew?"✅ Créer":"💾 Enregistrer")}</Btn>
          </div>
        </div>
      </Crd>
    </div>
  );
}

// ── Mon compte (admin + enseignant) : mot de passe & statistiques personnelles ──
function AccountPanel({ user, orders, documents, students, notify }) {
  const [p,sp]=useState(""); const [p2,sp2]=useState("");
  const [busy,sb]=useState(false); const [err,se]=useState("");
  const [tours,setTours]=useState(undefined);   // undefined = chargement · null = indisponible
  useEffect(()=>{ let on=true; countInspectionsBy(user.name).then(v=>{ if(on) setTours(v); }); return ()=>{on=false;}; },[user.name]);
  const changePwd=async()=>{
    se("");
    if(p.length<6){se("6 caractères minimum");return;}
    if(p!==p2){se("Les deux mots de passe ne correspondent pas");return;}
    sb(true);
    const { error } = await supabase.auth.updateUser({ password:p });
    sb(false);
    if(error){se(error.message);return;}
    sp(""); sp2(""); notify("Mot de passe modifié");
  };
  const byMe=(v)=>v===user.name;
  const myEst=documents.filter(d=>d.kind==="estimate"&&byMe(d.createdBy));
  const myInv=documents.filter(d=>d.kind==="invoice"&&byMe(d.createdBy));
  const rs=ROLE_STYLE[user.role]||{bg:"#e2e8f0",cl:C.sub};
  const stats=[
    {l:"Élèves créés",v:students.filter(s=>s.createdBy===user.id).length,c:"#15803d"},
    {l:"OR suivis (référent)",v:orders.filter(o=>byMe(o.teacher)).length,c:"#2563eb"},
    {l:"OR créés par moi",v:orders.filter(o=>byMe(o.createdBy)).length,c:"#1d4ed8"},
    {l:"OR terminés (référent)",v:orders.filter(o=>byMe(o.teacher)&&o.status==="termine").length,c:"#059669"},
    {l:"Tours de véhicule validés",v:tours===undefined?"…":(tours===null?"—":tours),c:"#c2410c"},
    {l:"Estimations établies",v:myEst.length,c:"#7c3aed"},
    {l:"dont signées client",v:myEst.filter(d=>d.signature).length,c:"#059669"},
    {l:"Factures établies",v:myInv.length,c:"#b45309"},
    {l:"Total facturé TTC",v:eur(myInv.reduce((a,d)=>a+docTotals(d).ttc,0)),c:"#1d4ed8"},
  ];
  return (
    <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:16}}>
      <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>👤 Mon compte</h2>
      <Crd>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <span style={{color:C.txt,fontWeight:700,fontSize:16}}>{user.name}</span>
          <span style={{fontSize:11,padding:"2px 8px",borderRadius:999,fontWeight:600,background:rs.bg,color:rs.cl}}>{roleLabel(user.role)}</span>
        </div>
      </Crd>

      <div>
        <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,marginBottom:10}}>📊 Mes statistiques</h3>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12}}>
          {stats.map(st=>(
            <Crd key={st.l} style={{textAlign:"center"}}>
              <div style={{fontSize:st.l.startsWith("Total")?22:34,fontWeight:700,color:st.c}}>{st.v}</div>
              <div style={{fontSize:12,color:C.sub,marginTop:4}}>{st.l}</div>
            </Crd>
          ))}
        </div>
        {tours===null&&<p style={{color:C.mut,fontSize:12,marginTop:8}}>Les tours de véhicule proviennent de l'application de réception ; la donnée n'est pas accessible pour l'instant.</p>}
      </div>

      <Crd>
        <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,marginBottom:12}}>🔑 Modifier mon mot de passe</h3>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12,marginBottom:12}}>
          <Inp label="Nouveau mot de passe" value={p} onChange={sp} type="password" placeholder="6 caractères min."/>
          <Inp label="Confirmer" value={p2} onChange={sp2} type="password" placeholder="••••••••"/>
        </div>
        {err&&<p style={{color:"#dc2626",fontSize:13,margin:"0 0 10px"}}>{err}</p>}
        <Btn sm onClick={changePwd} disabled={busy}>{busy?"Enregistrement…":"Modifier le mot de passe"}</Btn>
      </Crd>
    </div>
  );
}

export default function DMSApp() {
  const { user:cu, ready, recovery, clearRecovery } = useSession();
  const { orders, addOrder, editOrder, removeOrder } = useOrders(cu?.id);
  const { students, reloadStudents } = useStudents(cu?.id);
  const { documents, addDocument, editDocument, removeDocument } = useDocuments(cu?.id);
  const { tariffs, reloadTariffs } = useTariffs(cu?.id);
  const { vehicleHistory, addVh, editVh, removeVh } = useVehicleHistory(cu?.id);
  const [staff,setStaff]=useState([]);
  const [page,sp]=useState("dashboard");
  const [selId,ssi]=useState(null); const [sideOpen,sso]=useState(false);
  const [selDoc,ssd]=useState(null); const [docKind,sdk]=useState("estimate");
  const openDoc=(id,kind)=>{ ssd(id); sdk(kind); sp("doc-form"); sso(false); };
  const newDoc=(kind)=>{ ssd(null); sdk(kind); sp("doc-form"); sso(false); };
  const [notif,sn]=useState(null);
  const isDesktop=useDesktop();
  const notify=useCallback((msg,type)=>{sn({msg,type:type||"success"});setTimeout(()=>sn(null),3500);},[]);
  const reloadStaff=useCallback(()=>{ listStaff().then(setStaff).catch(e=>console.error(e)); },[]);
  useEffect(()=>{ if(cu) reloadStaff(); },[cu,reloadStaff]);
  const nav=p=>{sp(p);sso(false);};
  const logout=async()=>{ await supabase.auth.signOut(); sp("dashboard"); ssi(null); };
  if(!ready)return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,color:C.sub,fontFamily:"system-ui,sans-serif"}}>Chargement…</div>);
  if(recovery)return<ResetPasswordView notify={notify} onDone={async()=>{clearRecovery();await supabase.auth.signOut();}}/>;
  if(!cu)return<LoginView/>;
  const isStaff=cu.role!=="eleve"; const isAdmin=cu.role==="admin";
  const rs=ROLE_STYLE[cu.role]||{bg:"#e2e8f0",cl:C.sub};
  const renderPage=()=>{
    if(page==="dashboard")    return<Dashboard orders={orders} nav={nav} selOrd={ssi}/>;
    if(page==="orders")       return<OrdersList orders={orders} nav={nav} selOrd={ssi}/>;
    if(page==="vehicles")     return <VehiclesView orders={orders} documents={documents} vehicleHistory={vehicleHistory} user={cu} nav={nav} selOrd={ssi} openDoc={openDoc} addVh={addVh} editVh={editVh} removeVh={removeVh} notify={notify}/>;
    if(page==="new-order")    return <NewOrderForm addOrder={addOrder} teachers={staff} students={students} user={cu} nav={nav} selOrd={ssi} notify={notify}/>;
    if(page==="order-detail") return selId?<OrderDetail orderId={selId} orders={orders} editOrder={editOrder} removeOrder={removeOrder} isAdmin={isAdmin} user={cu} nav={nav} notify={notify} students={students}/>:null;
    if(page==="estimates")    return <DocsList kind="estimate" documents={documents} openDoc={openDoc} newDoc={()=>newDoc("estimate")}/>;
    if(page==="invoices")     return <DocsList kind="invoice" documents={documents} openDoc={openDoc} newDoc={()=>newDoc("invoice")}/>;
    if(page==="doc-form")     return <DocForm kind={docKind} initial={selDoc?documents.find(d=>d.id===selDoc):null} orders={orders} documents={documents} tariffs={tariffs} addDocument={addDocument} editDocument={editDocument} removeDocument={removeDocument} isAdmin={isAdmin} user={cu} nav={nav} notify={notify}/>;
    if(page==="history")      return<HistoryView orders={orders} documents={documents} nav={nav} selOrd={ssi} openDoc={openDoc}/>;
    if(page==="account")      return isStaff?<AccountPanel user={cu} orders={orders} documents={documents} students={students} notify={notify}/>:null;
    if(page==="admin")        return isStaff?<AdminPanel students={students} staff={staff} orders={orders} tariffs={tariffs} reloadTariffs={reloadTariffs} isAdmin={isAdmin} notify={notify} reloadStudents={reloadStudents} reloadStaff={reloadStaff} currentId={cu.id}/>:null;
    return null;
  };
  return (
    <div style={{minHeight:"100vh",display:"flex",background:C.bg,color:C.txt,fontFamily:"system-ui,-apple-system,sans-serif"}}>
      {notif&&(
        <div style={{position:"fixed",top:16,right:16,zIndex:100,padding:"12px 18px",borderRadius:10,background:notif.type==="success"?"#052e16":"#450a0a",border:"1px solid "+(notif.type==="success"?"#16a34a":"#dc2626"),color:"#fff",fontSize:14,fontWeight:500,boxShadow:"0 8px 25px rgba(0,0,0,.5)",maxWidth:320}}>
          {notif.type==="success"?"✅":"❌"} {notif.msg}
        </div>
      )}
      {sideOpen&&!isDesktop&&<div onClick={()=>sso(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:48}}/>}
      <div style={{position:isDesktop?"sticky":"fixed",top:0,left:0,height:"100vh",zIndex:49,flexShrink:0,transform:isDesktop||sideOpen?"none":"translateX(-100%)",transition:"transform .25s ease"}}>
        <Sidebar user={cu} page={page} nav={nav} logout={logout}/>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:C.hdr,borderBottom:"1px solid "+C.bdr,position:"sticky",top:0,zIndex:30}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {!isDesktop&&<button onClick={()=>sso(true)} style={{background:"none",border:"none",color:C.sub,cursor:"pointer",fontSize:22,padding:"2px 6px",lineHeight:1}}>☰</button>}
            <div style={{display:"flex",alignItems:"center",gap:8}}><img src={LOGO} alt="" style={{width:28,height:28,borderRadius:"50%",flexShrink:0}}/><div><div style={{color:"#3b82f6",fontWeight:700,fontSize:14}}>DMS – Atelier BTS MV</div><div style={{color:C.mut,fontSize:11}}>Lycée Gallieni</div></div></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {isDesktop&&<span style={{color:C.sub,fontSize:13}}>{cu.name}</span>}
            <span style={{fontSize:11,padding:"3px 10px",borderRadius:999,fontWeight:600,background:rs.bg,color:rs.cl}}>{roleLabel(cu.role)}</span>
          </div>
        </header>
        <main style={{flex:1,padding:16,overflowY:"auto"}}>{renderPage()}</main>
      </div>
      <style>{`*{box-sizing:border-box;margin:0;}input[type=checkbox]{cursor:pointer;width:16px;height:16px;}::-webkit-scrollbar{width:6px;}::-webkit-scrollbar-track{background:#e2e8f0;}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px;}`}</style>
    </div>
  );
}