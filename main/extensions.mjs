// The Pro hook. The official build ships a private `pro/` folder (copied in from the ploink-pro
// repo by scripts/release.mjs) next to main/. Builds from the public source have no such folder
// and run as the free app. The Pro module exports:
//   packs:    an array of pack objects (same format as packs/*.ploinkpack)
//   version:  a string, shown in Settings
//   activate: optional (ctx) => void, for Pro features that need the runner, store or IPC
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPro(root) {
  const entry = path.join(root, 'pro', 'index.mjs');
  if (!fs.existsSync(entry)) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    return {
      packs: Array.isArray(mod.packs) ? mod.packs : [],
      version: String(mod.version || ''),
      activate: typeof mod.activate === 'function' ? mod.activate : null,
    };
  } catch (err) {
    console.error('[ploink] the Pro module failed to load:', err);
    return null;
  }
}
