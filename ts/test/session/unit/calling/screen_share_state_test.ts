import { assert } from 'chai';

import {
  cameraAfterShareOnRequest,
  cameraShownOnButton,
  remoteScreenShareAfter,
  videoStatusPayload,
} from '../../../../session/utils/calling/ScreenShare';

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
