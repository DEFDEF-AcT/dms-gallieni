/**
 * DMS Atelier BTS MV — Lycée Gallieni
 * Passerelle Google : PDF, Drive, courriel, photos. UN SEUL script pour les deux
 * applications (DMS atelier + Réception véhicule), distingué par le champ `action` :
 *
 *   (défaut) "archive"   ordre / devis / facture → PDF dans  <RACINE>/<client>/
 *   "mail"               documents en PDF envoyés par courriel
 *   "photo"              photo d'état d'entrée  → <RACINE>/<client>/<véhicule>/<date>/
 *   "reception"          app Réception : photos + fiche → <RACINE>/Réceptions/<immat>/<date>/
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MISE À JOUR SANS RISQUE : dans ton script, NE TOUCHE PAS aux lignes `const`
 * du haut (SECRET, ROOT_FOLDER_ID, SENDER_NAME). Sélectionne tout ce qui se
 * trouve à partir de la ligne « function doPost(e) { » jusqu'à la fin, et
 * remplace-le par la partie correspondante de ce fichier. Puis :
 * Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version → Déployer.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Chaque action renvoie un marqueur (`mailed`, `photo`…) : l'application s'en
 * sert pour distinguer un traitement réel d'un script resté à l'ancienne version.
 */

// ─── RÉGLAGES — à conserver tels qu'ils sont dans ton script ───────────────
const SECRET         = 'REMPLACE_PAR_TON_SECRET_ACTUEL';       // = APPS_SCRIPT_SECRET côté Supabase
const ROOT_FOLDER_ID = '1n3jGOcDD3n4-i7C8DJPvGuBmA_h2SMaS';     // dossier « DMS Gallieni - Ordres de réparation »
// Nom affiché comme expéditeur des courriels
const SENDER_NAME    = 'Lycée Gallieni – Atelier BTS MV';
// ───────────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.secret !== SECRET) return out({ ok: false, error: 'Secret invalide' });
    if (p.action === 'mail')      return sendMail(p);
    if (p.action === 'photo')     return savePhoto(p);
    if (p.action === 'reception') return handleReception(p);
    return archive(p);
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// ── Utilitaires ─────────────────────────────────────────────────────────────
function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
/** Nom de fichier / dossier sans caractère interdit. */
function clean(s) {
  return String(s == null ? '' : s).replace(/[\/\\:*?"<>|]/g, '-').trim() || 'Sans nom';
}
/** Sous-dossier portant ce nom ; créé s'il n'existe pas. */
function sub(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function root() { return DriveApp.getFolderById(ROOT_FOLDER_ID); }
/** Met à la corbeille les fichiers de ce nom : une reprise remplace l'ancien. */
function trashByName(folder, name) {
  var n = 0;
  const it = folder.getFilesByName(name);
  while (it.hasNext()) { it.next().setTrashed(true); n++; }
  return n;
}
/** HTML → PDF nommé. */
function toPdf(html, name) {
  const base = clean(name).replace(/\.pdf$/i, '');
  return Utilities.newBlob(html, 'text/html', base + '.html')
    .getAs('application/pdf').setName(base + '.pdf');
}
/** « data:image/jpeg;base64,… » → fichier image nommé. */
function toImage(dataUrl, name) {
  const d = String(dataUrl || '');
  const virgule = d.indexOf(',');
  const b64 = virgule >= 0 ? d.substring(virgule + 1) : d;
  const m = /^data:([^;,]+)[;,]/.exec(d);
  const mime = m ? m[1] : 'image/jpeg';
  const ext = mime.indexOf('png') >= 0 ? 'png' : 'jpg';
  const base = clean(name).replace(/\.(jpe?g|png)$/i, '');
  return Utilities.newBlob(Utilities.base64Decode(b64), mime, base + '.' + ext);
}
/** Le dossier est-il bien rangé sous la racine de l'atelier (4 niveaux au plus) ? */
function underRoot(folder) {
  var f = folder;
  for (var i = 0; i < 5; i++) {
    if (f.getId() === ROOT_FOLDER_ID) return true;
    const parents = f.getParents();
    if (!parents.hasNext()) return false;
    f = parents.next();
  }
  return false;
}

// ── "archive" : ordre / devis / facture en PDF, classé par client ───────────
function archive(p) {
  if (!p.html || !p.orderNum) return out({ ok: false, error: 'html et orderNum requis' });
  const folder = sub(root(), clean(p.folder || 'Client sans nom'));
  const blob = toPdf(p.html, p.orderNum);
  const remplaces = trashByName(folder, blob.getName());   // un ré-archivage écrase la version précédente
  const file = folder.createFile(blob);
  return out({ ok: true, archived: true, id: file.getId(), url: file.getUrl(),
               folder: folder.getName(), replaced: remplaces });
}

// ── "mail" : un courriel, un PDF par document ───────────────────────────────
function sendMail(p) {
  const to = String(p.to || '').trim();
  if (!to) return out({ ok: false, error: 'Destinataire manquant' });
  const docs = Array.isArray(p.docs) ? p.docs : [];
  if (!docs.length) return out({ ok: false, error: 'Aucun document à envoyer' });

  const attachments = docs.map(function (d) { return toPdf(d.html, d.name); });
  const texte = String(p.body || '');
  MailApp.sendEmail({
    to: to,
    subject: String(p.subject || SENDER_NAME),
    body: texte,
    htmlBody: texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'),
    name: SENDER_NAME,
    replyTo: String(p.from || '') || undefined,
    attachments: attachments
  });
  return out({ ok: true, mailed: true, to: to, count: attachments.length });
}

// ── "photo" : photo d'état d'entrée → <client>/<véhicule>/<date>/ ───────────
// Le premier envoi passe `path` (3 noms) et reçoit `folderId` ; les suivants
// passent directement `folderId`, ce qui évite de recréer l'arborescence et
// d'en créer deux en parallèle.
function savePhoto(p) {
  if (!p.dataUrl || !p.name) return out({ ok: false, error: 'dataUrl et name requis' });
  var dest;
  if (p.folderId) {
    dest = DriveApp.getFolderById(String(p.folderId));
    if (!underRoot(dest)) return out({ ok: false, error: 'Dossier hors de l\'arborescence de l\'atelier' });
  } else {
    const chemin = Array.isArray(p.path) ? p.path : [];
    if (chemin.length < 1 || chemin.length > 3) return out({ ok: false, error: 'Chemin de dossier invalide' });
    dest = root();
    for (var i = 0; i < chemin.length; i++) dest = sub(dest, clean(chemin[i]));
  }
  const blob = toImage(p.dataUrl, p.name);
  const remplaces = trashByName(dest, blob.getName());     // reprendre une vue remplace la précédente
  const file = dest.createFile(blob);
  return out({ ok: true, photo: true, id: file.getId(), url: file.getUrl(), name: blob.getName(),
               folderId: dest.getId(), folderUrl: dest.getUrl(), replaced: remplaces });
}

// ── "reception" : app Réception — photos + fiche PDF par véhicule et par date ─
// Comportement d'origine conservé :  <RACINE>/Réceptions/<immatriculation>/<date d'entrée>/
function handleReception(p) {
  if (!p.inspectionNum || !p.plate) return out({ ok: false, error: 'inspectionNum et plate requis' });
  const receptions = sub(root(), 'Réceptions');
  const vehicule = sub(receptions, clean(p.plate));
  const dest = sub(vehicule, clean(p.entryDate || new Date().toISOString().slice(0, 10)));
  const result = { ok: true, folderUrl: dest.getUrl(), files: [], reportUrl: '' };

  const photos = p.photos || [];
  for (var i = 0; i < photos.length; i++) {
    const ph = photos[i];
    const label = clean(ph.label || ('photo-' + (i + 1)));
    try {
      const blob = toImage(ph.dataUrl || ph.data, clean(p.inspectionNum) + '_' + label);
      const f = dest.createFile(blob);
      result.files.push({ label: ph.label || label, name: blob.getName(), id: f.getId(), url: f.getUrl() });
    } catch (errPhoto) {
      result.files.push({ label: ph.label || label, error: String(errPhoto) });
    }
  }
  if (p.html) {
    const pdf = toPdf(p.html, p.inspectionNum);
    trashByName(dest, pdf.getName());
    result.reportUrl = dest.createFile(pdf).getUrl();
  }
  return out(result);
}
