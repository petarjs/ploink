// Renders build/icon.svg and build/tray.svg to transparent PNGs using Chromium's canvas.
// Run: npx electron build/render-icons.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  ['icon.svg', 'icon.png', 1024],
  ['tray.svg', 'trayTemplate.png', 22],
  ['tray.svg', 'trayTemplate@2x.png', 44],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(dir, src), 'utf8');
    const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const data = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = ${JSON.stringify(url)}; await img.decode();
      const c = document.querySelector('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.clearRect(0, 0, ${size}, ${size}); g.drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(dir, out), Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', out);
  }
  app.quit();
});
