import { assert } from 'chai';
import Sinon from 'sinon';

import type { UserConfig } from '../../../../node/config/user_config';
import { createPermissionHandler } from '../../../../node/permissions';

function decide(permission: string, mediaPermissions: boolean) {
  const handler = createPermissionHandler({
    get: (key: string) => (key === 'mediaPermissions' ? mediaPermissions : undefined),
  } as unknown as UserConfig);
  const callback = Sinon.spy();
  handler(null, permission, callback);
  assert.isTrue(callback.calledOnce);
  return callback.firstCall.args[0];
}

describe('permissions handler', () => {
  beforeEach(() => {
    Sinon.stub(console, 'log');
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('grants display-capture only when media permissions are on', () => {
    assert.isFalse(decide('display-capture', false));
    assert.isTrue(decide('display-capture', true));
  });

  it('keeps media on the same setting', () => {
    assert.isFalse(decide('media', false));
    assert.isTrue(decide('media', true));
  });

  it('does not let media permissions grant anything else', () => {
    assert.isFalse(decide('geolocation', true));
    assert.isFalse(decide('openExternal', true));
  });
});
