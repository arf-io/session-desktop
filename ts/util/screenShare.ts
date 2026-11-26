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

/**
 * Why the main process declined a share. A share the user cancelled has no reason, so it is quiet.
 * - 'no-permission': the "Voice and Video Calls" permission is off
 * - 'not-allowed': the request did not come from Session's page as Session makes it
 * - 'no-user-gesture': the request did not follow a click
 * - 'no-selection': the picked source was no longer on offer (another listing, a navigation)
 * - 'expired': the share started more than 5 seconds after the source was picked
 * - 'no-access': the OS refused screen recording (macOS)
 */
export type ScreenShareRefusal =
  | 'no-permission'
  | 'not-allowed'
  | 'no-user-gesture'
  | 'no-selection'
  | 'expired'
  | 'no-access';

/** Reads the reason the last share was declined, and forgets it. */
export const takeScreenShareRefusal = (): Promise<ScreenShareRefusal | null> =>
  ipcRenderer.invoke('take-screen-share-refusal');

export const getScreenShareSources = (): Promise<ScreenShareSourcesResult> =>
  ipcRenderer.invoke('get-screen-share-sources');

export const setScreenShareSource = (sourceId: string | null): Promise<boolean> =>
  ipcRenderer.invoke('set-screen-share-source', sourceId);

export const openScreenRecordingSettings = (): Promise<void> =>
  ipcRenderer.invoke('open-screen-recording-settings');
