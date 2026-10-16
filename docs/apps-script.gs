/**
 * DMS Atelier BTS MV — Lycée Gallieni
 * Application web Apps Script : conversion HTML → PDF, archivage Drive, envoi par courriel.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MISE À JOUR : reprends tes DEUX valeurs actuelles ci-dessous (SECRET et
 * ROOT_FOLDER_ID), colle le reste tel quel, Enregistrer, puis
 * Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version → Déployer.
 * L'URL /exec ne change pas : rien à modifier côté Supabase.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * L'archivage fonctionne exactement comme avant. Seule nouveauté : l'action
 * "mail", qui renvoie { ok:true, mailed:true } — ce marqueur permet à
 * l'application de distinguer un envoi réel d'un script resté à l'ancienne version.
 *
 * Les courriels partent du compte Google propriétaire de ce script.
 * Quota : ~100 destinataires/jour (compte gratuit), ~1500 (Google Workspace).
 */

// ─── À REPRENDRE DE TON SCRIPT ACTUEL ──────────────────────────────────────
const SECRET         = 'REMPLACE_PAR_TON_SECRET_ACTUEL';   // = secret APPS_SCRIPT_SECRET côté Supabase
const ROOT_FOLDER_ID = 'REMPLACE_PAR_TON_ID_DE_DOSSIER';   // dossier Drive qui contient les dossiers clients
// Nom affiché comme expéditeur des courriels
const SENDER_NAME    = 'Lycée Gallieni – Atelier BTS MV';
// ───────────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.secret !== SECRET) return out({ ok: false, error: 'Secret invalide' });
    return p.action === 'mail' ? sendMail(p) : archive(p);
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

/** HTML → pièce jointe PDF nommée. */
function toPdf(html, name) {
  const base = String(name || 'document').replace(/\.pdf$/i, '');
  return Utilities.newBlob(html, 'text/html', base + '.html')
    .getAs('application/pdf')
    .setName(base + '.pdf');
}

/** Dossier portant ce nom sous la racine ; créé s'il n'existe pas. */
function folderFor(name) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/** action "archive" — comportement inchangé. */
function archive(p) {
  if (!p.html || !p.orderNum) return out({ ok: false, error: 'html et orderNum requis' });
  const folder = folderFor(p.folder || 'Client sans nom');
  const file = folder.createFile(toPdf(p.html, p.orderNum));
  return out({ ok: true, id: file.getId(), url: file.getUrl(), folder: folder.getName() });
}

/** action "mail" — un courriel, un PDF par document. */
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

  // `mailed` est le marqueur attendu par l'application : ne pas le retirer.
  return out({ ok: true, mailed: true, to: to, count: attachments.length });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
