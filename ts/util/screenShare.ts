import { ipcRenderer } from 'electron';

export type ScreenShareSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
};

export type ScreenShareSourcesResult = {
  screenAccess: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
  sources: Array<ScreenShareSource>;
};

/**
 * 'portal': the OS (xdg-desktop-portal on Wayland) shows its own picker when the share starts, so
 * Session's picker is skipped. 'picker': Session lists the sources and the user picks one.
 */
export type ScreenShareMode = 'portal' | 'picker';

export const getScreenShareMode = (): Promise<ScreenShareMode> =>
  ipcRenderer.invoke('get-screen-share-mode');

export const getScreenShareSources = (): Promise<ScreenShareSourcesResult> =>
  ipcRenderer.invoke('get-screen-share-sources');

export const setScreenShareSource = (sourceId: string | null): Promise<boolean> =>
  ipcRenderer.invoke('set-screen-share-source', sourceId);

export const openScreenRecordingSettings = (): Promise<void> =>
  ipcRenderer.invoke('open-screen-recording-settings');
