/* eslint-disable import/no-extraneous-dependencies */
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect } from 'chai';
import Sinon from 'sinon';

import { ScreenShareButton } from '../../components/calling/CallButtons';
import { CallManager } from '../../session/utils';
import type {
  CallManagerListener,
  CallManagerOptionsType,
} from '../../session/utils/calling/CallManager';
import * as screenShareIpc from '../../util/screenShare';
import { TestUtils } from '../test-utils';
import { findByDataTestId, renderComponent } from './renderComponent';

describe('ScreenShareButton', () => {
  let listeners: Map<string, CallManagerListener>;
  let startScreenShare: Sinon.SinonStub;
  let getSources: Sinon.SinonStub;

  beforeEach(() => {
    TestUtils.stubWindowLog();
    TestUtils.stubI18n();
    listeners = new Map();
    Sinon.stub(CallManager, 'addVideoEventsListener').callsFake((id, listener) => {
      listeners.set(id, listener);
    });
    Sinon.stub(CallManager, 'removeVideoEventsListener').callsFake(id => {
      listeners.delete(id);
    });
    startScreenShare = Sinon.stub(CallManager, 'startScreenShare').resolves();
    getSources = Sinon.stub(screenShareIpc, 'getScreenShareSources').resolves({
      screenAccess: 'granted',
      sources: [],
    });
    Sinon.stub(screenShareIpc, 'setScreenShareSource').resolves(false);
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal() {
        this.setAttribute('open', '');
      };
    }
  });

  afterEach(() => {
    Sinon.restore();
  });

  const reportPending = (isScreenSharePending: boolean) => {
    act(() => {
      listeners.forEach(listener =>
        listener?.({ isScreenSharePending } as unknown as CallManagerOptionsType)
      );
    });
  };

  async function renderButton(mode: screenShareIpc.ScreenShareMode) {
    Sinon.stub(screenShareIpc, 'getScreenShareMode').resolves(mode);
    const result = renderComponent(
      <ScreenShareButton isFullScreen={false} isScreenSharing={false} />
    );
    const button = findByDataTestId(result, 'toggle-screen-share') as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).to.equal(false));
    return { result, button };
  }

  it("starts the share directly on a desktop portal, without Session's picker", async () => {
    const { result, button } = await renderButton('portal');

    fireEvent.click(button);

    expect(startScreenShare.calledOnceWithExactly(null)).to.equal(true);
    expect(result.queryByTestId('screen-share-picker')).to.equal(null);
    expect(getSources.notCalled).to.equal(true);
    result.unmount();
  });

  it("opens Session's picker everywhere else", async () => {
    const { result, button } = await renderButton('picker');

    fireEvent.click(button);

    expect(result.queryByTestId('screen-share-picker')).to.not.equal(null);
    expect(startScreenShare.notCalled).to.equal(true);
    await waitFor(() => expect(getSources.calledOnce).to.equal(true));
    result.unmount();
  });

  it('is disabled while a share is pending, and enabled again after', async () => {
    const { result, button } = await renderButton('picker');

    reportPending(true);
    expect(button.disabled).to.equal(true);
    fireEvent.click(button);
    expect(result.queryByTestId('screen-share-picker')).to.equal(null);

    reportPending(false);
    expect(button.disabled).to.equal(false);
    result.unmount();
  });

  it('stops listening when unmounted', async () => {
    const { result } = await renderButton('picker');
    expect(listeners.size).to.equal(1);

    result.unmount();

    expect(listeners.size).to.equal(0);
  });
});
