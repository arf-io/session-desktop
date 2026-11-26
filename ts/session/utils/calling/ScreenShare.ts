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
