/**
 * DMS Gallieni — Archivage des ordres de réparation en PDF dans Google Drive.
 *
 * INSTALLATION (une seule fois) :
 *  1. https://script.google.com → Nouveau projet → colle ce code.
 *  2. Remplace la valeur de SECRET ci-dessous par une longue chaîne aléatoire
 *     (la MÊME que le secret Supabase APPS_SCRIPT_SECRET).
 *  3. Déployer → Nouveau déploiement → type « Application Web » :
 *        - Exécuter en tant que : Moi
 *        - Qui a accès : Tout le monde
 *     → Autorise l'accès à ton Drive quand c'est demandé.
 *  4. Copie l'URL qui finit par « /exec » → c'est le secret Supabase APPS_SCRIPT_URL.
 *
 * Les PDF sont rangés dans : Mon Drive / <ROOT_FOLDER_NAME> / <nom du client> / OR-AAAA-XXXX.pdf
 */

var SECRET = 'A_REMPLACER_PAR_UN_SECRET_ALEATOIRE';
var ROOT_FOLDER_NAME = 'DMS Gallieni - Ordres de réparation';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return out({ ok: false, error: 'secret invalide' });
    if (!body.html || !body.orderNum) return out({ ok: false, error: 'html et orderNum requis' });

    var root = getFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    var sub = getFolder_(root, sanitize_(body.folder || 'Client sans nom'));
    var name = sanitize_(body.orderNum) + '.pdf';

    // HTML → PDF
    var pdf = Utilities.newBlob(body.html, 'text/html', name).getAs('application/pdf').setName(name);

    // Écrase un éventuel fichier du même nom (mise à jour à la clôture).
    var existing = sub.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);

    var file = sub.createFile(pdf);
    return out({ ok: true, fileId: file.getId(), url: file.getUrl() });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function getFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function sanitize_(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, '-').trim() || 'Sans nom';
}
function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
