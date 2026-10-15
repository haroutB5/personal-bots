const { DatabaseSync } = require('node:sqlite');
const [, , file, cmd] = process.argv;
const db = new DatabaseSync(file);
try {
  if (cmd === 'delete-memory') db.exec("DELETE FROM personal_memory WHERE id IN ('m0','m1')");
  else throw new Error('unknown command ' + cmd);
} finally { db.close(); }
