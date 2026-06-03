import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { initializeDatabase } from '../src/database/db'
import { registerIpcHandlers } from './ipc-handlers'
import { initializeTray } from './tray'
import { initializeAutoUpdater } from './auto-updater'
import { initializeAwayDetector } from './away-detector'
import { initializeMiniPlayer } from './mini-player'
import { handleOAuthCallback } from './oauth-service'
import { configureLogging } from './logger'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')
configureLogging()

// Load package.json early to set app identity
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));

// Set app identity as early as possible
app.name = pkg.productName || 'Jira Time Tracker';
if (process.platform === 'win32') {
  // Use appId for grouping if possible, but productName for pretty title
  app.setAppUserModelId(pkg.build?.appId || 'com.pmarien.jira-timetracker');
}

// Custom URL scheme for OAuth
const PROTOCOL = 'jira-timetracker-app';

// Register as default protocol client (for OAuth callbacks)
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// Handle protocol URL on macOS
app.on('open-url', (event, url) => {
  event.preventDefault()
  console.log('[Main] Received open-url:', url)
  if (url.startsWith(`${PROTOCOL}://oauth/callback`)) {
    handleOAuthCallback(url)
  }
})

// Prevent multiple instances and handle protocol URL on Windows/Linux
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    console.log('[Main] Second instance detected, command line:', commandLine)

    // Handle protocol URL from command line (Windows/Linux)
    const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`))
    if (url) {
      console.log('[Main] Found protocol URL:', url)
      handleOAuthCallback(url)
    }

    // Focus the main window
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      const mainWindow = windows.find(w => !w.webContents.getURL().includes('mini-player')) || windows[0]
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'icon.ico'),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  if (win) {
    initializeTray(win)
    initializeAutoUpdater(win)
    initializeAwayDetector(win)
    initializeMiniPlayer(win)
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  initializeDatabase()
  registerIpcHandlers()
  createWindow()

  // Handle protocol URL if app was started with one (Windows/Linux)
  const url = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`))
  if (url) {
    console.log('[Main] App started with protocol URL:', url)
    // Delay slightly to ensure handlers are registered
    setTimeout(() => handleOAuthCallback(url), 500)
  }
})

