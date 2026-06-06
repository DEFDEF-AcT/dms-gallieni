import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";
import {
  listOrders, insertOrder, updateOrder as dbUpdateOrder, deleteOrder,
  listStudents, listStaff,
  createStudent, createTeacher, deleteAccount, resetPassword,
  archiveOrder,
  listDocuments, insertDocument, updateDocument, deleteDocument,
} from "./data";

// Montants / TVA
const eur = (n) => (Number(n) || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
function docTotals(doc) {
  const ht = (doc.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const tva = ht * (Number(doc.tvaRate) || 0) / 100;
  return { ht, tva, ttc: ht + tva };
}
const DOC_LABEL = { estimate: "Estimation", invoice: "Facture" };

// Archive un OR en PDF sur le Drive (asynchrone, non bloquant).
function archiveToDrive(order, notify) {
  archiveOrder({ html: orderHTML(order), folder: orderFolder(order), orderNum: order.orderNum })
    .then(() => notify && notify("Ordre archivé sur le Drive"))
    .catch((e) => { console.error("[DMS] archivage Drive", e); notify && notify("Archivage Drive non effectué : " + (e.message || e), "error"); });
}

// Domaine interne des identifiants élèves (doit correspondre à l'Edge Function).
const STUDENT_DOMAIN = "eleve.gallieni.local";
// « Etudiant1 » → « etudiant1@eleve.gallieni.local » ; un email (avec @) est laissé tel quel.
const toLoginEmail = (v) => v.includes("@") ? v.trim() : v.trim().toLowerCase() + "@" + STUDENT_DOMAIN;

const VS = {
  en_attente: { label: "En attente", col: "#F59E0B" },
  en_cours:   { label: "En cours",   col: "#60A5FA" },
  termine:    { label: "Termine",    col: "#34D399" },
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
  "Vidange moteur + filtre huile","Remplacement filtre a air",
  "Controle plaquettes frein AV","Controle plaquettes frein AR",
  "Controle niveaux","Diagnostic electronique OBD",
  "Controle pneumatiques","Controle eclairage / signalisation",
  "Controle batterie / charge","Climatisation controle / recharge",
  "Remplacement courroie distribution","Controle geometrie",
];

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
  const H = ["N.OR","Ref.","Immat.","Marque","Modele","Annee","KM","Type","Client/Enseignant","Eleves","Motif","Date entree","Heure","Date sortie","Statut","Taches OK","Taches total","Observations","Ventes add.","Signature accord","Cree par"];
  return [H, ...orders.map(o => [
    o.orderNum, o.fileRef||"", o.plate, o.brand, o.model, o.year||"", o.km||"",
    o.vtype==="peda"?"Pedagogique":"Client",
    o.vtype==="client"?(o.clientName||""):(o.teacher||""),
    o.students||"", o.reason||"", fD(o.entryDate), o.entryTime||"", fD(o.exitDate),
    VS[o.status]?VS[o.status].label:"",
    o.tasks?o.tasks.filter(t=>t.done).length:0, o.tasks?o.tasks.length:0,
    o.observations||"", o.additionalSales||"", o.signature?"Oui":"Non", o.createdBy||""
  ])];
}

// ── PDF ──
function orderHTML(order) {
  const isPeda = order.vtype === "peda";
  const sLabel = VS[order.status] ? VS[order.status].label : "En attente";
  const sColor = order.status==="termine" ? "#065f46" : order.status==="en_cours" ? "#1e40af" : "#92400e";
  const sBg    = order.status==="termine" ? "#d1fae5" : order.status==="en_cours" ? "#dbeafe" : "#fef3c7";
  const tasksHTML = (order.tasks||[]).map((t,i) =>
    `<div class="ti${i%2===1?" odd":""}"><div class="cb${t.done?" ck":""}">${t.done?"&#10003;":""}</div><span${t.done?" class=\"td\"":" "}>${esc(t.label)}</span>${t.done&&t.doneBy?`<span class="tby">${esc(t.doneBy)}</span>`:""}</div>`
  ).join("");
  const sigHTML = order.signature
    ? `<img src="${order.signature}" style="max-height:72px;max-width:100%;display:block;margin:auto;"/>`
    : `<div style="font-size:11px;color:#bbb;text-align:center;line-height:80px;">Non signee</div>`;
  const exitBlock = order.exitDate ? `
    <div class="sec"><div class="sh">Sortie du vehicule</div>
      <div class="grid g3">
        <div><div class="lb">Date sortie</div><div class="vl">${fD(order.exitDate)}</div></div>
        <div><div class="lb">Heure sortie</div><div class="vl">${esc(order.exitTime||"—")}</div></div>
        <div><div class="lb">Etat</div><div class="vl">${esc(order.exitCondition||"—")}</div></div>
      </div>
    </div>` : "";
  const personBlock = isPeda ? `
    <div class="sec"><div class="sh">BTS MV - Affectation pedagogique</div>
      <div class="grid g2">
        <div><div class="lb">Enseignant responsable</div><div class="vl">${esc(order.teacher||"—")}</div></div>
        <div><div class="lb">Eleves affectes</div><div class="vl">${esc(order.students||"—")}</div></div>
      </div>
    </div>` : `
    <div class="sec"><div class="sh">Client</div>
      <div class="grid g2">
        <div><div class="lb">Nom du client</div><div class="vl">${esc(order.clientName||"—")}</div></div>
        <div><div class="lb">Telephone</div><div class="vl">${esc(order.clientPhone||"—")}</div></div>
      </div>
    </div>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(order.orderNum)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;}.page{padding:12mm 15mm;max-width:210mm;margin:0 auto;}.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:10px;margin-bottom:14px;}.bn{font-size:20px;font-weight:bold;color:#1d4ed8;}.bs{font-size:10px;color:#555;margin-top:2px;}.on{font-size:22px;font-weight:bold;color:#1d4ed8;text-align:right;}.om{font-size:10px;color:#555;text-align:right;margin-top:2px;}.sec{margin-bottom:10px;}.sh{background:#1d4ed8;color:#fff;padding:4px 10px;font-size:11px;font-weight:bold;margin-bottom:6px;}.grid{display:grid;gap:6px 10px;}.g2{grid-template-columns:1fr 1fr;}.g3{grid-template-columns:1fr 1fr 1fr;}.g5{grid-template-columns:repeat(5,1fr);}.lb{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;}.vl{font-size:12px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;min-height:17px;}.bdg{display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:bold;}.tasks{display:grid;grid-template-columns:1fr 1fr;gap:0;}.ti{display:flex;align-items:center;gap:6px;padding:4px 5px;border-bottom:1px dotted #e5e5e5;font-size:11px;}.ti.odd{background:#f9f9f9;}.cb{width:13px;height:13px;border:1.5px solid #555;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;font-weight:bold;}.ck{border-color:#059669;background:#d1fae5;color:#059669;}.td{color:#059669;text-decoration:line-through;}.tby{margin-left:auto;font-size:9px;color:#888;white-space:nowrap;}.tb{border:1px solid #ddd;padding:6px 8px;min-height:52px;font-size:11px;line-height:1.5;white-space:pre-wrap;}.sr{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;padding-top:12px;border-top:2px solid #1d4ed8;}.sl{font-size:10px;color:#333;font-weight:bold;margin-bottom:5px;}.sb{border:1px solid #999;height:82px;display:flex;align-items:center;justify-content:center;background:#fafafa;overflow:hidden;}.sn{font-size:9px;color:#888;text-align:center;margin-top:3px;}.foot{margin-top:14px;padding-top:8px;border-top:1px solid #ddd;font-size:9px;color:#aaa;text-align:center;}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.page{padding:8mm 12mm;}}</style>
</head><body><div class="page">
<div class="hdr"><div><div class="bn">Lycee Gallieni</div><div class="bs">Atelier BTS Maintenance des Vehicules</div><div class="bs" style="font-weight:bold;margin-top:5px;font-size:12px;">ORDRE DE REPARATION</div></div>
<div><div class="on">${esc(order.orderNum)}</div><div class="om">Ref. dossier : ${esc(order.fileRef||"—")}</div><div class="om">Entree le ${fD(order.entryDate)} a ${esc(order.entryTime||"—")}</div><div class="om">Cree par : ${esc(order.createdBy||"—")}</div>
<div class="om" style="margin-top:5px;"><span style="background:${sBg};color:${sColor};padding:2px 10px;border-radius:20px;font-size:10px;font-weight:bold;">${sLabel}</span></div></div></div>
<div class="sec"><div class="sh">Vehicule</div><div class="grid g5">
<div><div class="lb">Immatriculation</div><div class="vl" style="font-size:14px;">${esc(order.plate)}</div></div>
<div><div class="lb">Marque</div><div class="vl">${esc(order.brand)}</div></div>
<div><div class="lb">Modele</div><div class="vl">${esc(order.model)}</div></div>
<div><div class="lb">Annee</div><div class="vl">${esc(order.year||"—")}</div></div>
<div><div class="lb">Kilometrage</div><div class="vl">${order.km?esc(order.km)+" km":"—"}</div></div></div>
<div style="margin-top:7px;"><span class="bdg" style="background:${isPeda?"#ffedd5":"#dbeafe"};color:${isPeda?"#9a3412":"#1e40af"};">${isPeda?"🎓 Vehicule pedagogique":"👤 Vehicule client"}</span></div></div>
${personBlock}
<div class="sec"><div class="sh">Motif d'entree / Reclamation</div><div class="tb">${esc(order.reason||"—")}</div></div>
<div class="sec"><div class="sh">Travaux a realiser</div><div class="tasks">${tasksHTML}</div></div>
<div class="twocol">
<div class="sec"><div class="sh">Observations a signaler au client</div><div class="tb">${esc(order.observations||"—")}</div></div>
<div class="sec"><div class="sh">Ventes additionnelles prevues</div><div class="tb">${esc(order.additionalSales||"—")}</div></div>
</div>
${exitBlock}
<div class="sr">
<div><div class="sl">Signature du client (accord pour les travaux)</div><div class="sb">${sigHTML}</div><div class="sn">${esc(order.clientName||(isPeda?order.teacher||"":""))}</div></div>
<div><div class="sl">Visa du technicien / enseignant</div><div class="sb"><div style="font-size:11px;color:#ccc;text-align:center;line-height:80px;">..................................</div></div><div class="sn">${isPeda?esc(order.teacher||""):""}</div></div>
</div>
<div class="foot">Lycee Gallieni – BTS Maintenance des Vehicules &nbsp;|&nbsp; ${esc(order.orderNum)} &nbsp;|&nbsp; Imprime le ${new Date().toLocaleDateString("fr-FR")}</div>
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
  } catch { alert("Impossible d'ouvrir la fenetre d'impression. Verifiez les popups."); }
}

// ── PDF Estimation / Facture ──
function docHTML(doc) {
  const isEst = doc.kind === "estimate";
  const t = docTotals(doc);
  const rows = (doc.items||[]).map((it,i)=>{
    const lt=(Number(it.qty)||0)*(Number(it.unitPrice)||0);
    return `<tr${i%2?' style="background:#f9f9f9"':''}><td>${esc(it.label||"")}</td><td class="r">${esc(String(it.qty??""))}</td><td class="r">${eur(it.unitPrice)}</td><td class="r">${eur(lt)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#999">Aucune ligne</td></tr>`;
  const sigBlock = isEst ? `<div class="sr">
    <div><div class="sl">Bon pour accord — Signature du client</div><div class="sb">${doc.signature?`<img src="${doc.signature}" style="max-height:72px;max-width:100%;display:block;margin:auto;"/>`:`<div style="color:#bbb;line-height:80px;text-align:center;font-size:11px;">Non signee</div>`}</div><div class="sn">${esc(doc.clientName||"")}</div></div>
    <div><div class="sl">Cachet / Visa atelier</div><div class="sb"></div></div></div>` : "";
  const dateLine = isEst
    ? (doc.validUntil?`<div class="om">Valable jusqu'au ${fD(doc.validUntil)}</div>`:"")
    : (doc.validUntil?`<div class="om">Echeance : ${fD(doc.validUntil)}</div>`:"");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.docNum||"")}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;}.page{padding:12mm 15mm;max-width:210mm;margin:0 auto;}.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:10px;margin-bottom:14px;}.bn{font-size:20px;font-weight:bold;color:#1d4ed8;}.bs{font-size:10px;color:#555;margin-top:2px;}.on{font-size:22px;font-weight:bold;color:#1d4ed8;text-align:right;}.om{font-size:10px;color:#555;text-align:right;margin-top:2px;}.sec{margin-bottom:10px;}.sh{background:#1d4ed8;color:#fff;padding:4px 10px;font-size:11px;font-weight:bold;margin-bottom:6px;}.grid{display:grid;gap:6px 10px;}.g2{grid-template-columns:1fr 1fr;}.vl{font-size:13px;font-weight:bold;}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}th{background:#1d4ed8;color:#fff;text-align:left;padding:5px 8px;font-size:10px;}td{padding:5px 8px;border-bottom:1px solid #eee;}td.r,th.r{text-align:right;}.tot{margin-top:10px;margin-left:auto;width:55%;}.tot div{display:flex;justify-content:space-between;padding:3px 8px;font-size:12px;}.tot .ttc{background:#1d4ed8;color:#fff;font-weight:bold;font-size:13px;border-radius:4px;}.tb{border:1px solid #ddd;padding:6px 8px;min-height:40px;font-size:11px;white-space:pre-wrap;}.sr{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;padding-top:12px;border-top:2px solid #1d4ed8;}.sl{font-size:10px;color:#333;font-weight:bold;margin-bottom:5px;}.sb{border:1px solid #999;height:82px;background:#fafafa;overflow:hidden;}.sn{font-size:9px;color:#888;text-align:center;margin-top:3px;}.foot{margin-top:14px;padding-top:8px;border-top:1px solid #ddd;font-size:9px;color:#aaa;text-align:center;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style>
</head><body><div class="page">
<div class="hdr"><div><div class="bn">Lycee Gallieni</div><div class="bs">Atelier BTS Maintenance des Vehicules</div><div class="bs" style="font-weight:bold;margin-top:5px;font-size:13px;">${isEst?"DEVIS / ESTIMATION":"FACTURE"}</div></div>
<div><div class="on">${esc(doc.docNum||"")}</div><div class="om">Date : ${fD(doc.createdAt||today())}</div>${dateLine}<div class="om">Etabli par : ${esc(doc.createdBy||"—")}</div></div></div>
<div class="grid g2">
<div class="sec"><div class="sh">Client</div><div class="vl">${esc(doc.clientName||"—")}</div><div class="bs">${esc(doc.clientPhone||"")}</div></div>
<div class="sec"><div class="sh">Vehicule</div><div class="vl">${esc(doc.plate||"—")}</div><div class="bs">${esc(doc.brand||"")} ${esc(doc.model||"")} ${doc.year?"("+esc(doc.year)+")":""} ${doc.km?"· "+esc(doc.km)+" km":""}</div></div></div>
<div class="sec"><div class="sh">Detail des prestations</div>
<table><thead><tr><th>Designation</th><th class="r">Qte</th><th class="r">PU HT</th><th class="r">Total HT</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot"><div><span>Total HT</span><span>${eur(t.ht)}</span></div><div><span>TVA (${esc(String(doc.tvaRate??0))}%)</span><span>${eur(t.tva)}</span></div><div class="ttc"><span>Total TTC</span><span>${eur(t.ttc)}</span></div></div></div>
${doc.notes?`<div class="sec"><div class="sh">Notes</div><div class="tb">${esc(doc.notes)}</div></div>`:""}
${sigBlock}
<div class="foot">Lycee Gallieni – BTS Maintenance des Vehicules &nbsp;|&nbsp; ${esc(doc.docNum||"")} &nbsp;|&nbsp; Imprime le ${new Date().toLocaleDateString("fr-FR")}</div>
</div></body></html>`;
}
function generateDocPDF(doc){
  const html=docHTML(doc);
  try{ const blob=new Blob([html],{type:"text/html;charset=utf-8;"}); const url=URL.createObjectURL(blob); const w=window.open(url,"_blank");
    if(w){setTimeout(()=>{try{w.print();}catch{/* ignore */}},800);} else {const a=document.createElement("a");a.href=url;a.download=(doc.docNum||"document")+".html";a.click();}
  }catch{ alert("Impossible d'ouvrir l'impression. Verifiez les popups."); }
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
          <div style={{ fontSize:48, marginBottom:12 }}>🔧</div>
          <h1 style={{ color:C.txt, fontSize:22, fontWeight:700, margin:0 }}>DMS – Atelier BTS MV</h1>
          <p style={{ color:C.mut, fontSize:13, marginTop:6 }}>Lycee Gallieni</p>
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
        <Inp label="E-mail (staff) ou identifiant (élève)" value={u} onChange={su} placeholder="prenom.nom@… ou Etudiant1"/>
        <Inp label="Mot de passe" value={p} onChange={sp} type="password" placeholder="••••••••"/>
        {err && <p style={{ color:"#f87171", fontSize:13, textAlign:"center", margin:0 }}>{err}</p>}
        <Btn full onClick={go} disabled={busy}>{busy?"Connexion…":"Se connecter"}</Btn>
        <button onClick={()=>{setMode("forgot");se("");sm("");}} style={{ background:"none", border:"none", color:"#2563eb", cursor:"pointer", fontSize:13 }}>Mot de passe oublié ? (staff)</button>
      </div>
      <div style={{ marginTop:20, padding:12, background:"#f1f5f9", borderRadius:8, fontSize:12, color:C.mut, textAlign:"center" }}>
        Staff : e-mail + mot de passe · Élèves : identifiant « EtudiantN » + mot de passe.
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
  { id:"estimates", ico:"🧾", lbl:"Estimations", staff:true },
  { id:"invoices",  ico:"💶", lbl:"Factures", staff:true },
  { id:"history",   ico:"📋", lbl:"Historique" },
  { id:"admin",     ico:"⚙️", lbl:"Administration", staff:true },
];
function Sidebar({ user, page, nav, logout }) {
  const isStaff = user.role !== "eleve";
  const rs = ROLE_STYLE[user.role]||{ bg:"#e2e8f0", cl:C.sub };
  return (
    <div style={{ width:220, background:C.side, borderRight:"1px solid "+C.bdr, display:"flex", flexDirection:"column", height:"100vh", flexShrink:0 }}>
      <div style={{ padding:"20px 16px 16px", borderBottom:"1px solid "+C.bdr }}>
        <div style={{ color:"#3b82f6", fontWeight:700, fontSize:14, marginBottom:8 }}>🔧 DMS Gallieni</div>
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
          🚪 Deconnexion
        </button>
      </div>
    </div>
  );
}

function Dashboard({ orders, user, nav, selOrd }) {
  const active = orders.filter(o => o.status !== "termine");
  const isStaff = user.role !== "eleve";
  const stats = [
    { l:"En atelier",   v:active.length,                                              c:"#2563eb" },
    { l:"En attente",   v:orders.filter(o=>o.status==="en_attente").length,            c:"#f59e0b" },
    { l:"En cours",     v:orders.filter(o=>o.status==="en_cours").length,              c:"#3b82f6" },
    { l:"Termines",     v:orders.filter(o=>o.status==="termine").length,               c:"#059669" },
    { l:"Clients",      v:active.filter(o=>o.vtype==="client").length,                 c:"#a78bfa" },
    { l:"Pedagogiques", v:active.filter(o=>o.vtype==="peda").length,                  c:"#fb923c" },
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <h2 style={{ color:C.txt, fontSize:20, fontWeight:700, margin:0 }}>📊 Tableau de bord</h2>
        {isStaff && <Btn onClick={() => nav("new-order")}>+ Nouvel ordre de réparation</Btn>}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
        {stats.map(s => <Crd key={s.l} style={{ textAlign:"center" }}><div style={{ fontSize:34, fontWeight:700, color:s.c }}>{s.v}</div><div style={{ fontSize:12, color:C.sub, marginTop:4 }}>{s.l}</div></Crd>)}
      </div>
      <div>
        <h3 style={{ color:C.txt, fontSize:16, fontWeight:600, marginBottom:12 }}>🚗 Vehicules en atelier</h3>
        {active.length===0
          ? <Crd><p style={{ color:C.mut, textAlign:"center", margin:0 }}>Aucun vehicule en atelier</p></Crd>
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
          {isPeda?"🎓 Pedagogique":"👤 Client"}
        </span>
        {o.km && <span style={{ fontSize:11, color:C.mut }}>📍 {Number(o.km).toLocaleString("fr-FR")} km</span>}
        {o.signature && <span style={{ fontSize:11, color:"#059669" }}>✍ Signe</span>}
      </div>
      {tot>0 && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.mut, marginBottom:3 }}><span>Avancement</span><span>{dn}/{tot}</span></div>
          <div style={{ background:"#e2e8f0", borderRadius:999, height:6, overflow:"hidden" }}>
            <div style={{ width:Math.round(dn/tot*100)+"%", background:"#3b82f6", height:"100%", borderRadius:999 }}/>
          </div>
        </div>
      )}
      <div style={{ marginTop:8, fontSize:11, color:C.mut }}>Entree : {fD(o.entryDate)}</div>
      {isPeda && o.students && <div style={{ marginTop:4, fontSize:11, color:"#c2410c" }}>👥 {o.students}</div>}
    </div>
  );
}

function OrdersList({ orders, user, nav, selOrd }) {
  const [flt,sf]=useState("active"); const [q,sq]=useState("");
  const isStaff = user.role!=="eleve";
  const shown = orders.filter(o => {
    const ok = flt==="active"?o.status!=="termine":flt==="all"?true:o.status===flt;
    return ok && (!q||[o.plate,o.brand,o.model,o.clientName,o.orderNum,o.students].join(" ").toLowerCase().includes(q.toLowerCase()));
  });
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <h2 style={{ color:C.txt, fontSize:20, fontWeight:700, margin:0 }}>🔧 Ordres de réparation</h2>
        {isStaff && <Btn onClick={() => nav("new-order")}>+ Nouvel ordre de réparation</Btn>}
      </div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        {[["active","Actifs"],["en_attente","En attente"],["en_cours","En cours"],["termine","Termines"],["all","Tous"]].map(([v,l]) => (
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
                    <div>Entree : {fD(o.entryDate)}</div>
                    <div>{(o.tasks?o.tasks.filter(t=>t.done).length:0)}/{o.tasks?o.tasks.length:0} taches</div>
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
    tasks: TASKS0.map(t => ({ id:gid(), label:t, done:false, doneBy:"", doneAt:"" })),
    signature:"",
  });
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  const addTask=()=>{if(!f.custTask.trim())return;set("tasks",[...f.tasks,{id:gid(),label:f.custTask.trim(),done:false,doneBy:"",doneAt:""}]);set("custTask","");};
  const togStu=(n)=>set("selStu",f.selStu.includes(n)?f.selStu.filter(s=>s!==n):[...f.selStu,n]);
  const submit=async()=>{
    if(!f.plate.trim()||!f.brand.trim()||!f.model.trim()){notify("Immatriculation, marque et modele sont obligatoires","error");return;}
    const o={
      fileRef:f.fileRef,
      plate:f.plate.toUpperCase(),brand:f.brand,model:f.model,year:f.year,km:f.km,
      vtype:f.vtype,clientName:f.clientName,clientPhone:f.clientPhone,
      entryDate:f.entryDate,entryTime:f.entryTime,reason:f.reason,
      teacher:f.teacher,assignedStudents:f.vtype==="peda"?f.selStu:[],
      tasks:f.tasks,observations:f.observations,additionalSales:f.additionalSales,
      signature:f.signature,status:"en_attente",exitDate:"",exitTime:"",exitCondition:"",
      createdBy:user.name,
    };
    sbusy(true);
    try {
      const created=await addOrder(o);
      selOrd(created.id);nav("order-detail");notify("Ordre de réparation "+created.orderNum+" créé");
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
      <Crd>
        <SecTitle>🚗 Vehicule</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
          <Inp label="Immatriculation *" value={f.plate} onChange={v=>set("plate",v)} placeholder="AB-123-CD"/>
          <Inp label="Marque *" value={f.brand} onChange={v=>set("brand",v)} placeholder="Peugeot"/>
          <Inp label="Modele *" value={f.model} onChange={v=>set("model",v)} placeholder="308 SW"/>
          <Inp label="Annee" value={f.year} onChange={v=>set("year",v)} placeholder="2020"/>
          <Inp label="Kilometrage" value={f.km} onChange={v=>set("km",v)} placeholder="45000"/>
          <Sel label="Type de vehicule" value={f.vtype} onChange={v=>set("vtype",v)} opts={[{v:"client",l:"👤 Vehicule client"},{v:"peda",l:"🎓 Vehicule pedagogique"}]}/>
        </div>
        <SecTitle>📁 Dossier</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
          <Inp label="N° d'ordre de réparation" value="Généré automatiquement" onChange={()=>{}} readOnly/>
          <Inp label="Reference dossier" value={f.fileRef} onChange={v=>set("fileRef",v)} placeholder="REF-2025-001"/>
          <Inp label="Date d'entree *" value={f.entryDate} onChange={v=>set("entryDate",v)} type="date"/>
          <Inp label="Heure d'entree *" value={f.entryTime} onChange={v=>set("entryTime",v)} type="time"/>
        </div>
        {f.vtype==="client" ? (
          <div>
            <SecTitle>👤 Client</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Inp label="Nom du client" value={f.clientName} onChange={v=>set("clientName",v)} placeholder="M. Dupont"/>
              <Inp label="Telephone" value={f.clientPhone} onChange={v=>set("clientPhone",v)} placeholder="06 12 34 56 78"/>
            </div>
          </div>
        ) : (
          <div>
            <SecTitle>🎓 BTS MV – Affectation pedagogique</SecTitle>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
              <Sel label="Enseignant responsable" value={f.teacher} onChange={v=>set("teacher",v)} opts={[{v:"",l:"— Choisir —"},...teachers.map(t=>({v:t.name,l:t.name}))]}/>
            </div>
            <div style={{ marginTop:12 }}>
              <label style={{ fontSize:12, color:C.sub, fontWeight:500, display:"block", marginBottom:8 }}>Eleves affectes (par classe)</label>
              <StudentPicker students={students} selected={f.selStu} onToggle={togStu}/>
            </div>
          </div>
        )}
        <SecTitle>🔍 Motif d'entree</SecTitle>
        <TA value={f.reason} onChange={v=>set("reason",v)} placeholder="Decrire le motif d'entree..." rows={3}/>
        <SecTitle>☑️ Travaux a realiser</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))", gap:8, marginBottom:10 }}>
          {f.tasks.map(t => (
            <label key={t.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderRadius:6, background:"#f1f5f9", border:"1px solid "+C.bdr, cursor:"pointer", fontSize:13, color:C.txt }}>
              <input type="checkbox" checked={t.done} onChange={()=>set("tasks",f.tasks.map(x=>x.id===t.id?{...x,done:!x.done}:x))} style={{ flexShrink:0 }}/>
              <span style={{ flex:1 }}>{t.label}</span>
              <button onClick={e=>{e.preventDefault();set("tasks",f.tasks.filter(x=>x.id!==t.id));}} style={{ background:"none", border:"none", color:C.mut, cursor:"pointer", fontSize:16, padding:0, lineHeight:1 }}>×</button>
            </label>
          ))}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input value={f.custTask} onChange={e=>set("custTask",e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addTask();}} placeholder="Ajouter une tache personnalisee..."
            style={{ flex:1, background:"#f1f5f9", border:"1px solid "+C.bdr, borderRadius:6, padding:"8px 10px", color:C.txt, fontSize:13, outline:"none", fontFamily:"inherit" }}/>
          <Btn sm onClick={addTask}>+ Ajouter</Btn>
        </div>
        <SecTitle>📝 Notes</SecTitle>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:12 }}>
          <TA label="Observations a signaler au client" value={f.observations} onChange={v=>set("observations",v)} placeholder="Anomalies constatees..."/>
          <TA label="Ventes additionnelles a prevoir" value={f.additionalSales} onChange={v=>set("additionalSales",v)} placeholder="Pieces, accessoires..."/>
        </div>
        <SecTitle>✍ Signature du client (accord pour les travaux)</SecTitle>
        <div style={{ background:"#f1f5f9", borderRadius:10, padding:16, border:"1px solid "+C.bdr }}>
          <p style={{ color:C.sub, fontSize:12, marginBottom:12 }}>Le client certifie avoir pris connaissance des travaux a realiser et donne son accord.</p>
          {f.signature ? (
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
                <span style={{ color:"#059669", fontSize:13, fontWeight:600 }}>✅ Signature enregistree</span>
                <Btn sm ghost onClick={()=>set("signature","")}>Resigner</Btn>
              </div>
              <img src={f.signature} alt="Signature" style={{ maxHeight:80, background:"#fff", borderRadius:6, padding:4, display:"block" }}/>
            </div>
          ) : (
            <SigPad onSave={v=>set("signature",v)} init={f.signature}/>
          )}
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:10, marginTop:20, paddingTop:16, borderTop:"1px solid "+C.bdr }}>
          <Btn ghost onClick={()=>nav("orders")}>Annuler</Btn>
          <Btn onClick={submit} disabled={busy}>{busy?"Création…":"✅ Créer l'ordre de réparation"}</Btn>
        </div>
      </Crd>
    </div>
  );
}

function OrderDetail({ orderId, orders, editOrder, user, nav, notify, students }) {
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
    upd({tasks,status:tasks.every(t=>t.done)?"termine":(o.status==="en_attente"?"en_cours":o.status)});
  };
  const addT=()=>{if(!newTask.trim())return;upd({tasks:[...o.tasks,{id:gid(),label:newTask.trim(),done:false,doneBy:"",doneAt:""}]});snt("");};
  const dn=o.tasks?o.tasks.filter(t=>t.done).length:0,tot=o.tasks?o.tasks.length:0,pct=tot?Math.round(dn/tot*100):0;
  const TABS=[{id:"tasks",l:"☑️ Travaux"},{id:"notes",l:"📝 Notes"},{id:"sig",l:"✍ Accord client"},...(o.exitDate?[{id:"exit",l:"🚪 Sortie"}]:[])];
  return (
    <div style={{maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:12}}>
        <div>
          <Btn ghost sm onClick={()=>nav("orders")} style={{marginBottom:8}}>← Retour</Btn>
          <h2 style={{color:C.txt,fontSize:20,fontWeight:700,margin:0}}>{o.orderNum} – {o.plate}</h2>
          <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap",alignItems:"center"}}>
            <Badge status={o.status}/>
            <span style={{fontSize:12,fontWeight:600,color:isPeda?"#c2410c":"#1d4ed8"}}>{isPeda?"🎓 Pedagogique":"👤 Client"}</span>
            <span style={{fontSize:13,color:C.sub}}>{o.brand} {o.model} {o.year?"("+o.year+")":""}</span>
            {o.signature&&<span style={{fontSize:12,color:"#059669"}}>✍ Signe</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Btn sm ghost onClick={()=>generatePDF(o)} style={{borderColor:"#3b82f6",color:"#2563eb"}}>📄 PDF</Btn>
          {isStaff&&<Btn sm ghost onClick={()=>archiveToDrive(o,notify)} style={{borderColor:"#16a34a",color:"#059669"}}>📁 Archiver Drive</Btn>}
          {isStaff&&o.status!=="termine"&&(
            <>
              {o.status==="en_attente"&&<Btn sm onClick={()=>{upd({status:"en_cours"});notify("Intervention demarree");}}>▶ Demarrer</Btn>}
            </>
          )}
        </div>
      </div>
      <Crd style={{marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,fontSize:13}}>
          {[{k:"N° OR",v:o.orderNum},{k:"Ref. dossier",v:o.fileRef||"—"},{k:"Entree",v:fD(o.entryDate)+" "+o.entryTime},{k:isPeda?"Enseignant":"Client",v:isPeda?(o.teacher||"—"):(o.clientName||"—")}]
            .concat(o.clientPhone?[{k:"Tel.",v:o.clientPhone}]:[],o.students?[{k:"Eleves",v:o.students}]:[],[{k:"Avancement",v:dn+"/"+tot+" ("+pct+"%)"}])
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
      <div style={{display:"flex",borderBottom:"1px solid "+C.bdr,marginBottom:14}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>st(t.id)} style={{padding:"10px 16px",border:"none",background:"transparent",cursor:"pointer",fontSize:13,fontWeight:tab===t.id?700:400,color:tab===t.id?"#2563eb":C.sub,borderBottom:tab===t.id?"2px solid #3b82f6":"2px solid transparent",marginBottom:-1}}>{t.l}</button>
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
              {t.done&&t.doneBy&&<span style={{fontSize:11,color:C.mut,whiteSpace:"nowrap"}}>{t.doneBy} · {fD(t.doneAt)}</span>}
            </div>
          ))}
          {canEdit&&o.status!=="termine"&&(
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <input value={newTask} onChange={e=>snt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addT();}} placeholder="Ajouter une tache..."
                style={{flex:1,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"8px 10px",color:C.txt,fontSize:13,outline:"none",fontFamily:"inherit"}}/>
              <Btn sm onClick={addT}>+</Btn>
            </div>
          )}
        </div>
      )}
      {tab==="notes"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <TA label="👁 Observations a signaler au client" value={obs} onChange={canEdit?setObs:null} onBlur={canEdit?()=>{if(obs!==(o.observations||""))upd({observations:obs});}:null} readOnly={!canEdit} placeholder={canEdit?"Anomalies constatees...":"Aucune observation"} rows={4}/>
          <TA label="🛒 Ventes additionnelles a prevoir" value={adds} onChange={canEdit?setAdds:null} onBlur={canEdit?()=>{if(adds!==(o.additionalSales||""))upd({additionalSales:adds});}:null} readOnly={!canEdit} placeholder={canEdit?"Pieces, accessoires...":"Aucune"} rows={4}/>
        </div>
      )}
      {tab==="sig"&&(
        <Crd>
          <h3 style={{color:"#2563eb",fontSize:15,fontWeight:700,marginBottom:4}}>✍ Accord du client pour les travaux</h3>
          <p style={{color:C.sub,fontSize:12,marginBottom:14}}>Signature recueillie lors de la creation de l'ordre de réparation.</p>
          {o.signature?(
            <div>
              <div style={{color:"#059669",fontSize:13,fontWeight:600,marginBottom:10}}>✅ Document signe</div>
              <img src={o.signature} alt="Signature client" style={{maxWidth:400,background:"#fff",borderRadius:8,padding:6,display:"block",border:"1px solid "+C.bdr}}/>
              <div style={{color:C.mut,fontSize:12,marginTop:8}}>Signataire : {isPeda?(o.teacher||"—"):(o.clientName||"—")}</div>
            </div>
          ):(
            <div style={{color:"#f59e0b",fontSize:13}}>⚠️ Aucune signature enregistree pour cet ordre de réparation.</div>
          )}
        </Crd>
      )}
      {tab==="exit"&&o.exitDate&&(
        <Crd>
          <h3 style={{color:"#059669",fontSize:15,fontWeight:700,marginBottom:12}}>🚪 Sortie enregistree</h3>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,fontSize:13}}>
            <div><div style={{color:C.mut,fontSize:11}}>Date de sortie</div><div style={{color:C.txt}}>{fD(o.exitDate)} a {o.exitTime}</div></div>
            <div><div style={{color:C.mut,fontSize:11}}>Etat a la sortie</div><div style={{color:C.txt}}>{o.exitCondition||"—"}</div></div>
          </div>
        </Crd>
      )}
      {isStaff&&(
        <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid "+C.bdr}}>
          {o.status!=="termine"?(
            <Btn full onClick={()=>sse(true)} style={{background:"#065f46",fontSize:15,padding:"12px"}}>✅ Valider et terminer l'OR</Btn>
          ):(
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
              <span style={{color:"#059669",fontSize:14,fontWeight:600}}>✅ Ordre terminé{o.exitDate?" le "+fD(o.exitDate):""} – archivé sur le Drive</span>
              <Btn sm ghost onClick={()=>archiveToDrive(o,notify)} style={{borderColor:"#16a34a",color:"#059669"}}>📁 Ré-archiver sur Drive</Btn>
            </div>
          )}
        </div>
      )}
      {showExit&&<ExitModal o={o} onOk={d=>{upd({...d,status:"termine"});sse(false);st("exit");notify("Ordre terminé");archiveToDrive({...o,...d,status:"termine"},notify);}} onClose={()=>sse(false)}/>}
    </div>
  );
}

function ExitModal({ o, onOk, onClose }) {
  const [f,sf]=useState({exitDate:today(),exitTime:tNow(),exitCondition:""});
  const set=(k,v)=>sf(p=>({...p,[k]:v}));
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:C.card,borderRadius:16,padding:24,width:"100%",maxWidth:480,border:"1px solid "+C.bdr}}>
        <h3 style={{color:C.txt,fontSize:18,fontWeight:700,marginBottom:4}}>✅ Terminer l'ordre de réparation</h3>
        <p style={{color:C.sub,fontSize:14,marginBottom:16}}>{o.plate} – {o.brand} {o.model} · l'OR sera marqué « terminé » et archivé sur le Drive.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <Inp label="Date de sortie" value={f.exitDate} onChange={v=>set("exitDate",v)} type="date"/>
          <Inp label="Heure de sortie" value={f.exitTime} onChange={v=>set("exitTime",v)} type="time"/>
        </div>
        <div style={{marginBottom:20}}>
          <TA label="Etat du vehicule a la sortie" value={f.exitCondition} onChange={v=>set("exitCondition",v)} placeholder="Propre, reparation effectuee, client informe..." rows={3}/>
        </div>
        <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
          <Btn ghost onClick={onClose}>Annuler</Btn>
          <Btn onClick={()=>onOk(f)} style={{background:"#065f46"}}>✅ Valider et terminer</Btn>
        </div>
      </div>
    </div>
  );
}

function HistoryView({ orders, documents, isStaff, nav, selOrd, openDoc }) {
  const [tab,st]=useState("orders");
  const [q,sq]=useState("");
  const ql=q.toLowerCase();
  const TABS=[["orders","🔧 Ordres"],...(isStaff?[["estimate","🧾 Estimations"],["invoice","💶 Factures"]]:[])];
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
          ?<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucune intervention enregistree</p></Crd>
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
                  <div>Entree : {fD(o.entryDate)}</div>
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

function AdminPanel({ students, staff, orders, isAdmin, notify, reloadStudents, reloadStaff, currentId }) {
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
  const stats=[
    {l:"Total interventions",v:orders.length,c:"#2563eb"},{l:"En attente",v:orders.filter(o=>o.status==="en_attente").length,c:"#f59e0b"},
    {l:"En cours",v:orders.filter(o=>o.status==="en_cours").length,c:"#3b82f6"},{l:"Terminees",v:orders.filter(o=>o.status==="termine").length,c:"#059669"},
    {l:"Clients",v:orders.filter(o=>o.vtype==="client").length,c:"#a78bfa"},{l:"Pedagogiques",v:orders.filter(o=>o.vtype==="peda").length,c:"#fb923c"},
    {l:"Signes",v:orders.filter(o=>o.signature).length,c:"#059669"},{l:"Staff",v:staff.length,c:C.txt},{l:"Eleves",v:students.length,c:"#15803d"},
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
        {[["students","🎓 Élèves"],["staff","👤 Personnel"],["stats","📊 Statistiques"]].map(([id,l])=>(
          <button key={id} onClick={()=>st(id)} style={{padding:"8px 16px",borderRadius:6,cursor:"pointer",fontSize:13,border:"1px solid "+(tab===id?"#2563eb":C.bdr),background:tab===id?C.acc:"transparent",color:tab===id?"#fff":C.sub}}>{l}</button>
        ))}
      </div>
      {tab==="students"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {isAdmin ? (
            <Crd>
              <h3 style={{color:"#2563eb",fontSize:14,fontWeight:700,marginBottom:12}}>Créer un compte élève</h3>
              <p style={{color:C.mut,fontSize:12,marginBottom:12}}>L'identifiant de connexion (« EtudiantN ») est généré automatiquement.</p>
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
          ) : (
            <Crd style={{background:"#f1f5f9"}}>
              <p style={{color:C.sub,fontSize:13,margin:0}}>La gestion des comptes élèves est réservée à l'administrateur.</p>
            </Crd>
          )}
          {students.length===0&&<Crd><p style={{color:C.mut,textAlign:"center",margin:0}}>Aucun élève enregistré</p></Crd>}
          {students.map(u=>(
            <Crd key={u.id}>
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{flex:1}}>
                  <span style={{color:C.txt,fontWeight:600}}>{u.name}</span>
                  {u.group&&<span style={{marginLeft:8,fontSize:11,padding:"2px 8px",borderRadius:999,fontWeight:600,background:"#dcfce7",color:"#15803d"}}>{u.group}</span>}
                  {u.identifier&&<div style={{color:C.mut,fontSize:12,marginTop:2}}>🔑 {u.identifier}</div>}
                </div>
                {isAdmin&&(
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

function DocForm({ kind, initial, orders, documents, addDocument, editDocument, removeDocument, isAdmin, user, nav, notify }) {
  const label=DOC_LABEL[kind];
  const back=()=>nav(kind==="estimate"?"estimates":"invoices");
  const [d,sd]=useState(()=> initial ? {...initial} : { kind, orderId:"", clientName:"", clientPhone:"", plate:"", brand:"", model:"", year:"", km:"", items:[], tvaRate:20, signature:"", notes:"", validUntil:"" });
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
      tvaRate:e.tvaRate??p.tvaRate, notes:e.notes||p.notes };
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
  const addLine=()=>sd(p=>({...p,items:[...p.items,{label:"",qty:1,unitPrice:0}]}));
  const setLine=(i,k,v)=>sd(p=>({...p,items:p.items.map((it,j)=>j===i?{...it,[k]:v}:it)}));
  const delLine=(i)=>sd(p=>({...p,items:p.items.filter((_,j)=>j!==i)}));
  const t=docTotals(d);
  const save=async()=>{
    if(!d.clientName.trim()){notify("Le nom du client est obligatoire","error");return;}
    const clean={...d, tvaRate:Number(d.tvaRate)||0,
      items:d.items.map(it=>({label:it.label||"",qty:Number(it.qty)||0,unitPrice:Number(it.unitPrice)||0}))};
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
          <Inp label="Telephone" value={d.clientPhone} onChange={v=>set("clientPhone",v)} placeholder="06 12 34 56 78"/>
        </div>
        <SecTitle>🚗 Vehicule</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12}}>
          <Inp label="Immatriculation" value={d.plate} onChange={v=>set("plate",v)} placeholder="AB-123-CD"/>
          <Inp label="Marque" value={d.brand} onChange={v=>set("brand",v)}/>
          <Inp label="Modele" value={d.model} onChange={v=>set("model",v)}/>
          <Inp label="Annee" value={d.year} onChange={v=>set("year",v)}/>
          <Inp label="Km" value={d.km} onChange={v=>set("km",v)}/>
        </div>
        <SecTitle>📋 Lignes (prestations / pièces)</SecTitle>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          <div style={{display:"flex",gap:8,fontSize:11,color:C.mut,fontWeight:600,padding:"0 4px"}}>
            <span style={{flex:1}}>Désignation</span><span style={{width:60,textAlign:"right"}}>Qté</span><span style={{width:90,textAlign:"right"}}>PU HT</span><span style={{width:90,textAlign:"right"}}>Total</span><span style={{width:24}}/>
          </div>
          {d.items.map((it,i)=>{const lt=(Number(it.qty)||0)*(Number(it.unitPrice)||0);return(
            <div key={i} style={{display:"flex",gap:8,alignItems:"center"}}>
              <input value={it.label} onChange={e=>setLine(i,"label",e.target.value)} placeholder="Vidange, plaquettes..." style={{flex:1,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 9px",color:C.txt,fontSize:13,outline:"none"}}/>
              <input type="number" value={it.qty} onChange={e=>setLine(i,"qty",e.target.value)} style={{width:60,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 6px",color:C.txt,fontSize:13,outline:"none",textAlign:"right"}}/>
              <input type="number" value={it.unitPrice} onChange={e=>setLine(i,"unitPrice",e.target.value)} style={{width:90,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"7px 6px",color:C.txt,fontSize:13,outline:"none",textAlign:"right"}}/>
              <span style={{width:90,textAlign:"right",fontSize:13,fontWeight:600,color:C.txt}}>{eur(lt)}</span>
              <button onClick={()=>delLine(i)} style={{width:24,background:"none",border:"none",color:C.mut,cursor:"pointer",fontSize:18}}>×</button>
            </div>
          );})}
          <div><Btn sm ghost onClick={addLine}>+ Ajouter une ligne</Btn></div>
        </div>
        <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
          <div style={{width:280,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.sub}}><span>Total HT</span><b style={{color:C.txt}}>{eur(t.ht)}</b></div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13,color:C.sub}}>
              <span style={{display:"flex",alignItems:"center",gap:6}}>TVA <input type="number" value={d.tvaRate} onChange={e=>set("tvaRate",e.target.value)} style={{width:54,background:"#f1f5f9",border:"1px solid "+C.bdr,borderRadius:6,padding:"3px 6px",color:C.txt,fontSize:12,textAlign:"right"}}/>%</span>
              <b style={{color:C.txt}}>{eur(t.tva)}</b>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:15,fontWeight:700,color:"#1d4ed8",borderTop:"2px solid "+C.bdr,paddingTop:6}}><span>Total TTC</span><span>{eur(t.ttc)}</span></div>
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
                    <Btn sm ghost onClick={()=>set("signature","")}>Resigner</Btn>
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

export default function DMSApp() {
  const { user:cu, ready, recovery, clearRecovery } = useSession();
  const { orders, addOrder, editOrder } = useOrders(cu?.id);
  const { students, reloadStudents } = useStudents(cu?.id);
  const { documents, addDocument, editDocument, removeDocument } = useDocuments(cu?.id);
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
    if(page==="dashboard")    return<Dashboard orders={orders} user={cu} nav={nav} selOrd={ssi}/>;
    if(page==="orders")       return<OrdersList orders={orders} user={cu} nav={nav} selOrd={ssi}/>;
    if(page==="new-order")    return isStaff?<NewOrderForm addOrder={addOrder} teachers={staff} students={students} user={cu} nav={nav} selOrd={ssi} notify={notify}/>:null;
    if(page==="order-detail") return selId?<OrderDetail orderId={selId} orders={orders} editOrder={editOrder} user={cu} nav={nav} notify={notify} students={students}/>:null;
    if(page==="estimates")    return isStaff?<DocsList kind="estimate" documents={documents} openDoc={openDoc} newDoc={()=>newDoc("estimate")}/>:null;
    if(page==="invoices")     return isStaff?<DocsList kind="invoice" documents={documents} openDoc={openDoc} newDoc={()=>newDoc("invoice")}/>:null;
    if(page==="doc-form")     return isStaff?<DocForm kind={docKind} initial={selDoc?documents.find(d=>d.id===selDoc):null} orders={orders} documents={documents} addDocument={addDocument} editDocument={editDocument} removeDocument={removeDocument} isAdmin={isAdmin} user={cu} nav={nav} notify={notify}/>:null;
    if(page==="history")      return<HistoryView orders={orders} documents={documents} isStaff={cu.role!=="eleve"} nav={nav} selOrd={ssi} openDoc={openDoc}/>;
    if(page==="admin")        return isStaff?<AdminPanel students={students} staff={staff} orders={orders} isAdmin={isAdmin} notify={notify} reloadStudents={reloadStudents} reloadStaff={reloadStaff} currentId={cu.id}/>:null;
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
            <div><div style={{color:"#3b82f6",fontWeight:700,fontSize:14}}>🔧 DMS – Atelier BTS MV</div><div style={{color:C.mut,fontSize:11}}>Lycee Gallieni</div></div>
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