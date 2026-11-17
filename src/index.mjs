// SPDX-License-Identifier: MIT
/**
 * consent-gate — scoped consent for learner data, default deny.
 *
 * Nothing is readable, exportable or deletable until a grant exists. A minor
 * (under 18) can never approve their own request: the approval must carry
 * role 'guardian' and an approver id different from the learner's id.
 * Grants expire; every state change and refusal lands in an append-only audit
 * log that callers cannot mutate.
 */
const DAY_MS = 86_400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADULT_TTL_DAYS = 3650;
const MIN_REASON = 10;

export const SCOPES = Object.freeze([
  'profile:read',
  'tutor:use',
  'review:use',
  'data:export',
  'data:delete',
]);

export function createGate({ now = () => Date.now(), minAge = 13, consentTtlDays = 365 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(minAge) || minAge < 0) throw new RangeError('minAge must be a non-negative integer');
  if (!Number.isFinite(consentTtlDays) || consentTtlDays <= 0) throw new RangeError('consentTtlDays must be positive');

  const byEmail = new Map();
  const byId = new Map();
  const requests = new Map();
  const grants = new Map();
  const auditLog = [];
  let seq = 0;

  const nextId = (prefix) => `${prefix}_${++seq}`;

  function record({ actorId = null, action, userId = null, scope = null, outcome }) {
    auditLog.push(Object.freeze({ at: now(), actorId, action, userId, scope, outcome }));
  }

  function freezeGrant(grant) {
    return Object.freeze({ ...grant });
  }

  function activeGrant(userId, scope, at) {
    for (const grant of grants.values()) {
      if (grant.userId === userId && grant.scope === scope && grant.revokedAt === null && grant.expiresAt > at) {
        return grant;
      }
    }
    return null;
  }

  function signup({ email, birthYear } = {}) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      record({ action: 'signup', outcome: 'refused' });
      return { ok: false, code: 'INVALID_EMAIL' };
    }
    const normalized = email.trim().toLowerCase();
    if (byEmail.has(normalized)) {
      record({ action: 'signup', outcome: 'refused' });
      return { ok: false, code: 'DUPLICATE_EMAIL' };
    }
    const currentYear = new Date(now()).getUTCFullYear();
    if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > currentYear) {
      record({ action: 'signup', outcome: 'refused' });
      return { ok: false, code: 'INVALID_BIRTH_YEAR' };
    }

    const age = currentYear - birthYear;
    if (age < minAge) {
      record({ action: 'signup', outcome: 'refused' });
      return { ok: false, code: 'UNDER_13' };
    }

    const requiresGuardian = age < 18;
    const user = {
      userId: nextId('usr'),
      email: normalized,
      birthYear,
      ageAtSignup: age,
      requiresGuardian,
      ageAttestedAt: now(),
      closedAt: null,
    };
    byEmail.set(normalized, user);
    byId.set(user.userId, user);
    record({ actorId: user.userId, action: 'signup', userId: user.userId, outcome: 'ok' });

    return { ok: true, userId: user.userId, requiresGuardian };
  }

  function requestPermission({ userId, scope, reason } = {}) {
    const user = byId.get(userId);
    if (!user || user.closedAt !== null) {
      record({ actorId: userId ?? null, action: 'request', userId: userId ?? null, scope: scope ?? null, outcome: 'refused' });
      return { ok: false, code: 'UNKNOWN_USER' };
    }
    if (!SCOPES.includes(scope)) {
      record({ actorId: userId, action: 'request', userId, scope: scope ?? null, outcome: 'refused' });
      return { ok: false, code: 'UNKNOWN_SCOPE' };
    }
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
      record({ actorId: userId, action: 'request', userId, scope, outcome: 'refused' });
      return { ok: false, code: 'REASON_REQUIRED' };
    }

    const existing = activeGrant(userId, scope, now());
    if (existing) {
      return { ok: true, existing: true, grant: freezeGrant(existing) };
    }

    const request = {
      requestId: nextId('req'),
      userId,
      scope,
      reason: reason.trim(),
      status: 'pending',
      createdAt: now(),
      resolvedAt: null,
      grantId: null,
    };
    requests.set(request.requestId, request);
    record({ actorId: userId, action: 'request', userId, scope, outcome: 'pending' });

    return { ok: true, existing: false, requestId: request.requestId, status: request.status };
  }

  function approve({ requestId, approverId, approverRole } = {}) {
    const request = requests.get(requestId);
    if (!request) return { ok: false, code: 'NOT_FOUND' };
    if (request.status !== 'pending') return { ok: false, code: 'ALREADY_RESOLVED' };

    const user = byId.get(request.userId);
    if (user.closedAt !== null) return { ok: false, code: 'ACCOUNT_CLOSED' };
    if (approverRole !== 'self' && approverRole !== 'guardian') {
      return { ok: false, code: 'INVALID_ROLE' };
    }

    if (user.requiresGuardian) {
      const validGuardian = approverRole === 'guardian'
        && typeof approverId === 'string'
        && approverId.length > 0
        && approverId !== request.userId;
      if (!validGuardian) {
        record({
          actorId: approverId ?? null,
          action: 'approve-refused',
          userId: request.userId,
          scope: request.scope,
          outcome: 'refused',
        });
        return { ok: false, code: 'GUARDIAN_REQUIRED' };
      }
    } else if (approverRole === 'self' && approverId !== request.userId) {
      record({
        actorId: approverId ?? null,
        action: 'approve-refused',
        userId: request.userId,
        scope: request.scope,
        outcome: 'refused',
      });
      return { ok: false, code: 'INVALID_APPROVER' };
    }

    const grantedAt = now();
    const ttlDays = user.requiresGuardian ? consentTtlDays : ADULT_TTL_DAYS;
    const grant = {
      grantId: nextId('grt'),
      userId: request.userId,
      scope: request.scope,
      grantedAt,
      expiresAt: grantedAt + ttlDays * DAY_MS,
      revokedAt: null,
      approvedBy: approverId,
      approverRole,
    };
    grants.set(grant.grantId, grant);
    request.status = 'approved';
    request.resolvedAt = grantedAt;
    request.grantId = grant.grantId;
    record({
      actorId: approverId,
      action: 'approve',
      userId: request.userId,
      scope: request.scope,
      outcome: 'ok',
    });

    return { ok: true, grant: freezeGrant(grant) };
  }

  function deny({ requestId, approverId } = {}) {
    const request = requests.get(requestId);
    if (!request) return { ok: false, code: 'NOT_FOUND' };
    if (request.status !== 'pending') return { ok: false, code: 'ALREADY_RESOLVED' };
    request.status = 'denied';
    request.resolvedAt = now();
    record({
      actorId: approverId ?? null,
      action: 'deny',
      userId: request.userId,
      scope: request.scope,
      outcome: 'denied',
    });
    return { ok: true, requestId: request.requestId, status: 'denied' };
  }

  function check({ userId, scope, at = now() } = {}) {
    if (!SCOPES.includes(scope)) return false;
    return activeGrant(userId, scope, at) !== null;
  }

  function revoke({ userId, scope } = {}) {
    let revoked = 0;
    const at = now();
    for (const grant of grants.values()) {
      if (grant.userId === userId && grant.scope === scope && grant.revokedAt === null) {
        grant.revokedAt = at;
        revoked += 1;
      }
    }
    if (revoked > 0) {
      record({ actorId: userId ?? null, action: 'revoke', userId: userId ?? null, scope: scope ?? null, outcome: 'ok' });
    }
    return { ok: true, revoked };
  }

  function grantsFor(userId) {
    const out = [];
    for (const grant of grants.values()) {
      if (grant.userId === userId) out.push(freezeGrant(grant));
    }
    return Object.freeze(out);
  }

  function audit() {
    return Object.freeze(auditLog.slice());
  }

  function closeAccount(userId) {
    const user = byId.get(userId);
    if (!user || user.closedAt !== null) return { ok: false, code: 'UNKNOWN_USER' };

    let removedGrants = 0;
    for (const [grantId, grant] of grants) {
      if (grant.userId === userId) {
        grants.delete(grantId);
        removedGrants += 1;
      }
    }
    let removedRequests = 0;
    for (const [requestId, request] of requests) {
      if (request.userId === userId && request.status === 'pending') {
        requests.delete(requestId);
        removedRequests += 1;
      }
    }
    user.closedAt = now();
    record({ actorId: userId, action: 'close', userId, outcome: 'ok' });
    return { ok: true, removedGrants, removedRequests };
  }

  return {
    signup,
    requestPermission,
    approve,
    deny,
    check,
    revoke,
    grants: grantsFor,
    audit,
    closeAccount,
  };
}
