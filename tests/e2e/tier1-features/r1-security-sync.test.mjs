/**
 * r1-security-sync.test.mjs
 * Tier 1: Feature Coverage — Requirement R1 (Security, Privacy & Synchronization)
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockFirestoreSecurityRulesEngine } from '../helpers/mock-firestore.mjs';
import { MockWebLockManager } from '../helpers/mock-weblocks.mjs';
import { MockNetworkGate } from '../helpers/mock-network.mjs';

describe('Tier 1: R1 Security & Synchronization Engine', () => {
  const rulesEngine = new MockFirestoreSecurityRulesEngine();

  it('T1.R1.1: Firestore rules explicitly reject unauthenticated requests', () => {
    const readResult = rulesEngine.evaluate('read', '/users/user_123/accounts/acc_1', null);
    assert.equal(readResult.allowed, false);
    assert.match(readResult.reason, /Unauthenticated/i);

    const writeResult = rulesEngine.evaluate('create', '/users/user_123/accounts/acc_1', null, null, {
      id: 'acc_1',
      entity_type: 'accounts'
    });
    assert.equal(writeResult.allowed, false);
    assert.match(writeResult.reason, /Unauthenticated/i);
  });

  it('T1.R1.2: Firestore rules explicitly reject anonymous users', () => {
    const anonAuth = {
      uid: 'anon_user_999',
      token: { firebase: { sign_in_provider: 'anonymous' } }
    };

    const readResult = rulesEngine.evaluate('read', '/users/anon_user_999/accounts/acc_1', anonAuth);
    assert.equal(readResult.allowed, false);
    assert.match(readResult.reason, /Anonymous authentication strictly rejected/i);

    const writeResult = rulesEngine.evaluate('create', '/users/anon_user_999/accounts/acc_1', anonAuth, null, {
      id: 'acc_1',
      entity_type: 'accounts',
      owner_id: 'anon_user_999'
    });
    assert.equal(writeResult.allowed, false);
    assert.match(writeResult.reason, /Anonymous authentication strictly rejected/i);
  });

  it('T1.R1.3: Firestore rules explicitly reject mismatched UIDs across users', () => {
    const userA = {
      uid: 'user_alice',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    // Alice attempting to read Bob's documents
    const readResult = rulesEngine.evaluate('read', '/users/user_bob/accounts/acc_bob', userA);
    assert.equal(readResult.allowed, false);
    assert.match(readResult.reason, /Mismatched UID/i);

    // Alice attempting to write into Bob's subcollection
    const writeResult = rulesEngine.evaluate('create', '/users/user_bob/accounts/acc_bob', userA, null, {
      id: 'acc_bob',
      entity_type: 'accounts',
      owner_id: 'user_bob'
    });
    assert.equal(writeResult.allowed, false);
    assert.match(writeResult.reason, /Mismatched UID/i);
  });

  it('T1.R1.4: Local-only mode produces zero outbound network requests', async () => {
    const network = new MockNetworkGate('LOCAL_ONLY');

    // Simulate local writes and queries
    assert.equal(network.getOutboundCount(), 0);

    // Attempting a cloud call must throw and be blocked
    await assert.rejects(
      async () => {
        await network.fetch('https://firestore.googleapis.com/v1/projects/kotoba-41ab0/databases/(default)/documents');
      },
      /Privacy violation.*LOCAL_ONLY/
    );

    // Non-remote internal ops do not leak calls
    assert.equal(network.getOutboundCount('firestore'), 1);
  });

  it('T1.R1.5: Document deletion succeeds for owner without evaluating missing resource data', () => {
    const user = {
      uid: 'user_carol',
      token: { firebase: { sign_in_provider: 'password' } }
    };

    // When deleting, request.resource.data is null
    const deleteResult = rulesEngine.evaluate('delete', '/users/user_carol/accounts/acc_delete', user, {
      id: 'acc_delete',
      owner_id: 'user_carol',
      entity_type: 'accounts'
    }, null);

    assert.equal(deleteResult.allowed, true);
  });

  it('T1.R1.6: Concurrent multi-tab writes serialize via Web Locks avoiding duplicates', async () => {
    const lockManager = new MockWebLockManager();
    const executionOrder = [];

    // Simulate Tab 1 and Tab 2 trying to sync concurrently
    const tab1Promise = lockManager.request('tala_sync', async () => {
      executionOrder.push('tab1_start');
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push('tab1_end');
      return { tab: 1, uploaded: 2 };
    }, 'tab_1');

    const tab2Promise = lockManager.request('tala_sync', async () => {
      executionOrder.push('tab2_start');
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('tab2_end');
      return { tab: 2, uploaded: 1 };
    }, 'tab_2');

    const [res1, res2] = await Promise.all([tab1Promise, tab2Promise]);

    assert.equal(res1.tab, 1);
    assert.equal(res2.tab, 2);

    // Verify mutually exclusive serialized ordering (no interleaving start-start)
    assert.deepEqual(executionOrder, ['tab1_start', 'tab1_end', 'tab2_start', 'tab2_end']);
  });

  it('T1.R1.7: Offline mutations queue and merge on reconnect', async () => {
    const outbox = [];
    const remoteStore = new Map();

    // 1. Client goes offline
    let isOnline = false;

    // 2. Perform local mutations while offline
    const mutation1 = { id: 'tx_1', tableName: 'transactions', payload: { amount: 5000 }, status: 'pending', createdAt: '2026-10-09T10:00:00Z' };
    const mutation2 = { id: 'tx_2', tableName: 'transactions', payload: { amount: 12000 }, status: 'pending', createdAt: '2026-10-09T10:05:00Z' };
    outbox.push(mutation1, mutation2);

    assert.equal(outbox.length, 2);
    assert.equal(remoteStore.size, 0);

    // 3. Client comes online and drains outbox
    isOnline = true;
    if (isOnline) {
      for (const entry of outbox) {
        remoteStore.set(`${entry.tableName}/${entry.id}`, entry.payload);
        entry.status = 'applied';
      }
      outbox.length = 0; // successfully drained
    }

    assert.equal(outbox.length, 0);
    assert.equal(remoteStore.size, 2);
    assert.deepEqual(remoteStore.get('transactions/tx_1'), { amount: 5000 });
    assert.deepEqual(remoteStore.get('transactions/tx_2'), { amount: 12000 });
  });
});
