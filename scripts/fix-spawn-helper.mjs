#!/usr/bin/env node
// node-pty execs a separate `spawn-helper` binary on macOS. npm does not
// reliably preserve its executable bit when extracting the package
// tarball, and without it EVERY terminal spawn fails with a bare
// "posix_spawnp failed." that names nothing.
//
// This runs on postinstall so a macOS install works out of the box.
// It is deliberately timid: macOS only, that one file only, only when
// the bit is actually missing, and it never fails the install — the
// doctor check remains the safety net for `npm install --ignore-scripts`.

import { accessSync, chmodSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

try {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('node-pty/package.json');
  const helper = join(
    dirname(pkg),
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );

  try {
    accessSync(helper, constants.X_OK);
    process.exit(0); // already fine
  } catch {
    // not executable, or missing
  }

  accessSync(helper, constants.F_OK); // throws if genuinely absent
  chmodSync(helper, 0o755);
  process.stdout.write(`autocast: made node-pty spawn-helper executable\n  ${helper}\n`);
} catch {
  // Never fail an install over this. `autocast doctor` reports it with
  // the exact chmod if it is still wrong.
}
