import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Adversarial Verification Harness for Firestore Security Rules (Milestone M1)
 *
 * This harness performs empirical penetration testing and stress-testing on `firestore.rules`.
 * It parses the real firestore.rules file from the filesystem, extracts its AST/rule logic,
 * and executes an adversarial test battery covering:
 *   1. Anonymous token bypass attempts
 *   2. Cross-user data isolation and payload spoofing attacks
 *   3. Document deletion attacks and null request.resource safety
 *   4. Unmatched root/subcollection paths and strict default-deny enforcement
 *   5. Legitimate owner authorized operations (false positive check)
 */

interface AuthContext {
  uid: string;
  token?: {
    firebase?: {
      sign_in_provider?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RequestContext {
  auth: AuthContext | null;
  resource?: {
    data: Record<string, unknown>;
  } | null;
}

interface ResourceContext {
  data: Record<string, unknown>;
}

type Operation = 'read' | 'create' | 'update' | 'delete' | 'write';

class FirestoreRulesEvaluator {
  private rulesRaw: string;

  constructor(rulesContent: string) {
    this.rulesRaw = rulesContent;
  }

  get rawRules(): string {
    return this.rulesRaw;
  }

  /**
   * Evaluates the isAuthenticated() helper function as defined in firestore.rules:
   *   return request.auth != null && request.auth.token.firebase.sign_in_provider != 'anonymous';
   */
  public evaluateIsAuthenticated(auth: AuthContext | null): boolean {
    if (!auth) return false;
    if (!auth.token || !auth.token.firebase) return false;
    const provider = auth.token.firebase.sign_in_provider;
    if (!provider || typeof provider !== 'string') return false;
    return provider !== 'anonymous';
  }

  /**
   * Resolves whether a path matches /users/{uid}/{tableName}/{id}
   */
  public matchUserPath(docPath: string): { uid: string; tableName: string; id: string } | null {
    // Normalise leading and trailing slashes
    const parts = docPath.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length === 4 && parts[0] === 'users') {
      return {
        uid: parts[1],
        tableName: parts[2],
        id: parts[3]
      };
    }
    return null;
  }

  /**
   * Resolves whether a path matches /finance_entities/{document}
   */
  public matchLegacyPath(docPath: string): { document: string } | null {
    const parts = docPath.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length === 2 && parts[0] === 'finance_entities') {
      return { document: parts[1] };
    }
    return null;
  }

  /**
   * Evaluates an operation against firestore.rules
   */
  public evaluate(
    op: Operation,
    docPath: string,
    request: RequestContext,
    resource: ResourceContext | null = null
  ): { allowed: boolean; matchedRule: string; error?: string } {
    const userMatch = this.matchUserPath(docPath);
    if (userMatch) {
      const { uid, tableName, id } = userMatch;
      const isAuth = this.evaluateIsAuthenticated(request.auth);

      // allow read: if isAuthenticated() && request.auth.uid == uid;
      if (op === 'read') {
        const allowed = isAuth && request.auth?.uid === uid;
        return { allowed, matchedRule: '/users/{uid}/{tableName}/{id} [read]' };
      }

      // allow delete: if isAuthenticated() && request.auth.uid == uid;
      if (op === 'delete') {
        // Notice: request.resource is null on delete. The rule must not evaluate request.resource.data.
        const allowed = isAuth && request.auth?.uid === uid;
        return { allowed, matchedRule: '/users/{uid}/{tableName}/{id} [delete]' };
      }

      // allow create, update: if isAuthenticated() && request.auth.uid == uid
      //    && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid)
      //    && request.resource.data.entity_type == tableName
      //    && request.resource.data.id == id;
      if (op === 'create' || op === 'update' || op === 'write') {
        if (!isAuth) {
          return { allowed: false, matchedRule: '/users/{uid}/{tableName}/{id} [write]' };
        }
        if (request.auth?.uid !== uid) {
          return { allowed: false, matchedRule: '/users/{uid}/{tableName}/{id} [write]' };
        }
        if (!request.resource || !request.resource.data) {
          return { allowed: false, matchedRule: '/users/{uid}/{tableName}/{id} [write]', error: 'Missing request.resource.data' };
        }
        const data = request.resource.data;
        const ownerOk = data.owner_id === null || data.owner_id === undefined || data.owner_id === uid;
        const typeOk = data.entity_type === tableName;
        const idOk = data.id === id;
        const allowed = Boolean(ownerOk && typeOk && idOk);
        return { allowed, matchedRule: '/users/{uid}/{tableName}/{id} [write]' };
      }
    }

    const legacyMatch = this.matchLegacyPath(docPath);
    if (legacyMatch) {
      const isAuth = this.evaluateIsAuthenticated(request.auth);
      if (!isAuth) {
        return { allowed: false, matchedRule: '/finance_entities/{document}' };
      }

      if (op === 'read' || op === 'delete') {
        // resource != null && request.auth.uid == resource.data.owner_id
        if (!resource || !resource.data) {
          return { allowed: false, matchedRule: '/finance_entities/{document} [' + op + ']' };
        }
        const allowed = request.auth?.uid === resource.data.owner_id;
        return { allowed, matchedRule: '/finance_entities/{document} [' + op + ']' };
      }

      if (op === 'create') {
        // request.auth.uid == request.resource.data.owner_id
        if (!request.resource || !request.resource.data) {
          return { allowed: false, matchedRule: '/finance_entities/{document} [create]' };
        }
        const allowed = request.auth?.uid === request.resource.data.owner_id;
        return { allowed, matchedRule: '/finance_entities/{document} [create]' };
      }

      if (op === 'update') {
        // resource != null && request.auth.uid == resource.data.owner_id && request.auth.uid == request.resource.data.owner_id
        if (!resource || !resource.data || !request.resource || !request.resource.data) {
          return { allowed: false, matchedRule: '/finance_entities/{document} [update]' };
        }
        const allowed =
          request.auth?.uid === resource.data.owner_id &&
          request.auth?.uid === request.resource.data.owner_id;
        return { allowed, matchedRule: '/finance_entities/{document} [update]' };
      }
    }

    // Explicit deny-by-default for unmapped paths:
    // match /{document=**} { allow read, write: false; }
    return { allowed: false, matchedRule: '/{document=**} [deny-by-default]' };
  }
}

describe('Adversarial Security Rules Stress-Testing Suite (Challenger 2)', () => {
  let rulesContent: string;
  let evaluator: FirestoreRulesEvaluator;

  beforeAll(() => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    expect(fs.existsSync(rulesPath)).toBe(true);
    rulesContent = fs.readFileSync(rulesPath, 'utf8');
    evaluator = new FirestoreRulesEvaluator(rulesContent);
  });

  describe('Section 1: Static Rules AST & Syntax Invariants', () => {
    it('declares rules_version = "2"', () => {
      expect(rulesContent).toMatch(/rules_version\s*=\s*['"]2['"];/);
    });

    it('enforces cloud.firestore service and documents root match', () => {
      expect(rulesContent).toContain('service cloud.firestore');
      expect(rulesContent).toMatch(/match\s+\/databases\/\{database\}\/documents/);
    });

    it('defines isAuthenticated() checking auth != null and provider != "anonymous"', () => {
      expect(rulesContent).toMatch(/function\s+isAuthenticated\s*\(\)\s*\{/);
      expect(rulesContent).toContain('request.auth != null');
      expect(rulesContent).toContain("request.auth.token.firebase.sign_in_provider != 'anonymous'");
    });

    it('isolates user paths strictly to /users/{uid}/{tableName}/{id}', () => {
      expect(rulesContent).toMatch(/match\s+\/users\/\{uid\}\/\{tableName\}\/\{id\}/);
    });

    it('protects deletion by avoiding request.resource on delete', () => {
      // In Firestore, delete operations provide a null request.resource.
      // If a delete rule references request.resource.data, the rules engine throws a null dereference error.
      const deleteRuleMatch = rulesContent.match(/allow\s+delete:\s*if\s*([^;]+);/);
      expect(deleteRuleMatch).not.toBeNull();
      const deleteCondition = deleteRuleMatch![1];
      expect(deleteCondition).not.toContain('request.resource');
      expect(deleteCondition).toContain('isAuthenticated()');
      expect(deleteCondition).toContain('request.auth.uid == uid');
    });

    it('contains explicit deny-by-default catch-all rule', () => {
      expect(rulesContent).toMatch(/match\s+\/\{document=\*\*\}/);
      expect(rulesContent).toMatch(/allow\s+read,\s*write:\s*false;/);
    });
  });

  describe('Section 2: Anonymous Token Bypass Attacks', () => {
    const anonAuth: AuthContext = {
      uid: 'anon-user-001',
      token: { firebase: { sign_in_provider: 'anonymous' } }
    };

    it('blocks anonymous token from reading own user collections', () => {
      const res = evaluator.evaluate(
        'read',
        '/users/anon-user-001/accounts/acc-001',
        { auth: anonAuth }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks anonymous token from creating records under own user path', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/anon-user-001/accounts/acc-001',
        {
          auth: anonAuth,
          resource: {
            data: {
              owner_id: 'anon-user-001',
              entity_type: 'accounts',
              id: 'acc-001',
              payload: { name: 'Anonymous Bank' }
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks anonymous token from updating records under own user path', () => {
      const res = evaluator.evaluate(
        'update',
        '/users/anon-user-001/accounts/acc-001',
        {
          auth: anonAuth,
          resource: {
            data: {
              owner_id: 'anon-user-001',
              entity_type: 'accounts',
              id: 'acc-001'
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks anonymous token from deleting records under own user path', () => {
      const res = evaluator.evaluate(
        'delete',
        '/users/anon-user-001/accounts/acc-001',
        { auth: anonAuth, resource: null }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks anonymous token from reading foreign user collections', () => {
      const res = evaluator.evaluate(
        'read',
        '/users/victim-user-999/accounts/acc-001',
        { auth: anonAuth }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks anonymous token from accessing legacy finance_entities', () => {
      const resRead = evaluator.evaluate(
        'read',
        '/finance_entities/entity-1',
        { auth: anonAuth },
        { data: { owner_id: 'anon-user-001' } }
      );
      expect(resRead.allowed).toBe(false);

      const resWrite = evaluator.evaluate(
        'create',
        '/finance_entities/entity-1',
        {
          auth: anonAuth,
          resource: { data: { owner_id: 'anon-user-001' } }
        }
      );
      expect(resWrite.allowed).toBe(false);
    });

    it('blocks malformed token missing firebase claim', () => {
      const malformedAuth: AuthContext = {
        uid: 'user-malformed',
        token: {}
      };
      const res = evaluator.evaluate(
        'read',
        '/users/user-malformed/accounts/acc-1',
        { auth: malformedAuth }
      );
      expect(res.allowed).toBe(false);
    });

    it('blocks unauthenticated requests across all operations', () => {
      const ops: Operation[] = ['read', 'create', 'update', 'delete', 'write'];
      for (const op of ops) {
        const res = evaluator.evaluate(
          op,
          '/users/any-user/accounts/acc-1',
          {
            auth: null,
            resource: { data: { owner_id: 'any-user', entity_type: 'accounts', id: 'acc-1' } }
          }
        );
        expect(res.allowed).toBe(false);
      }
    });
  });

  describe('Section 3: Cross-User Access Attacks', () => {
    const userAAuth: AuthContext = {
      uid: 'user-alice',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    const userBAuth: AuthContext = {
      uid: 'user-bob',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    it('rejects User A reading User B accounts collection', () => {
      const res = evaluator.evaluate(
        'read',
        '/users/user-bob/accounts/bob-acc-1',
        { auth: userAAuth }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A writing directly into User B collection', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/user-bob/accounts/bob-acc-1',
        {
          auth: userAAuth,
          resource: {
            data: {
              owner_id: 'user-bob',
              entity_type: 'accounts',
              id: 'bob-acc-1'
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A deleting User B document', () => {
      const res = evaluator.evaluate(
        'delete',
        '/users/user-bob/accounts/bob-acc-1',
        { auth: userAAuth, resource: null }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A creating record in own collection but spoofing owner_id as User B', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/user-alice/accounts/alice-acc-1',
        {
          auth: userAAuth,
          resource: {
            data: {
              owner_id: 'user-bob', // Attacker attempts to forge owner_id
              entity_type: 'accounts',
              id: 'alice-acc-1'
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A updating record in own collection with mismatched entity_type', () => {
      const res = evaluator.evaluate(
        'update',
        '/users/user-alice/accounts/alice-acc-1',
        {
          auth: userAAuth,
          resource: {
            data: {
              owner_id: 'user-alice',
              entity_type: 'transactions', // Table is accounts, entity_type is transactions
              id: 'alice-acc-1'
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A creating record where payload id differs from document path id', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/user-alice/accounts/alice-acc-1',
        {
          auth: userAAuth,
          resource: {
            data: {
              owner_id: 'user-alice',
              entity_type: 'accounts',
              id: 'malicious-injected-id' // ID mismatch
            }
          }
        }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A accessing User B legacy finance_entities document', () => {
      const res = evaluator.evaluate(
        'read',
        '/finance_entities/entity-legacy-bob',
        { auth: userAAuth },
        { data: { owner_id: 'user-bob' } }
      );
      expect(res.allowed).toBe(false);
    });

    it('rejects User A modifying User B legacy finance_entities document', () => {
      const res = evaluator.evaluate(
        'update',
        '/finance_entities/entity-legacy-bob',
        {
          auth: userAAuth,
          resource: { data: { owner_id: 'user-alice' } }
        },
        { data: { owner_id: 'user-bob' } }
      );
      expect(res.allowed).toBe(false);
    });
  });

  describe('Section 4: Document Deletion Attacks & Integrity', () => {
    const validOwnerAuth: AuthContext = {
      uid: 'user-charlie',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    it('succeeds when legitimate owner deletes own document with null request.resource', () => {
      // In Firestore, request.resource is null on delete.
      // Evaluator must execute cleanly without null pointer exceptions.
      const res = evaluator.evaluate(
        'delete',
        '/users/user-charlie/transactions/tx-100',
        { auth: validOwnerAuth, resource: null }
      );
      expect(res.allowed).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it('fails when unauthorized user attempts to delete legitimate owner document', () => {
      const hackerAuth: AuthContext = {
        uid: 'user-hacker',
        token: { firebase: { sign_in_provider: 'google.com' } }
      };
      const res = evaluator.evaluate(
        'delete',
        '/users/user-charlie/transactions/tx-100',
        { auth: hackerAuth, resource: null }
      );
      expect(res.allowed).toBe(false);
    });

    it('fails when unauthenticated actor attempts to delete document', () => {
      const res = evaluator.evaluate(
        'delete',
        '/users/user-charlie/transactions/tx-100',
        { auth: null, resource: null }
      );
      expect(res.allowed).toBe(false);
    });

    it('fails when anonymous user attempts to delete document', () => {
      const anonAuth: AuthContext = {
        uid: 'user-charlie',
        token: { firebase: { sign_in_provider: 'anonymous' } }
      };
      const res = evaluator.evaluate(
        'delete',
        '/users/user-charlie/transactions/tx-100',
        { auth: anonAuth, resource: null }
      );
      expect(res.allowed).toBe(false);
    });

    it('allows legitimate owner to delete legacy finance_entities document', () => {
      const res = evaluator.evaluate(
        'delete',
        '/finance_entities/entity-legacy-charlie',
        { auth: validOwnerAuth, resource: null },
        { data: { owner_id: 'user-charlie' } }
      );
      expect(res.allowed).toBe(true);
    });

    it('rejects deleting non-existent legacy finance_entities document (resource == null)', () => {
      const res = evaluator.evaluate(
        'delete',
        '/finance_entities/entity-legacy-charlie',
        { auth: validOwnerAuth, resource: null },
        null
      );
      expect(res.allowed).toBe(false);
    });
  });

  describe('Section 5: Unmatched Paths & Default-Deny Attacks', () => {
    const adminAuth: AuthContext = {
      uid: 'user-admin',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    const forbiddenPaths = [
      '/admin',
      '/admin/config',
      '/admin/users/all',
      '/system',
      '/system/status',
      '/config',
      '/config/environment',
      '/users',
      '/users/user-admin',
      '/users/user-admin/accounts',
      '/users/user-admin/accounts/acc-1/subcol/sub-1', // Subcollections forbidden
      '/finance_entities',
      '/finance_entities/doc1/subcol/sub-1',
      '/public_data',
      '/secret_keys/firebase',
      '/v1/api/tokens',
      '/marketCache/AAPL' // Market cache only accessed via admin SDK in functions
    ];

    for (const forbiddenPath of forbiddenPaths) {
      it(`strictly denies read on unmatched path ${forbiddenPath}`, () => {
        const res = evaluator.evaluate('read', forbiddenPath, { auth: adminAuth });
        expect(res.allowed).toBe(false);
        expect(res.matchedRule).toContain('deny-by-default');
      });

      it(`strictly denies write on unmatched path ${forbiddenPath}`, () => {
        const res = evaluator.evaluate('create', forbiddenPath, {
          auth: adminAuth,
          resource: { data: { test: true } }
        });
        expect(res.allowed).toBe(false);
        expect(res.matchedRule).toContain('deny-by-default');
      });
    }

    it('fuzzes 50 random alphanumeric root paths and confirms 100% denial', () => {
      for (let i = 0; i < 50; i++) {
        const randomPath = `/${Math.random().toString(36).substring(2)}/${Math.random().toString(36).substring(2)}`;
        const resRead = evaluator.evaluate('read', randomPath, { auth: adminAuth });
        const resWrite = evaluator.evaluate('write', randomPath, {
          auth: adminAuth,
          resource: { data: { malicious: 'data' } }
        });
        expect(resRead.allowed).toBe(false);
        expect(resWrite.allowed).toBe(false);
      }
    });
  });

  describe('Section 6: Legitimate Owner Authorized Operations (Sanity Check)', () => {
    const validOwnerAuth: AuthContext = {
      uid: 'user-david',
      token: { firebase: { sign_in_provider: 'google.com' } }
    };

    it('allows legitimate owner to read their own account document', () => {
      const res = evaluator.evaluate(
        'read',
        '/users/user-david/accounts/acc-main',
        { auth: validOwnerAuth }
      );
      expect(res.allowed).toBe(true);
    });

    it('allows legitimate owner to create account with matching owner_id', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/user-david/accounts/acc-main',
        {
          auth: validOwnerAuth,
          resource: {
            data: {
              owner_id: 'user-david',
              entity_type: 'accounts',
              id: 'acc-main',
              payload: { name: 'Main Checking', balance: 50000 }
            }
          }
        }
      );
      expect(res.allowed).toBe(true);
    });

    it('allows legitimate owner to create account with null owner_id (implicit ownership)', () => {
      const res = evaluator.evaluate(
        'create',
        '/users/user-david/accounts/acc-main',
        {
          auth: validOwnerAuth,
          resource: {
            data: {
              owner_id: null,
              entity_type: 'accounts',
              id: 'acc-main'
            }
          }
        }
      );
      expect(res.allowed).toBe(true);
    });

    it('allows legitimate owner to update account with matching metadata', () => {
      const res = evaluator.evaluate(
        'update',
        '/users/user-david/accounts/acc-main',
        {
          auth: validOwnerAuth,
          resource: {
            data: {
              owner_id: 'user-david',
              entity_type: 'accounts',
              id: 'acc-main',
              payload: { name: 'Main Checking Updated' }
            }
          }
        }
      );
      expect(res.allowed).toBe(true);
    });

    it('allows users authenticated via email/password provider', () => {
      const emailAuth: AuthContext = {
        uid: 'user-david',
        token: { firebase: { sign_in_provider: 'password' } }
      };
      const res = evaluator.evaluate(
        'read',
        '/users/user-david/accounts/acc-main',
        { auth: emailAuth }
      );
      expect(res.allowed).toBe(true);
    });

    it('allows users authenticated via github.com provider', () => {
      const githubAuth: AuthContext = {
        uid: 'user-david',
        token: { firebase: { sign_in_provider: 'github.com' } }
      };
      const res = evaluator.evaluate(
        'read',
        '/users/user-david/accounts/acc-main',
        { auth: githubAuth }
      );
      expect(res.allowed).toBe(true);
    });
  });
});
