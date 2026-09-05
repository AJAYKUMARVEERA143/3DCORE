// electron/main.js — desktop entry point. Loads the exact same web/ editor
// used in the browser (index.html unchanged, no client-side code forked or
// duplicated) against a local Node server (server.js in this folder) that
// answers the same /api/* routes server.py does, so the app works
// completely standalone with no Python/browser dependency for the end user.
'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServers } = require('./server');

const PORT = Number(process.env.PORT) || 8000;
const WS_PORT = Number(process.env.WS_PORT) || PORT + 1;
// 0.0.0.0 by default, matching server.py's own default — required for the
// LAN P2P render pool feature (other devices need to reach this instance's
// signaling relay). Still only reachable on the local network, never the
// open internet. Set THREED_CORE_HOST=127.0.0.1 to restrict to this machine.
const HOST = process.env.THREED_CORE_HOST || '0.0.0.0';

// In a packaged build, app resources are read-only (inside an .asar
// archive) — ai_config.json must live in the OS's real per-user app-data
// directory instead of next to the code, same reason Electron apps never
// write into their own install directory.
const webDir = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');
const assetsDir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', 'assets');
const aiConfigPath = path.join(app.getPath('userData'), 'ai_config.json');

function createWindow() {
    const win = new BrowserWindow({
        width: 1600,
        height: 950,
        minWidth: 1024,
        minHeight: 700,
        icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        backgroundColor: '#1a1a1a', // matches manifest.json's background_color — no white flash before the real page paints
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
        show: false,
    });

    win.once('ready-to-show', () => win.show());
    win.loadURL(`http://127.0.0.1:${PORT}/`);

    // Any link the app tries to open in a new window/tab (e.g. a docs link)
    // opens in the user's real browser instead of a second app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    return win;
}

app.whenReady().then(() => {
    if (!fs.existsSync(path.dirname(aiConfigPath))) fs.mkdirSync(path.dirname(aiConfigPath), { recursive: true });
    startServers({ webDir, assetsDir, aiConfigPath, port: PORT, wsPort: WS_PORT, host: HOST });
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
