import { assert } from 'chai';
import Sinon from 'sinon';

import {
  cameraAfterShareOnRequest,
  cameraShownOnButton,
  explainScreenShareRefusal,
  prepareScreenShareTrack,
  remoteScreenShareAfter,
  screenShareRefusalMessage,
  videoStatusPayload,
} from '../../../../session/utils/calling/ScreenShare';
import { TestUtils } from '../../../test-utils';
import { callButtonBackground } from '../../../../components/calling/CallButtons';

/**
 * These are the decisions CallManager sends and applies over the data channel. The data channel
 * itself needs a real RTCPeerConnection and is not exercised here.
 */
describe('screen share data-channel status', () => {
  describe('outgoing payload', () => {
    it('only ever has the keys video and screenShare', () => {
      for (const cameraOn of [false, true]) {
        for (const isScreenSharing of [false, true]) {
          const parsed = JSON.parse(videoStatusPayload({ cameraOn, isScreenSharing }));
          assert.deepEqual(Object.keys(parsed).sort(), ['screenShare', 'video']);
        }
      }
    });

    it('reports video while sharing with no camera', () => {
      assert.deepEqual(JSON.parse(videoStatusPayload({ cameraOn: false, isScreenSharing: true })), {
        video: true,
        screenShare: true,
      });
    });

    it('matches what an unmodified client sends when not sharing', () => {
      assert.deepEqual(
        JSON.parse(videoStatusPayload({ cameraOn: false, isScreenSharing: false })),
        { video: false, screenShare: false }
      );
      assert.deepEqual(JSON.parse(videoStatusPayload({ cameraOn: true, isScreenSharing: false })), {
        video: true,
        screenShare: false,
      });
    });
  });

  describe('incoming status', () => {
    it('treats a status from an unmodified client as not sharing', () => {
      assert.isFalse(remoteScreenShareAfter({ video: true }, true));
      assert.isFalse(remoteScreenShareAfter({ video: true }, false));
    });

    it('reads screenShare: true as sharing', () => {
      assert.isTrue(remoteScreenShareAfter({ video: true, screenShare: true }, false));
    });

    it('only accepts a literal true', () => {
      assert.isFalse(remoteScreenShareAfter({ video: true, screenShare: 'true' }, false));
      assert.isFalse(remoteScreenShareAfter({ video: true, screenShare: 1 }, false));
    });

    it('leaves the state alone on a hangup message', () => {
      assert.isTrue(remoteScreenShareAfter({ hangup: true }, true));
      assert.isFalse(remoteScreenShareAfter({ hangup: true }, false));
    });

    it('leaves the state alone on something that is not an object', () => {
      assert.isTrue(remoteScreenShareAfter(null, true));
      assert.isTrue(remoteScreenShareAfter(42, true));
    });
  });
});

describe('camera button during a screen share', () => {
  const off = 'off';

  it('shows the camera that comes back after the share, not the share itself', () => {
    // sharing with the camera off: the button says "off", where it used to say "on"
    assert.strictEqual(
      cameraShownOnButton({ isScreenSharing: true, liveCameraId: off, cameraAfterShare: off }),
      off
    );
    assert.strictEqual(
      cameraShownOnButton({ isScreenSharing: true, liveCameraId: off, cameraAfterShare: 'cam-1' }),
      'cam-1'
    );
  });

  it('shows the live camera when not sharing', () => {
    assert.strictEqual(
      cameraShownOnButton({ isScreenSharing: false, liveCameraId: 'cam-2', cameraAfterShare: off }),
      'cam-2'
    );
  });

  it('turns a camera toggle during the share into the camera restored after it', () => {
    const cameraIds = ['cam-1', 'cam-2'];
    assert.strictEqual(
      cameraAfterShareOnRequest({
        requestedId: 'cam-1',
        cameraAfterShare: off,
        cameraIds,
        offId: off,
      }),
      'cam-1'
    );
    assert.strictEqual(
      cameraAfterShareOnRequest({
        requestedId: off,
        cameraAfterShare: 'cam-1',
        cameraIds,
        offId: off,
      }),
      off
    );
  });

  it('ignores a camera that is not connected', () => {
    assert.strictEqual(
      cameraAfterShareOnRequest({
        requestedId: 'gone',
        cameraAfterShare: 'cam-1',
        cameraIds: ['cam-1'],
        offId: off,
      }),
      'cam-1'
    );
  });
});

describe('screen share refusals in the renderer', () => {
  beforeEach(() => {
    TestUtils.stubWindowLog();
    TestUtils.stubI18n();
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('stays quiet when there is no reason: the user cancelled', () => {
    assert.isNull(screenShareRefusalMessage(null, true));
    assert.isNull(screenShareRefusalMessage(null, false));
  });

  it('has a message for every reason main can record', () => {
    for (const reason of [
      'no-permission',
      'not-allowed',
      'no-user-gesture',
      'no-selection',
      'expired',
      'no-access',
    ] as const) {
      assert.isNotEmpty(screenShareRefusalMessage(reason, false), reason);
    }
  });

  it('points macOS users at Screen Recording access', () => {
    assert.include(screenShareRefusalMessage('no-access', true), 'Screen Recording');
    assert.notInclude(screenShareRefusalMessage('no-access', false), 'Screen Recording');
  });

  it('toasts a refusal the user did not cause', async () => {
    const toast = Sinon.spy();
    await explainScreenShareRefusal({ take: async () => 'expired', toast, isMac: false });
    assert.isTrue(toast.calledOnce);
    assert.strictEqual(toast.firstCall.args[0], 'startScreenShare');
  });

  it('does not toast a cancel', async () => {
    const toast = Sinon.spy();
    await explainScreenShareRefusal({ take: async () => null, toast, isMac: false });
    assert.isTrue(toast.notCalled);
  });

  it('does not toast when the reason cannot be read', async () => {
    const toast = Sinon.spy();
    await explainScreenShareRefusal({
      take: async () => {
        throw new Error('no ipc');
      },
      toast,
      isMac: false,
    });
    assert.isTrue(toast.notCalled);
  });
});

describe('outgoing screen share cap', () => {
  beforeEach(() => {
    TestUtils.stubWindowLog();
  });

  afterEach(() => {
    Sinon.restore();
  });

  function stubTrack(applyConstraints: Sinon.SinonStub) {
    return { contentHint: '', applyConstraints } as unknown as MediaStreamTrack;
  }

  it('caps the share at 1920x1080 and 30 fps, with only upper bounds so the aspect is kept', async () => {
    const applyConstraints = Sinon.stub().resolves();
    const track = stubTrack(applyConstraints);

    await prepareScreenShareTrack(track);

    assert.isTrue(applyConstraints.calledOnce);
    assert.deepEqual(applyConstraints.firstCall.args[0], {
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { max: 30 },
    });
    assert.strictEqual(track.contentHint, 'detail');
  });

  it('keeps sharing when the cap cannot be applied', async () => {
    const track = stubTrack(Sinon.stub().rejects(new Error('OverconstrainedError')));

    await prepareScreenShareTrack(track);

    assert.strictEqual(track.contentHint, 'detail');
  });
});

describe('call buttons in fullscreen', () => {
  it('have a visible background, as upstream camera and microphone buttons do', () => {
    // the fullscreen icon is black on a black call view: a transparent button is invisible
    assert.strictEqual(callButtonBackground(true), 'var(--call-buttons-action-background-color)');
  });

  it('keep the regular background outside fullscreen', () => {
    assert.strictEqual(callButtonBackground(false), 'var(--call-buttons-background-color)');
  });
});
