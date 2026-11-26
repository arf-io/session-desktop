import {
  BrowserWindow,
  desktopCapturer,
  DesktopCapturerSource,
  shell,
  systemPreferences,
  WebFrameMain,
} from 'electron';

import { UserConfig } from './config/user_config';
import type { ScreenShareMode, ScreenShareSourcesResult } from '../util/screenShare';

/**
 * Whether Chromium captures through the xdg-desktop-portal (PipeWire) rather than listing sources
 * itself. This mirrors WebRTC's own test (DesktopCapturer::IsRunningUnderWayland): a Wayland
 * session type and a Wayland display. There, desktopCapturer.getSources() opens the portal's
 * picker as a side effect and returns only what the user chose in it.
 */
export function capturesThroughPortal(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  return (
    platform === 'linux' &&
    Boolean(env.XDG_SESSION_TYPE?.startsWith('wayland')) &&
    Boolean(env.WAYLAND_DISPLAY)
  );
}

type ScreenShareSystem = {
  getSources: (options: Electron.SourcesOptions) => Promise<Array<DesktopCapturerSource>>;
  screenAccess: () => ScreenShareSourcesResult['screenAccess'];
  usesPortal: () => boolean;
};

const electronScreenShareSystem: ScreenShareSystem = {
  getSources: options => desktopCapturer.getSources(options),
  screenAccess: () =>
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
  usesPortal: () => capturesThroughPortal(process.platform, process.env),
};

export function installScreenSharePicker(
  window: BrowserWindow,
  pageURL: string,
  config: UserConfig,
  system: ScreenShareSystem = electronScreenShareSystem
) {
  const contents = window.webContents;
  const page = new URL(pageURL);
  const session = contents.session;
  let generation = 0;
  let choices: Array<DesktopCapturerSource> = [];
  let selection: { source: DesktopCapturerSource; expires: number } | null = null;

  function clear() {
    generation += 1;
    choices = [];
    selection = null;
  }

  function allowed(frame: WebFrameMain | null) {
    if (
      !frame ||
      contents.isDestroyed() ||
      frame !== contents.mainFrame ||
      !config.get('mediaPermissions')
    ) {
      return false;
    }
    const current = new URL(frame.url);
    return (
      current.protocol === page.protocol &&
      current.host === page.host &&
      current.pathname === page.pathname
    );
  }

  const { screenAccess } = system;
  const portal = system.usesPortal();

  contents.ipc.handle(
    'get-screen-share-mode',
    (): ScreenShareMode => (portal ? 'portal' : 'picker')
  );

  contents.ipc.handle(
    'get-screen-share-sources',
    async (event): Promise<ScreenShareSourcesResult> => {
      if (!allowed(event.senderFrame)) {
        return { screenAccess: 'denied', sources: [] };
      }
      if (portal) {
        // listing would open the portal's picker; in portal mode the request below does that
        return { screenAccess: 'granted', sources: [] };
      }
      clear();
      const request = generation;
      let status = screenAccess();
      // Electron reports an app macOS has never asked as 'denied', and only a capture
      // attempt makes macOS prompt and list it under Screen Recording.
      if (status !== 'restricted') {
        let sources: Array<DesktopCapturerSource> = [];
        try {
          sources = await system.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 320, height: 180 },
          });
        } catch (e) {
          // Without screen recording access, macOS makes getSources() throw rather than
          // return nothing; the status read below then tells the picker to ask for it.
          console.warn('screen share: could not list sources:', e?.message);
        }
        status = screenAccess();
        if (request === generation && allowed(event.senderFrame) && status === 'granted') {
          choices = sources;
          return {
            screenAccess: status,
            sources: sources.map(source => ({
              id: source.id,
              name: source.name,
              thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
            })),
          };
        }
      }
      return { screenAccess: status, sources: [] };
    }
  );

  contents.ipc.handle('set-screen-share-source', (event, id: string | null) => {
    if (portal || !allowed(event.senderFrame)) {
      return false;
    }
    const source = choices.find(item => item.id === id);
    clear();
    if (!source) {
      return false;
    }
    selection = { source, expires: Date.now() + 5000 };
    return true;
  });

  contents.ipc.handle('open-screen-recording-settings', async event => {
    if (process.platform === 'darwin' && allowed(event.senderFrame)) {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      );
    }
  });

  async function respondFromPortal(
    frame: WebFrameMain | null,
    respond: (streams: Electron.Streams | null) => void
  ) {
    let source: DesktopCapturerSource | undefined;
    try {
      // Opens the portal's own picker. Only the chosen source comes back, so no thumbnails.
      [source] = await system.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
    } catch (e) {
      // what a cancel in the portal's dialog looks like: the user chose not to share
      console.info('screen share: the portal returned no source:', e?.message);
    }
    respond(source && allowed(frame) ? { video: source } : null);
  }

  session.setDisplayMediaRequestHandler((request, callback) => {
    // Electron 40 accepts null to decline a request. Its declaration only lists Streams.
    const respond = callback as (streams: Electron.Streams | null) => void;
    if (
      !allowed(request.frame) ||
      !request.userGesture ||
      !request.videoRequested ||
      request.audioRequested
    ) {
      respond(null);
      return;
    }
    if (portal) {
      clear();
      void respondFromPortal(request.frame, respond);
      return;
    }
    const picked = selection;
    clear();
    respond(
      picked && picked.expires >= Date.now() && screenAccess() === 'granted'
        ? { video: picked.source }
        : null
    );
  });

  contents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) {
      clear();
    }
  });
  contents.once('destroyed', () => {
    clear();
    session.setDisplayMediaRequestHandler(null);
  });
}
