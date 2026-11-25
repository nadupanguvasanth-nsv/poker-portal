// Smart Buddies storage. Paste this into a Google Apps Script project in the club's
// Gmail account, change SECRET, then deploy it as a Web app
// (Execute as: Me, Who has access: Anyone).
//
// It keeps the whole club - members, games, statements, replays and any game in
// progress - in one JSON file in Drive, and keeps a dated copy of the last few days.
var SECRET = 'CHANGE-THIS-TO-A-LONG-RANDOM-PHRASE';
var FILE_NAME = 'smart-buddies-data.json';
var BACKUP_DAYS = 7; // dated copies kept; older ones are deleted

function props_() { return PropertiesService.getScriptProperties(); }

// The one file we read and write. Found by id so a second file of the same name
// can never take over, and re-found by name if it is ever moved or trashed.
function file_() {
  var id = props_().getProperty('fileId');
  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* deleted or out of reach: fall through and find it again */ }
  }
  var it = DriveApp.getFilesByName(FILE_NAME);
  while (it.hasNext()) {
    var g = it.next();
    if (!g.isTrashed()) { props_().setProperty('fileId', g.getId()); return g; }
  }
  var made = DriveApp.createFile(FILE_NAME, '{}', 'application/json');
  props_().setProperty('fileId', made.getId());
  return made;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    if (!e || !e.parameter || e.parameter.key !== SECRET) return out_({ ok: false, error: 'denied' });
    var f = file_();
    if (e.parameter.action === 'info') { // a quick health check you can open in a browser
      return out_({ ok: true, name: f.getName(), bytes: f.getSize(), updated: f.getLastUpdated(), backups: backups_().length });
    }
    var v = null;
    try { v = JSON.parse(f.getBlob().getDataAsString()); } catch (err) { v = null; }
    if (v && Object.keys(v).length === 0) v = null;
    return out_({ ok: true, value: v });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var got = false;
  try {
    got = lock.tryLock(25000);
    if (!got) return out_({ ok: false, error: 'busy, try again' });
    var b = JSON.parse(e.postData.contents);
    if (b.key !== SECRET) return out_({ ok: false, error: 'denied' });
    if (b.action !== 'set') return out_({ ok: false, error: 'unknown action' });
    if (!b.value || typeof b.value !== 'object') return out_({ ok: false, error: 'nothing to save' });
    var text = JSON.stringify(b.value);
    backup_(text);
    file_().setContent(text);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (got) lock.releaseLock();
  }
}

function backups_() {
  var out = [], it = DriveApp.searchFiles('title contains "smart-buddies-backup-" and trashed = false');
  while (it.hasNext()) out.push(it.next());
  return out;
}

// One copy a day, taken before the first save of that day, and only of a sane file.
function backup_(text) {
  try {
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (props_().getProperty('backupDay') === today) return;
    if (!text || text.length < 200) return; // never let an empty save become the backup
    props_().setProperty('backupDay', today);
    DriveApp.createFile('smart-buddies-backup-' + today + '.json', text, 'application/json');
    var old = backups_().sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
    for (var i = BACKUP_DAYS; i < old.length; i++) old[i].setTrashed(true);
  } catch (err) { /* a backup must never stop a save */ }
}

function setup() { file_(); }
