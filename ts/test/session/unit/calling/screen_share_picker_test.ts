import { assert } from 'chai';
import type { BrowserWindow, DesktopCapturerSource, Session, WebFrameMain } from 'electron';
import Sinon from 'sinon';

import type { UserConfig } from '../../../../node/config/user_config';
import { capturesThroughPortal, installScreenSharePicker } from '../../../../node/screenShare';

type DisplayHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>;
type IpcHandler = (event: { senderFrame: WebFrameMain | null }, ...args: Array<any>) => any;

const pageURL = 'file:///session/background.html';

function fakeSource(id: string): DesktopCapturerSource {
  return {
    id,
    name: `source ${id}`,
    display_id: '',
    appIcon: null as any,
    thumbnail: { isEmpty: () => true, toDataURL: () => '' } as any,
  };
}

function setup(
  getSources = Sinon.stub().resolves([fakeSource('screen:1'), fakeSource('window:2')]),
  screenAccess: () => 'granted' | 'denied' | 'restricted' = () => 'granted',
  usesPortal = false
) {
  const mainFrame = { url: pageURL } as WebFrameMain;
  const handlers = new Map<string, IpcHandler>();
  const register = Sinon.spy();
  const on = Sinon.stub();
  const window = {
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      ipc: { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) },
      session: { setDisplayMediaRequestHandler: register },
      on,
      once: Sinon.stub(),
    },
  } as unknown as BrowserWindow;
  let mediaPermissions = true;
  const config = { get: (key: string) => key === 'mediaPermissions' && mediaPermissions };
  installScreenSharePicker(window, pageURL, config as unknown as UserConfig, {
    getSources,
    screenAccess,
    usesPortal: () => usesPortal,
  });

  const displayHandler: DisplayHandler = register.firstCall.args[0];
  const event = { senderFrame: mainFrame };
  const request = {
    frame: mainFrame,
    securityOrigin: 'file://',
    audioRequested: false,
    videoRequested: true,
    userGesture: true,
  };
  const requestDisplay = () => {
    const respond = Sinon.spy();
    displayHandler(request, respond);
    return respond.firstCall.args[0];
  };
  // the portal path answers after an await, so wait for the response rather than reading it
  const requestDisplayLater = (overrides: Partial<typeof request> = {}) =>
    new Promise<Electron.Streams | null>(resolve => {
      displayHandler({ ...request, ...overrides }, resolve as any);
    });
  const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    for (const call of on.getCalls()) {
      if (call.args[0] === 'did-start-navigation') {
        call.args[1](details);
      }
    }
  };
  return {
    mainFrame,
    request,
    displayHandler,
    requestDisplay,
    requestDisplayLater,
    navigate,
    mode: () => handlers.get('get-screen-share-mode')!(event),
    refusal: () => handlers.get('take-screen-share-refusal')!(event),
    setMediaPermissions: (value: boolean) => {
      mediaPermissions = value;
    },
    listSources: () => handlers.get('get-screen-share-sources')!(event),
    pick: (id: string | null) => handlers.get('set-screen-share-source')!(event, id),
  };
}

describe('screen share picker', () => {
  afterEach(() => {
    Sinon.restore();
  });

  it('declines requests from a closed frame and requests with no selected source', () => {
    const { request, displayHandler } = setup();
    const respond = Sinon.spy();
    displayHandler({ ...request, frame: null }, respond);
    displayHandler(request, respond);

    assert.deepEqual(respond.args, [[null], [null]]);
  });

  it('grants the picked source to one request only', async () => {
    const picker = setup();
    const listed = await picker.listSources();
    assert.deepEqual(
      listed.sources.map((s: { id: string }) => s.id),
      ['screen:1', 'window:2']
    );

    assert.isTrue(await picker.pick('window:2'));
    assert.strictEqual(picker.requestDisplay()?.video?.id, 'window:2');
    assert.isNull(picker.requestDisplay());
  });

  it('refuses a source that was not offered', async () => {
    const picker = setup();
    await picker.listSources();

    assert.isFalse(await picker.pick('screen:99'));
    assert.isNull(picker.requestDisplay());
  });

  it('declines a selection older than five seconds', async () => {
    const clock = Sinon.useFakeTimers({ now: 1_000_000 });
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    clock.tick(5001);
    assert.isNull(picker.requestDisplay());
  });

  it('drops sources listed after the picker was cancelled', async () => {
    let resolveSources: (sources: Array<DesktopCapturerSource>) => void = () => {};
    const picker = setup(
      Sinon.stub().returns(
        new Promise<Array<DesktopCapturerSource>>(resolve => {
          resolveSources = resolve;
        })
      )
    );
    const listing = picker.listSources();
    await picker.pick(null);
    resolveSources([fakeSource('screen:1')]);

    assert.isEmpty((await listing).sources);
    assert.isFalse(await picker.pick('screen:1'));
  });

  it('asks macOS for sources while access is not granted yet, without offering them', async () => {
    const getSources = Sinon.stub().resolves([fakeSource('screen:1')]);
    const picker = setup(getSources, () => 'denied');

    const listed = await picker.listSources();

    assert.isTrue(getSources.calledOnce, 'the capture attempt is what makes macOS prompt');
    assert.strictEqual(listed.screenAccess, 'denied');
    assert.isEmpty(listed.sources);
    assert.isFalse(await picker.pick('screen:1'));
  });

  it('reports missing access when listing sources fails before it is granted', async () => {
    const picker = setup(Sinon.stub().rejects(new Error('Failed to get sources.')), () => 'denied');

    const listed = await picker.listSources();

    assert.strictEqual(listed.screenAccess, 'denied');
    assert.isEmpty(listed.sources);
  });

  it('clears the selection when the main frame navigates to another document', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    picker.navigate({ isMainFrame: true, isSameDocument: false });

    assert.isNull(picker.requestDisplay());
  });

  it('keeps the selection on a same-document or subframe navigation', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    picker.navigate({ isMainFrame: true, isSameDocument: true });
    picker.navigate({ isMainFrame: false, isSameDocument: false });

    assert.strictEqual(picker.requestDisplay()?.video?.id, 'screen:1');
  });

  it('declines a request that asks for audio, or for no video', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    const respond = Sinon.spy();
    picker.displayHandler({ ...picker.request, audioRequested: true }, respond);
    assert.deepEqual(respond.args, [[null]]);

    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));
    picker.displayHandler({ ...picker.request, videoRequested: false }, respond);
    assert.deepEqual(respond.args, [[null], [null]]);
  });

  it('declines a request from another frame', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    const respond = Sinon.spy();
    const subframe = { url: pageURL } as WebFrameMain;
    picker.displayHandler({ ...picker.request, frame: subframe }, respond);

    assert.deepEqual(respond.args, [[null]]);
  });

  it('declines a request once the main frame shows another page', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    (picker.mainFrame as { url: string }).url = 'file:///session/other.html';

    assert.isNull(picker.requestDisplay());
  });

  it('declines a request without a user gesture', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));

    const respond = Sinon.spy();
    picker.displayHandler({ ...picker.request, userGesture: false }, respond);

    assert.deepEqual(respond.args, [[null]]);
  });

  it('does not ask for sources when screen capture is restricted', async () => {
    const getSources = Sinon.stub().resolves([fakeSource('screen:1')]);
    const picker = setup(getSources, () => 'restricted');

    assert.isEmpty((await picker.listSources()).sources);
    assert.isTrue(getSources.notCalled);
  });
});

describe('screen share on a desktop portal (Wayland)', () => {
  afterEach(() => {
    Sinon.restore();
  });

  it('is detected the way WebRTC decides to capture through the portal', () => {
    const wayland = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
    assert.isTrue(capturesThroughPortal('linux', wayland));
    assert.isFalse(capturesThroughPortal('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }));
    assert.isFalse(capturesThroughPortal('linux', { XDG_SESSION_TYPE: 'wayland' }));
    assert.isFalse(capturesThroughPortal('linux', { WAYLAND_DISPLAY: 'wayland-0' }));
    assert.isFalse(capturesThroughPortal('linux', {}));
    assert.isFalse(capturesThroughPortal('darwin', wayland));
    assert.isFalse(capturesThroughPortal('win32', wayland));
  });

  it('tells the renderer which mode it is in', () => {
    assert.strictEqual(setup(undefined, undefined, true).mode(), 'portal');
    assert.strictEqual(setup(undefined, undefined, false).mode(), 'picker');
  });

  it('grants the source chosen in the portal, asking for it once and without thumbnails', async () => {
    const getSources = Sinon.stub().resolves([fakeSource('screen:7')]);
    const portal = setup(getSources, undefined, true);

    const granted = await portal.requestDisplayLater();

    assert.strictEqual((granted?.video as DesktopCapturerSource | undefined)?.id, 'screen:7');
    assert.isTrue(getSources.calledOnce);
    assert.deepEqual(getSources.firstCall.args[0], {
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    });
  });

  it('declines quietly when the portal returns nothing', async () => {
    const portal = setup(Sinon.stub().resolves([]), undefined, true);

    assert.isNull(await portal.requestDisplayLater());
  });

  it('declines quietly when the portal dialog is cancelled', async () => {
    const portal = setup(
      Sinon.stub().rejects(new Error('Failed to get sources.')),
      undefined,
      true
    );

    assert.isNull(await portal.requestDisplayLater());
  });

  it("does not use Session's picker: no listing, no selection", async () => {
    const getSources = Sinon.stub().resolves([fakeSource('screen:1')]);
    const portal = setup(getSources, undefined, true);

    const listed = await portal.listSources();
    assert.isEmpty(listed.sources);
    assert.isFalse(await portal.pick('screen:1'));
    assert.isTrue(getSources.notCalled, 'listing must not open the portal');
  });

  it('keeps the frame, gesture and audio checks, without opening the portal', async () => {
    const getSources = Sinon.stub().resolves([fakeSource('screen:1')]);
    const portal = setup(getSources, undefined, true);

    assert.isNull(await portal.requestDisplayLater({ userGesture: false }));
    assert.isNull(await portal.requestDisplayLater({ audioRequested: true }));
    assert.isNull(await portal.requestDisplayLater({ frame: null as any }));
    assert.isTrue(getSources.notCalled);
  });

  it('declines a portal choice that arrives after the page went away', async () => {
    let resolveSources: (sources: Array<DesktopCapturerSource>) => void = () => {};
    const portal = setup(
      Sinon.stub().returns(
        new Promise<Array<DesktopCapturerSource>>(resolve => {
          resolveSources = resolve;
        })
      ),
      undefined,
      true
    );
    const response = portal.requestDisplayLater();
    (portal.mainFrame as { url: string }).url = 'file:///session/other.html';
    resolveSources([fakeSource('screen:1')]);

    assert.isNull(await response);
  });
});

describe('screen share refusal reasons', () => {
  afterEach(() => {
    Sinon.restore();
  });

  async function picked(access: () => 'granted' | 'denied' = () => 'granted') {
    const picker = setup(undefined, access);
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));
    return picker;
  }

  it('records nothing for a granted share', async () => {
    const picker = await picked();
    assert.isNotNull(picker.requestDisplay());
    assert.isNull(await picker.refusal());
  });

  it('records a selection that expired', async () => {
    const clock = Sinon.useFakeTimers({ now: 1_000_000 });
    const picker = await picked();
    clock.tick(5001);
    assert.isNull(picker.requestDisplay());
    assert.strictEqual(await picker.refusal(), 'expired');
  });

  it('records a request with no selection, e.g. after a navigation cleared it', async () => {
    const picker = await picked();
    picker.navigate({ isMainFrame: true, isSameDocument: false });
    assert.isNull(picker.requestDisplay());
    assert.strictEqual(await picker.refusal(), 'no-selection');
  });

  it('records a request without a user gesture', async () => {
    const picker = await picked();
    const respond = Sinon.spy();
    picker.displayHandler({ ...picker.request, userGesture: false }, respond);
    assert.deepEqual(respond.args, [[null]]);
    assert.strictEqual(await picker.refusal(), 'no-user-gesture');
  });

  it('records screen recording access revoked after the pick', async () => {
    let access: 'granted' | 'denied' = 'granted';
    const picker = await picked(() => access);
    access = 'denied';
    assert.isNull(picker.requestDisplay());
    assert.strictEqual(await picker.refusal(), 'no-access');
  });

  it('records the calls permission turned off after the pick', async () => {
    const picker = await picked();
    picker.setMediaPermissions(false);
    assert.isNull(picker.requestDisplay());
    picker.setMediaPermissions(true);
    assert.strictEqual(await picker.refusal(), 'no-permission');
  });

  it('records a pick of a source that is no longer on offer', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isFalse(await picker.pick('screen:99'));
    assert.strictEqual(await picker.refusal(), 'no-selection');
  });

  it('records nothing when the picker is closed without a choice', async () => {
    const picker = setup();
    await picker.listSources();
    assert.isFalse(await picker.pick(null));
    assert.isNull(await picker.refusal());
  });

  it('hands a reason out once, and a new request starts without one', async () => {
    const clock = Sinon.useFakeTimers({ now: 1_000_000 });
    const picker = await picked();
    clock.tick(5001);
    picker.requestDisplay();
    assert.strictEqual(await picker.refusal(), 'expired');
    assert.isNull(await picker.refusal());

    clock.tick(5001);
    picker.requestDisplay();
    await picker.listSources();
    assert.isTrue(await picker.pick('screen:1'));
    assert.isNotNull(picker.requestDisplay());
    assert.isNull(await picker.refusal(), 'a stale reason must not outlive the next request');
  });

  it('records nothing when the desktop portal is cancelled or returns nothing', async () => {
    const cancelled = setup(Sinon.stub().rejects(new Error('cancelled')), undefined, true);
    assert.isNull(await cancelled.requestDisplayLater());
    assert.isNull(await cancelled.refusal());

    const empty = setup(Sinon.stub().resolves([]), undefined, true);
    assert.isNull(await empty.requestDisplayLater());
    assert.isNull(await empty.refusal());
  });
});
