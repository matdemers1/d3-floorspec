import { dumpDatabase } from '../boot.js';
import { ConfigError, loadConfig } from '../config.js';

/**
 * `node dist/cli/backup.js` — one pg_dump into BACKUP_DIR, its path printed. Shipyard's backup step
 * runs this inside the running api container before every deploy (deploy/shipyard.yml); success is
 * exit 0 and a new non-empty file under the backups volume.
 */
try {
  const config = loadConfig();
  const path = await dumpDatabase(config, 'predeploy');
  process.stdout.write(`${path}\n`);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`backup refused:\n  ${error.problems.join('\n  ')}\n`);
  } else {
    process.stderr.write(`backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
