'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadStreams: () => ipcRenderer.invoke('streams:load'),
  saveStreams: (list) => ipcRenderer.invoke('streams:save', list),
});
