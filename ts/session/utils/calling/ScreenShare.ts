import { tr } from '../../../localization/localeTools';
import { isMacOS } from '../../../OS';
import { takeScreenShareRefusal, type ScreenShareRefusal } from '../../../util/screenShare';
import { pushToastError } from '../Toast';

/**
 * Screen-sharing decisions used by CallManager, kept out of it so they can be unit tested
 * without a real RTCPeerConnection and so upstream's CallManager changes as little as possible.
 */

/**
 * The data-channel status message. Unmodified Session clients read `video` and ignore unknown
 * keys, so these two keys (plus upstream's separate hangup message) are the whole wire format.
 */
export type VideoStatus = { video: boolean; screenShare: boolean };

export function videoStatusPayload({
  cameraOn,
  isScreenSharing,
}: {
  cameraOn: boolean;
  isScreenSharing: boolean;
}): string {
  // a screen share is video from the remote peer's point of view, even with no camera selected
  const status: VideoStatus = { video: isScreenSharing || cameraOn, screenShare: isScreenSharing };
  return JSON.stringify(status);
}

/**
 * Whether the peer is sharing their screen after receiving `parsed` over the data channel.
 * `screenShare` is only sent by clients which support sharing, so a status without it means
 * "not sharing". A hangup message is not a status update and leaves the value alone.
 */
export function remoteScreenShareAfter(parsed: unknown, previous: boolean): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return previous;
  }
  const message = parsed as Record<string, unknown>;
  if (message.hangup !== undefined) {
    return previous;
  }
  return message.screenShare === true;
}

/**
 * The camera the camera button reflects. A share holds the call's only video sender, so while it
 * runs no camera is live; the button then shows the camera that comes back when the share ends.
 */
export function cameraShownOnButton({
  isScreenSharing,
  liveCameraId,
  cameraAfterShare,
}: {
  isScreenSharing: boolean;
  liveCameraId: string;
  cameraAfterShare: string;
}): string {
  return isScreenSharing ? cameraAfterShare : liveCameraId;
}

/**
 * A camera chosen during a share (the camera toggle or the camera menu) does not end the share:
 * it only changes the camera that comes back when the share ends. An unknown camera is ignored.
 */
export function cameraAfterShareOnRequest({
  requestedId,
  cameraAfterShare,
  cameraIds,
  offId,
}: {
  requestedId: string;
  cameraAfterShare: string;
  cameraIds: Array<string>;
  offId: string;
}): string {
  return requestedId === offId || cameraIds.includes(requestedId) ? requestedId : cameraAfterShare;
}

/**
 * What to tell the user when the main process declined a share; null to stay quiet. No reason
 * means nothing went wrong from Session's side (a cancelled desktop portal), so nothing is said.
 */
export function screenShareRefusalMessage(
  reason: ScreenShareRefusal | null,
  isMac: boolean
): string | null {
  switch (reason) {
    case null:
      return null;
    case 'no-permission':
      return tr('callsPermissionsRequiredDescription');
    case 'no-access':
      return isMac ? tr('callsScreenRecordingPermissionDescription') : tr('permissionsRequired');
    case 'not-allowed':
    case 'no-user-gesture':
    case 'no-selection':
    case 'expired':
    default:
      return tr('errorGeneric');
  }
}

/** Called when a share was declined (getDisplayMedia rejected, or the pick was refused). */
export async function explainScreenShareRefusal({
  take = takeScreenShareRefusal,
  toast = pushToastError,
  isMac = isMacOS(),
}: {
  take?: () => Promise<ScreenShareRefusal | null>;
  toast?: (id: string, message: string) => void;
  isMac?: boolean;
} = {}) {
  let reason: ScreenShareRefusal | null = null;
  try {
    reason = await take();
  } catch (e) {
    window.log?.warn('screen share: could not read why the share was declined:', e?.message);
  }
  const message = screenShareRefusalMessage(reason, isMac);
  if (message) {
    toast('startScreenShare', message);
  }
}

/**
 * The most we send of a shared screen. Unmodified peers (often phones) get the share as ordinary
 * camera video, so a 5K display is scaled down to fit 1920x1080, keeping its aspect ratio, and at
 * most 30 frames a second.
 */
export const screenShareConstraints: MediaTrackConstraints = {
  width: { max: 1920 },
  height: { max: 1080 },
  frameRate: { max: 30 },
};

export async function prepareScreenShareTrack(track: MediaStreamTrack) {
  // Keeps text legible on a weak link: WebRTC then drops frame rate before resolution.
  // eslint-disable-next-line no-param-reassign
  track.contentHint = 'detail';
  try {
    await track.applyConstraints(screenShareConstraints);
  } catch (e) {
    // the share still works uncapped; better than no share at all
    window.log?.warn('screen share: could not cap the shared video:', e?.message);
  }
}
