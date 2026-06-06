import { supabase } from "./supabase";

// ── Adaptateurs DB (snake_case) ↔ App (camelCase) ──────────────────────────
// Les composants attendent la forme camelCase historique (o.orderNum,
// o.clientName, o.students en CHAÎNE, o.tasks en tableau). On convertit ici
// pour ne pas toucher au JSX existant.

const camelToSnake = (s) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const DATE_COLS = new Set(["entry_date", "exit_date"]);
// Champs qui n'existent pas en base ou gérés par la DB → jamais écrits.
const SKIP_WRITE = new Set(["id", "orderNum", "students", "createdAt"]);

export function rowToOrder(r) {
  return {
    id: r.id,
    orderNum: r.order_num,
    fileRef: r.file_ref || "",
    plate: r.plate, brand: r.brand, model: r.model,
    year: r.year || "", km: r.km || "",
    vtype: r.vtype,
    clientName: r.client_name || "", clientPhone: r.client_phone || "",
    teacher: r.teacher || "",
    // affichage attendu : chaîne "Nom1, Nom2"
    students: Array.isArray(r.assigned_students) ? r.assigned_students.join(", ") : "",
    // tableau brut pour l'édition de l'affectation
    assignedStudents: Array.isArray(r.assigned_students) ? r.assigned_students : [],
    reason: r.reason || "",
    entryDate: r.entry_date || "", entryTime: r.entry_time || "",
    exitDate: r.exit_date || "", exitTime: r.exit_time || "", exitCondition: r.exit_condition || "",
    status: r.status,
    tasks: Array.isArray(r.tasks) ? r.tasks : [],
    observations: r.observations || "", additionalSales: r.additional_sales || "",
    signature: r.signature || "",
    createdBy: r.created_by || "",
    createdAt: r.created_at,
  };
}

// patch/objet App → ligne DB. Ne pose que les clés fournies (update partiel).
// `assignedStudents` (tableau) → colonne `assigned_students`.
function orderToRow(o) {
  const row = {};
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_WRITE.has(k)) continue;
    const col = camelToSnake(k);
    row[col] = DATE_COLS.has(col) ? (v || null) : v;
  }
  return row;
}


// ── Ordres ─────────────────────────────────────────────────────────────────
export async function listOrders() {
  const { data, error } = await supabase
    .from("orders").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(rowToOrder);
}
export async function insertOrder(o) {
  const { data, error } = await supabase
    .from("orders").insert(orderToRow(o)).select().single();
  if (error) throw error;
  return rowToOrder(data);
}
export async function updateOrder(id, patch) {
  const { data, error } = await supabase
    .from("orders").update(orderToRow(patch)).eq("id", id).select().single();
  if (error) throw error;
  return rowToOrder(data);
}
export async function deleteOrder(id) {
  const { error } = await supabase.from("orders").delete().eq("id", id);
  if (error) throw error;
}

// ── Documents : Estimations (devis) & Factures (staff uniquement) ───────────
export function rowToDoc(r) {
  return {
    id: r.id, kind: r.kind, docNum: r.doc_num, orderId: r.order_id || "",
    clientName: r.client_name || "", clientPhone: r.client_phone || "",
    plate: r.plate || "", brand: r.brand || "", model: r.model || "",
    year: r.year || "", km: r.km || "",
    items: Array.isArray(r.items) ? r.items : [],
    tvaRate: r.tva_rate != null ? Number(r.tva_rate) : 20,
    signature: r.signature || "", notes: r.notes || "",
    validUntil: r.valid_until || "",
    createdBy: r.created_by || "", createdAt: r.created_at,
  };
}
function docToRow(o) {
  const row = {};
  for (const [k, v] of Object.entries(o)) {
    if (["id", "docNum", "createdAt"].includes(k)) continue;
    const col = camelToSnake(k);
    if (col === "order_id") { row.order_id = v || null; continue; }
    if (col === "valid_until") { row.valid_until = v || null; continue; }
    row[col] = v;
  }
  return row;
}
export async function listDocuments() {
  const { data, error } = await supabase.from("documents").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(rowToDoc);
}
export async function insertDocument(o) {
  const { data, error } = await supabase.from("documents").insert(docToRow(o)).select().single();
  if (error) throw error;
  return rowToDoc(data);
}
export async function updateDocument(id, patch) {
  const { data, error } = await supabase.from("documents").update(docToRow(patch)).eq("id", id).select().single();
  if (error) throw error;
  return rowToDoc(data);
}
export async function deleteDocument(id) {
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw error;
}

// ── Élèves = profils role='eleve' (comptes « Étudiant Technicien ») ─────────
export async function listStudents() {
  const { data, error } = await supabase
    .from("profiles").select("id,name,grp,identifier").eq("role", "eleve").order("identifier");
  if (error) throw error;
  return data.map((p) => ({ id: p.id, name: p.name, group: p.grp || "", identifier: p.identifier || "" }));
}

// Gestion des comptes élèves via l'Edge Function « manage-students » (admin only).
// Le jeton de l'utilisateur est joint automatiquement par supabase-js.
async function callManageStudents(body) {
  const { data, error } = await supabase.functions.invoke("manage-students", { body });
  if (error) throw error;                       // réseau / 5xx
  if (!data?.ok) throw new Error(data?.error || "Erreur inconnue");
  return data;
}
// Crée un compte élève ; renvoie { identifier, id, name, grp }. L'identifiant est auto-généré.
export const createStudent = ({ name, group, password }) =>
  callManageStudents({ action: "create", name, grp: group, password });
// Crée un compte enseignant avec identifiant + pseudo choisis. Renvoie { identifier, id, name }.
export const createTeacher = ({ identifier, name, password }) =>
  callManageStudents({ action: "create_teacher", identifier, name, password });
// Suppression / réinitialisation : fonctionnent pour tout compte (élève ou enseignant).
export const deleteAccount = (id) => callManageStudents({ action: "delete", id });
export const resetPassword = (id, password) =>
  callManageStudents({ action: "reset_password", id, password });

// ── Archivage d'un OR en PDF sur Google Drive (via Edge Function passerelle) ──
export async function archiveOrder({ html, folder, orderNum }) {
  const { data, error } = await supabase.functions.invoke("archive-order", { body: { html, folder, orderNum } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "Erreur d'archivage Drive");
  return data;
}

// ── Staff = profils admin/enseignant ────────────────────────────────────────
export async function listStaff() {
  const { data, error } = await supabase
    .from("profiles").select("id,name,role,identifier").in("role", ["admin", "enseignant"]).order("name");
  if (error) throw error;
  return data.map((p) => ({ id: p.id, name: p.name, role: p.role, identifier: p.identifier || "" }));
}
