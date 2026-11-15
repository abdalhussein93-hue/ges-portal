'use strict';
/**
 * Command line tools (run on the server):
 *   node src/cli.js reset-admin [username]        new temporary password for an admin account
 *   node src/cli.js import <app> <file.json>      load a desktop app_data.json into an app (old data is backed up)
 *   node src/cli.js status                        revision and size of each app's data
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createContainer } = require('./container');
const { cleanValue } = require('./domain/text');
const { acquireInstanceLock } = require('./db/instance-lock');

async function main(args) {
  const [command, a1, a2] = args;
  if (!['reset-admin', 'import', 'status'].includes(command)) {
    console.log('Usage:\n  node src/cli.js reset-admin [username]\n  node src/cli.js import <camp|manpower|costing> <file.json>\n  node src/cli.js status');
    return 1;
  }
  const c = await createContainer(loadConfig(), { log: () => { } });
  try {
    if (command === 'reset-admin') {
      const username = (a1 || c.config.admin.username).toLowerCase();
      const pw = await c.userAdmin.resetAdmin(username);
      console.log(`Admin account "${username}" - temporary password: ${pw}\nChoose a new password after signing in.`);
      return 0;
    }
    if (command === 'import') {
      // the running server keeps data in memory: importing behind its back is not allowed
      const lock = await acquireInstanceLock(c.db, 'The import');
      try { return await importFile(c, a1, a2); } finally { await lock.release(); }
    }
    await c.documents.init();
    if (command === 'status') {
      for (const app of c.apps.list()) {
        const { rev, doc } = c.documents.get(app.id);
        console.log(`${app.id.padEnd(9)} revision ${rev}  ${doc ? `${(JSON.stringify(doc).length / 1048576).toFixed(2)} MB` : '(empty)'}`);
      }
      return 0;
    }
    return 0;
  } finally {
    c.live.close();
    await c.db.close();
  }
}

async function importFile(c, appId, file) {
  const app = c.apps.get(appId);
  if (!app || !file) { console.error('Usage: node src/cli.js import <camp|manpower|costing> <file.json>'); return 1; }
  await c.documents.init();
  const doc = cleanValue(app.importDocument(JSON.parse(fs.readFileSync(file, 'utf-8'))), app.textMode).value;
  app.normalise(doc);
  const rev = await c.documents.replace(app.id, 'console', doc, path.basename(file));
  await c.audit.record({ username: 'console', appId: app.id, action: 'import', details: { fileName: path.basename(file), rev } });
  console.log(`Imported ${path.basename(file)} into ${app.name} (revision ${rev}). The previous data was kept as a backup.`);
  return 0;
}

main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
