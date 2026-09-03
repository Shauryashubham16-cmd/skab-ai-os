// Intentionally minimal. The renderer (public/index.html) is loaded as a
// normal web page over http://localhost — it talks to the backend the exact
// same way it does in a browser (fetch + Socket.IO), and gets no direct
// Node.js or Electron access. That's a deliberate security choice: nothing
// in the current app needs it.
//
// If a future feature needs real OS access (desktop control, native file
// dialogs, etc.), it belongs here as an explicit, narrow contextBridge API —
// not by turning nodeIntegration on. Example shape for when that's needed:
//
//   const { contextBridge } = require('electron');
//   contextBridge.exposeInMainWorld('jarvisNative', {
//     someNarrowAction: (...args) => ipcRenderer.invoke('some-narrow-action', ...args),
//   });
