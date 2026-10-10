import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Firestore Security Rules', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rulesContent = fs.readFileSync(rulesPath, 'utf8');

  it('rules file exists and is version 2', () => {
    expect(rulesContent).toContain("rules_version = '2';");
    expect(rulesContent).toContain('service cloud.firestore');
  });

  it('contains helper rejecting anonymous tokens', () => {
    expect(rulesContent).toContain('function isAuthenticated()');
    expect(rulesContent).toContain("request.auth.token.firebase.sign_in_provider != 'anonymous'");
  });

  it('matches user-isolated paths /users/{uid}/{tableName}/{id}', () => {
    expect(rulesContent).toMatch(/match\s+\/users\/\{uid\}\/\{tableName\}\/\{id\}/);
    expect(rulesContent).toContain('allow read: if isAuthenticated() && request.auth.uid == uid;');
  });

  it('allows document deletion without evaluating request.resource.data', () => {
    // Delete operations in Firestore have null request.resource.data
    // So delete must not evaluate request.resource.data.entity_type
    const deleteMatch = rulesContent.match(/allow\s+delete:\s*if\s*([^;]+);/);
    expect(deleteMatch).toBeTruthy();
    expect(deleteMatch![1]).not.toContain('request.resource.data');
    expect(deleteMatch![1]).toContain('isAuthenticated()');
    expect(deleteMatch![1]).toContain('request.auth.uid == uid');
  });

  it('restricts create and update with payload validation', () => {
    expect(rulesContent).toContain('allow create, update:');
    expect(rulesContent).toContain('request.resource.data.entity_type == tableName');
    expect(rulesContent).toContain('request.resource.data.id == id');
  });

  it('enforces deny-by-default for all other paths', () => {
    expect(rulesContent).toMatch(/match\s+\/\{document=\*\*\}/);
    expect(rulesContent).toMatch(/allow\s+read,\s*write:\s*false;/);
  });

  describe('rule logic evaluation engine', () => {
    interface AuthToken {
      firebase?: {
        sign_in_provider?: string;
      };
      [key: string]: unknown;
    }

    interface RequestAuth {
      uid: string;
      token: AuthToken;
    }

    interface SecurityContext {
      auth: RequestAuth | null;
      resource?: { data: Record<string, unknown> } | null;
      resourceData?: Record<string, unknown> | null;
    }

    function isAuthenticated(auth: RequestAuth | null): boolean {
      return (
        auth !== null &&
        auth.token?.firebase?.sign_in_provider !== undefined &&
        auth.token.firebase.sign_in_provider !== 'anonymous'
      );
    }

    function evaluateUserPath(
      pathParams: { uid: string; tableName: string; id: string },
      op: 'read' | 'delete' | 'create' | 'update',
      context: SecurityContext
    ): boolean {
      const { uid, tableName, id } = pathParams;
      if (!isAuthenticated(context.auth)) return false;
      if (context.auth!.uid !== uid) return false;

      if (op === 'read' || op === 'delete') {
        return true;
      }

      const resData = context.resourceData;
      if (!resData) return false;
      const ownerOk = resData.owner_id === null || resData.owner_id === undefined || resData.owner_id === uid;
      const typeOk = resData.entity_type === tableName;
      const idOk = resData.id === id;
      return ownerOk && typeOk && idOk;
    }

    function evaluateCatchAllPath(_path: string, _op: 'read' | 'write'): boolean {
      return false; // Deny by default
    }

    it('rejects unauthenticated read requests', () => {
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'read',
        { auth: null }
      );
      expect(allowed).toBe(false);
    });

    it('rejects anonymous authenticated users', () => {
      const anonAuth: RequestAuth = {
        uid: 'user-123',
        token: { firebase: { sign_in_provider: 'anonymous' } }
      };
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'read',
        { auth: anonAuth }
      );
      expect(allowed).toBe(false);
    });

    it('rejects mismatched UIDs', () => {
      const googleAuth: RequestAuth = {
        uid: 'attacker-456',
        token: { firebase: { sign_in_provider: 'google.com' } }
      };
      const allowed = evaluateUserPath(
        { uid: 'victim-123', tableName: 'accounts', id: 'acc-1' },
        'read',
        { auth: googleAuth }
      );
      expect(allowed).toBe(false);
    });

    it('allows read when UID matches and provider is non-anonymous', () => {
      const validAuth: RequestAuth = {
        uid: 'user-123',
        token: { firebase: { sign_in_provider: 'google.com' } }
      };
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'read',
        { auth: validAuth }
      );
      expect(allowed).toBe(true);
    });

    it('allows delete when UID matches without evaluating resourceData', () => {
      const validAuth: RequestAuth = {
        uid: 'user-123',
        token: { firebase: { sign_in_provider: 'google.com' } }
      };
      // On delete, resourceData is null
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'delete',
        { auth: validAuth, resourceData: null }
      );
      expect(allowed).toBe(true);
    });

    it('allows create and update with valid matching document data', () => {
      const validAuth: RequestAuth = {
        uid: 'user-123',
        token: { firebase: { sign_in_provider: 'password' } }
      };
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'create',
        {
          auth: validAuth,
          resourceData: {
            owner_id: 'user-123',
            entity_type: 'accounts',
            id: 'acc-1',
            payload: { name: 'Main Account' }
          }
        }
      );
      expect(allowed).toBe(true);
    });

    it('rejects create if entity_type does not match path tableName', () => {
      const validAuth: RequestAuth = {
        uid: 'user-123',
        token: { firebase: { sign_in_provider: 'google.com' } }
      };
      const allowed = evaluateUserPath(
        { uid: 'user-123', tableName: 'accounts', id: 'acc-1' },
        'create',
        {
          auth: validAuth,
          resourceData: {
            owner_id: 'user-123',
            entity_type: 'transactions', // mismatch!
            id: 'acc-1'
          }
        }
      );
      expect(allowed).toBe(false);
    });

    it('denies access by default to unmapped collection paths', () => {
      expect(evaluateCatchAllPath('/admin/config', 'read')).toBe(false);
      expect(evaluateCatchAllPath('/admin/config', 'write')).toBe(false);
      expect(evaluateCatchAllPath('/public_data', 'read')).toBe(false);
    });
  });
});
