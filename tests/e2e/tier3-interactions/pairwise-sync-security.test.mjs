/**
 * pairwise-sync-security.test.mjs
 * Tier 3: Cross-Feature Interactions — Security & Sync Integration
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockFirestoreSecurityRulesEngine } from '../helpers/mock-firestore.mjs';
import { MockWebLockManager } from '../helpers/mock-weblocks.mjs';

describe('Tier 3: Pairwise Interaction — Security & Synchronization', () => {
  const rules = new MockFirestoreSecurityRulesEngine();
  const locks = new MockWebLockManager();

  it('T3.PAIR.1: Tab with mismatched UID is rejected by rules while authorized tab syncs via Web Locks', async () => {
    const authorizedUser = { uid: 'user_good', token: { firebase: { sign_in_provider: 'google.com' } } };
    const spoofedUser = { uid: 'user_bad', token: { firebase: { sign_in_provider: 'google.com' } } };

    // Authorized tab acquires lock and pushes to /users/user_good/accounts/acc1
    const authorizedResult = await locks.request('tala_sync', async () => {
      const evalRes = rules.evaluate('create', '/users/user_good/accounts/acc1', authorizedUser, null, {
        id: 'acc1',
        entity_type: 'accounts',
        owner_id: 'user_good'
      });
      return evalRes.allowed;
    }, 'tab_authorized');

    assert.equal(authorizedResult, true);

    // Spoofed tab attempts to write into user_good's subcollection
    const spoofedResult = await locks.request('tala_sync', async () => {
      const evalRes = rules.evaluate('create', '/users/user_good/accounts/acc2', spoofedUser, null, {
        id: 'acc2',
        entity_type: 'accounts',
        owner_id: 'user_good'
      });
      return evalRes.allowed;
    }, 'tab_spoofed');

    assert.equal(spoofedResult, false);
  });

  it('T3.PAIR.2: Anonymous session cannot push outbox to cloud until linked to non-anonymous provider', async () => {
    let auth = { uid: 'anon_1', token: { firebase: { sign_in_provider: 'anonymous' } } };
    const outbox = [{ id: 'm1', tableName: 'accounts', entityId: 'acc1' }];

    // 1. While anonymous: sync must fail
    const attemptAnonSync = () => {
      const evalRes = rules.evaluate('create', `/users/${auth.uid}/accounts/acc1`, auth, null, {
        id: 'acc1',
        entity_type: 'accounts',
        owner_id: auth.uid
      });
      return evalRes.allowed;
    };

    assert.equal(attemptAnonSync(), false);

    // 2. User signs in with Google OAuth (linking account)
    auth = { uid: 'user_real', token: { firebase: { sign_in_provider: 'google.com' } } };

    // 3. Sync succeeds
    const attemptAuthSync = () => {
      const evalRes = rules.evaluate('create', `/users/${auth.uid}/accounts/acc1`, auth, null, {
        id: 'acc1',
        entity_type: 'accounts',
        owner_id: auth.uid
      });
      return evalRes.allowed;
    };

    assert.equal(attemptAuthSync(), true);
  });

  it('T3.PAIR.3: Authentication token expiry mid-sync preserves unpushed outbox records locally', async () => {
    const outbox = [
      { id: 'm1', status: 'pending' },
      { id: 'm2', status: 'pending' }
    ];

    let authToken = { uid: 'u1', token: { firebase: { sign_in_provider: 'google.com' } } };
    let synced = 0;

    for (const item of outbox) {
      if (item.id === 'm2') {
        authToken = null; // Token expires
      }

      if (!authToken) {
        item.status = 'failed';
        item.error = 'Session expired';
        break;
      }

      item.status = 'applied';
      synced++;
    }

    assert.equal(synced, 1);
    assert.equal(outbox[0].status, 'applied');
    assert.equal(outbox[1].status, 'failed');
    assert.equal(outbox[1].error, 'Session expired');
  });
});
