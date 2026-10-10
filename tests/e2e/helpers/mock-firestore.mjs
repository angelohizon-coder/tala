/**
 * mock-firestore.mjs
 * Evaluates Firestore Security Rules in-memory according to the project specifications.
 */

export class MockFirestoreSecurityRulesEngine {
  constructor() {
    this.storage = new Map(); // path -> document
  }

  /**
   * Evaluates a security rule request.
   * @param {'read' | 'create' | 'update' | 'delete'} operation
   * @param {string} path - Document path e.g. '/users/uid123/accounts/acc1'
   * @param {{ uid: string | null; token?: { firebase?: { sign_in_provider?: string } } } | null} auth
   * @param {Record<string, any>} [resourceData] - Existing document data
   * @param {Record<string, any>} [requestResourceData] - Incoming document data
   * @returns {{ allowed: boolean; reason?: string }}
   */
  evaluate(operation, path, auth, resourceData = null, requestResourceData = null) {
    // 1. Authentication check
    if (!auth || !auth.uid) {
      return { allowed: false, reason: 'Unauthenticated requests denied' };
    }

    // 2. Reject Anonymous Authentication
    if (auth.token?.firebase?.sign_in_provider === 'anonymous') {
      return { allowed: false, reason: 'Anonymous authentication strictly rejected' };
    }

    // 3. Match /users/{uid}/{tableName}/{id}
    const userMatch = path.match(/^\/users\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (userMatch) {
      const [, targetUid, tableName, docId] = userMatch;

      // UID isolation check
      if (auth.uid !== targetUid) {
        return { allowed: false, reason: 'Mismatched UID access rejected' };
      }

      if (operation === 'read') {
        return { allowed: true };
      }

      if (operation === 'delete') {
        // Deletion must NOT evaluate requestResourceData (as request.resource.data is null during delete)
        return { allowed: true };
      }

      if (operation === 'create' || operation === 'update') {
        if (!requestResourceData) {
          return { allowed: false, reason: 'Missing resource data for write' };
        }
        if (requestResourceData.owner_id && requestResourceData.owner_id !== auth.uid) {
          return { allowed: false, reason: 'owner_id must match authenticated UID' };
        }
        if (requestResourceData.entity_type && requestResourceData.entity_type !== tableName) {
          return { allowed: false, reason: 'entity_type must match subcollection tableName' };
        }
        if (requestResourceData.id && requestResourceData.id !== docId) {
          return { allowed: false, reason: 'id must match document ID' };
        }
        return { allowed: true };
      }
    }

    // 4. Match /finance_entities/{document} (Legacy support for migration)
    const legacyMatch = path.match(/^\/finance_entities\/([^/]+)$/);
    if (legacyMatch) {
      if (operation === 'read') {
        if (resourceData && resourceData.owner_id === auth.uid) {
          return { allowed: true };
        }
        return { allowed: false, reason: 'Legacy read denied: owner_id mismatch' };
      }
      if (operation === 'create') {
        if (requestResourceData && requestResourceData.owner_id === auth.uid) {
          return { allowed: true };
        }
        return { allowed: false, reason: 'Legacy create denied: owner_id mismatch' };
      }
      if (operation === 'update' || operation === 'delete') {
        if (resourceData && resourceData.owner_id === auth.uid) {
          return { allowed: true };
        }
        return { allowed: false, reason: 'Legacy write denied: owner_id mismatch' };
      }
    }

    // 5. Fail-Closed Default (match /{document=**})
    return { allowed: false, reason: 'Deny by default: no matching rule allowed access' };
  }
}
