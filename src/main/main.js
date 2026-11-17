'use strict';

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { isValidStream, streamKey, MAX_STREAMS } = require('../shared/parse.js');

const STREAM_PARTITION = 'persist:streams';
const ALLOWED_PLAYER_HOSTS = new Set([
  'player.twitch.tv',
  'player.kick.com',
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);
const ALLOWED_STREAM_PERMISSIONS = new Set(['fullscreen']);
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

let mainWindow = null;
let saveQueue = Promise.resolve();

/** Rebuilds the default UA as a plain Chrome UA (no "Electron/x" or app-name tokens). */
function buildChromeUserAgent(defaultUa) {
  const platformMatch = /\(([^)]+)\)/.exec(defaultUa || '');
  const platform = platformMatch ? platformMatch[1] : 'Windows NT 10.0; Win64; x64';
  const major = String(process.versions.chrome || '130').split('.')[0];
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

app.userAgentFallback = buildChromeUserAgent(app.userAgentFallback);
// Players start unmuted inside their page; audio is gated per webview with setAudioMuted().
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function parseUrlSafe(value) {
  try {
    return new URL(String(value));
  } catch (err) {
    return null;
  }
}

function isHttpUrl(value) {
  const url = parseUrlSafe(value);
  return Boolean(url) && (url.protocol === 'https:' || url.protocol === 'http:');
}

function isAllowedPlayerUrl(value) {
  const url = parseUrlSafe(value);
  return Boolean(url) && url.protocol === 'https:' && ALLOWED_PLAYER_HOSTS.has(url.hostname);
}

function openExternalSafe(url) {
  if (!isHttpUrl(url)) return;
  shell.openExternal(url).catch((err) => console.error('openExternal failed:', err));
}

function storePath() {
  return path.join(app.getPath('userData'), 'streams.json');
}

function normalizeStream(item) {
  return { platform: item.platform, channel: item.channel };
}

/** Lenient: used for data read from disk (drops bad/duplicate entries). */
function sanitizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (result.length >= MAX_STREAMS) break;
    if (!isValidStream(item) || seen.has(streamKey(item))) continue;
    seen.add(streamKey(item));
    result.push(normalizeStream(item));
  }
  return result;
}

/** Strict: used for data coming from the renderer (rejects anything invalid). */
function validateForSave(list) {
  if (!Array.isArray(list)) throw new Error('Geçersiz liste.');
  if (list.length > MAX_STREAMS) throw new Error(`En fazla ${MAX_STREAMS} yayın kaydedilebilir.`);
  if (!list.every(isValidStream)) throw new Error('Listede geçersiz yayın var.');
  const normalized = list.map(normalizeStream);
  const keys = new Set(normalized.map(streamKey));
  if (keys.size !== normalized.length) throw new Error('Listede tekrar eden yayın var.');
  return normalized;
}

async function loadStreams() {
  try {
    const raw = await fs.promises.readFile(storePath(), 'utf8');
    return sanitizeList(JSON.parse(raw));
  } catch (err) {
    return [];
  }
}

async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function saveStreams(list) {
  const data = JSON.stringify(validateForSave(list), null, 2);
  const task = saveQueue.then(() => writeAtomic(storePath(), data));
  saveQueue = task.catch(() => undefined);
  return task.then(() => true);
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Yetkisiz IPC çağrısı.');
  }
}

function registerIpc() {
  ipcMain.handle('streams:load', (event) => {
    assertTrustedSender(event);
    return loadStreams();
  });
  ipcMain.handle('streams:save', (event, list) => {
    assertTrustedSender(event);
    return saveStreams(list);
  });
}

function hardenWebviewAttach(contents) {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!isAllowedPlayerUrl(params.src)) {
      console.warn('Blocked webview attach:', params.src);
      event.preventDefault();
    }
  });
}

function isOfficialSiteUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return protocol === 'https:' && ['twitch.tv', 'kick.com', 'youtube.com', 'youtu.be'].some((d) => host === d || host.endsWith(`.${d}`));
  } catch (err) {
    return false;
  }
}

function configurePermissions() {
  const streamSession = session.fromPartition(STREAM_PARTITION);
  streamSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_STREAM_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // YouTube (googlevideo, ytimg) video akis basliklarini sagla (Error 152-4 ve 153 hatalarini onler)
  const filter = {
    urls: [
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://*.googlevideo.com/*',
      '*://*.ytimg.com/*',
    ],
  };

  [streamSession, session.defaultSession].forEach((sess) => {
    sess.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      callback({ requestHeaders: details.requestHeaders });
    });

    sess.webRequest.onHeadersReceived(filter, (details, callback) => {
      const responseHeaders = Object.assign({}, details.responseHeaders);
      delete responseHeaders['x-frame-options'];
      delete responseHeaders['X-Frame-Options'];
      callback({ responseHeaders });
    });
  });
}

app.on('web-contents-created', (_event, contents) => {
  const isGuest = contents.getType() === 'webview';
  contents.setWindowOpenHandler(({ url }) => {
    // Guest players (and their ad scripts) may only open official Twitch/Kick pages.
    if (!isGuest || isOfficialSiteUrl(url)) openExternalSafe(url);
    return { action: 'deny' };
  });
  if (contents.getType() === 'webview') {
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault();
    });
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    title: 'MultiStream Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  hardenWebviewAttach(mainWindow.webContents);
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(INDEX_HTML);
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);
  app.whenReady().then(() => {
    configurePermissions();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
