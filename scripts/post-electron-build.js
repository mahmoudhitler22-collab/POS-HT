// Post-build script: writes a package.json to dist-electron/ so that
// Node/Electron treats the compiled .js files as CommonJS (since the
// root package.json has "type": "module").
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const outDir = 'dist-electron';
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'
);

console.log('[post-electron-build] Wrote dist-electron/package.json with type: commonjs');
