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

const rowToStudent = (r) => ({ id: r.id, name: r.name, group: r.grp || "", archived: !!r.archived });

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

// ── Élèves ───────────────────────────────────────────────────────────────
export async function listStudents() {
  const { data, error } = await supabase
    .from("students").select("*").eq("archived", false).order("name");
  if (error) throw error;
  return data.map(rowToStudent);
}
export async function insertStudent(s) {
  const { data, error } = await supabase
    .from("students").insert({ name: s.name, grp: s.group || "" }).select().single();
  if (error) throw error;
  return rowToStudent(data);
}
export async function updateStudent(id, patch) {
  const row = {};
  if (patch.name != null) row.name = patch.name;
  if (patch.group != null) row.grp = patch.group;
  const { data, error } = await supabase
    .from("students").update(row).eq("id", id).select().single();
  if (error) throw error;
  return rowToStudent(data);
}
export async function deleteStudent(id) {
  const { error } = await supabase.from("students").delete().eq("id", id);
  if (error) throw error;
}

// ── Staff (profils, lecture seule côté app) ─────────────────────────────────
export async function listStaff() {
  const { data, error } = await supabase.from("profiles").select("*").order("name");
  if (error) throw error;
  return data.map((p) => ({ id: p.id, name: p.name, role: p.role }));
}
