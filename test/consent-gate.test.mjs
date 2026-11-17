// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, SCOPES } from '../src/index.mjs';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const REASON = 'Needs tutor help with algebra homework';

function harness(options = {}) {
  let t = START;
  const gate = createGate({ now: () => t, ...options });
  return {
    gate,
    advance: (ms) => { t += ms; },
    setTime: (value) => { t = value; },
    now: () => t,
  };
}

function adultId(gate, email = 'adult@example.com') {
  const out = gate.signup({ email, birthYear: 1990 });
  assert.equal(out.ok, true);
  return out.userId;
}

function minorId(gate, birthYear = 2012, email = 'minor@example.com') {
  const out = gate.signup({ email, birthYear });
  assert.equal(out.ok, true);
  return out.userId;
}

test('under-13 signup is rejected with UNDER_13', () => {
  const { gate } = harness();
  const out = gate.signup({ email: 'child@example.com', birthYear: 2014 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNDER_13');
  assert.equal(out.userId, undefined);
});

test('a user exactly 13 may sign up but requires a guardian', () => {
  const { gate } = harness();
  const out = gate.signup({ email: 'thirteen@example.com', birthYear: 2013 });
  assert.equal(out.ok, true);
  assert.equal(out.requiresGuardian, true);
});

test('a user just past the boundary at 14 also requires a guardian', () => {
  const { gate } = harness();
  const out = gate.signup({ email: 'fourteen@example.com', birthYear: 2012 });
  assert.equal(out.ok, true);
  assert.equal(out.requiresGuardian, true);
});

test('a 17-year-old requires a guardian', () => {
  const { gate } = harness();
  const out = gate.signup({ email: 'seventeen@example.com', birthYear: 2009 });
  assert.equal(out.ok, true);
  assert.equal(out.requiresGuardian, true);
});

test('an 18-year-old does not require a guardian', () => {
  const { gate } = harness();
  const out = gate.signup({ email: 'eighteen@example.com', birthYear: 2008 });
  assert.equal(out.ok, true);
  assert.equal(out.requiresGuardian, false);
});

test('a minor may not self-approve a permission request', () => {
  const { gate } = harness();
  const userId = minorId(gate);
  const req = gate.requestPermission({ userId, scope: 'tutor:use', reason: REASON });
  assert.equal(req.ok, true);
  const out = gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'self' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'GUARDIAN_REQUIRED');
  assert.equal(gate.check({ userId, scope: 'tutor:use' }), false);
});

test('a guardian approval grants a minor a 365-day scope', () => {
  const { gate, now } = harness();
  const userId = minorId(gate);
  const req = gate.requestPermission({ userId, scope: 'tutor:use', reason: REASON });
  const out = gate.approve({ requestId: req.requestId, approverId: 'guardian_1', approverRole: 'guardian' });
  assert.equal(out.ok, true);
  assert.equal(out.grant.scope, 'tutor:use');
  assert.equal(out.grant.userId, userId);
  assert.equal(out.grant.expiresAt, now() + 365 * DAY);
  assert.equal(gate.check({ userId, scope: 'tutor:use' }), true);
});

test('an adult may self-approve and receives a 3650-day scope', () => {
  const { gate, now } = harness();
  const userId = adultId(gate);
  const req = gate.requestPermission({ userId, scope: 'data:export', reason: REASON });
  const out = gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'self' });
  assert.equal(out.ok, true);
  assert.equal(out.grant.expiresAt, now() + 3650 * DAY);
  assert.equal(gate.check({ userId, scope: 'data:export' }), true);
});

test('check denies every scope before any approval', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  for (const scope of SCOPES) {
    assert.equal(gate.check({ userId, scope }), false, `${scope} must be denied by default`);
  }
});

test('an unknown scope is refused at request time', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const out = gate.requestPermission({ userId, scope: 'admin:everything', reason: REASON });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNKNOWN_SCOPE');
});

test('a reason shorter than 10 characters is refused', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const out = gate.requestPermission({ userId, scope: 'profile:read', reason: 'short' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'REASON_REQUIRED');
  const blank = gate.requestPermission({ userId, scope: 'profile:read', reason: '          ' });
  assert.equal(blank.code, 'REASON_REQUIRED');
});

test('a grant is valid one millisecond before expiry and invalid exactly at expiry', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const req = gate.requestPermission({ userId, scope: 'review:use', reason: REASON });
  const { grant } = gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'self' });
  assert.equal(gate.check({ userId, scope: 'review:use', at: grant.expiresAt - 1 }), true);
  assert.equal(gate.check({ userId, scope: 'review:use', at: grant.expiresAt }), false);
});

test('revoking a grant makes check false immediately', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const req = gate.requestPermission({ userId, scope: 'data:delete', reason: REASON });
  gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'self' });
  assert.equal(gate.check({ userId, scope: 'data:delete' }), true);
  const out = gate.revoke({ userId, scope: 'data:delete' });
  assert.equal(out.ok, true);
  assert.equal(out.revoked, 1);
  assert.equal(gate.check({ userId, scope: 'data:delete' }), false);
  assert.equal(gate.grants(userId)[0].revokedAt !== null, true);
});

test('checking an unknown scope is false, never an exception', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  assert.equal(gate.check({ userId, scope: 'root:all' }), false);
  assert.equal(gate.check({ userId: 'usr_does_not_exist', scope: 'profile:read' }), false);
});

test('the audit log is frozen, append-only and records a refusal', () => {
  const { gate, advance } = harness();
  gate.signup({ email: 'child@example.com', birthYear: 2014 });
  const userId = minorId(gate);
  const req = gate.requestPermission({ userId, scope: 'tutor:use', reason: REASON });
  gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'self' });

  const snapshot = gate.audit();
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => snapshot.push({ action: 'forged' }), TypeError);
  assert.ok(snapshot.some((e) => e.action === 'approve-refused' && e.outcome === 'refused'));
  assert.ok(snapshot.every((e) => Object.isFrozen(e)));

  const lengthBefore = snapshot.length;
  advance(DAY);
  gate.requestPermission({ userId, scope: 'profile:read', reason: REASON });
  assert.equal(snapshot.length, lengthBefore);
  assert.ok(gate.audit().length > lengthBefore);
});

test('a duplicate email is refused, including a different case', () => {
  const { gate } = harness();
  adultId(gate, 'same@example.com');
  const again = gate.signup({ email: 'same@example.com', birthYear: 1990 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'DUPLICATE_EMAIL');
  const cased = gate.signup({ email: 'Same@Example.com', birthYear: 1990 });
  assert.equal(cased.code, 'DUPLICATE_EMAIL');
});

test('asking again for an active scope reports existing instead of a new request', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const first = gate.requestPermission({ userId, scope: 'profile:read', reason: REASON });
  gate.approve({ requestId: first.requestId, approverId: userId, approverRole: 'self' });
  const second = gate.requestPermission({ userId, scope: 'profile:read', reason: REASON });
  assert.equal(second.ok, true);
  assert.equal(second.existing, true);
  assert.equal(second.requestId, undefined);
});

test('deny closes the request and is audited; approval afterwards is refused', () => {
  const { gate } = harness();
  const userId = minorId(gate);
  const req = gate.requestPermission({ userId, scope: 'data:export', reason: REASON });
  const denied = gate.deny({ requestId: req.requestId, approverId: 'guardian_1' });
  assert.equal(denied.ok, true);
  assert.equal(denied.status, 'denied');
  assert.equal(gate.check({ userId, scope: 'data:export' }), false);
  assert.equal(gate.audit().some((e) => e.action === 'deny' && e.outcome === 'denied'), true);
  const late = gate.approve({ requestId: req.requestId, approverId: 'guardian_1', approverRole: 'guardian' });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'ALREADY_RESOLVED');
});

test('closeAccount removes grants and pending requests but keeps the audit log', () => {
  const { gate } = harness();
  const userId = minorId(gate);
  const granted = gate.requestPermission({ userId, scope: 'tutor:use', reason: REASON });
  gate.approve({ requestId: granted.requestId, approverId: 'guardian_1', approverRole: 'guardian' });
  const pending = gate.requestPermission({ userId, scope: 'review:use', reason: REASON });

  const closed = gate.closeAccount(userId);
  assert.equal(closed.ok, true);
  assert.equal(closed.removedGrants, 1);
  assert.equal(closed.removedRequests, 1);
  assert.deepEqual(gate.grants(userId), []);
  assert.equal(gate.check({ userId, scope: 'tutor:use' }), false);
  assert.equal(gate.approve({ requestId: pending.requestId, approverId: 'guardian_1', approverRole: 'guardian' }).code, 'NOT_FOUND');
  assert.ok(gate.audit().some((e) => e.action === 'close'));
});

test('a configured consent TTL applies to guardian grants', () => {
  const { gate, now } = harness({ consentTtlDays: 30 });
  const userId = minorId(gate);
  const req = gate.requestPermission({ userId, scope: 'tutor:use', reason: REASON });
  const { grant } = gate.approve({ requestId: req.requestId, approverId: 'guardian_1', approverRole: 'guardian' });
  assert.equal(grant.expiresAt, now() + 30 * DAY);
  assert.equal(gate.check({ userId, scope: 'tutor:use', at: now() + 30 * DAY }), false);
});

test('an approval with an invalid role is refused', () => {
  const { gate } = harness();
  const userId = adultId(gate);
  const req = gate.requestPermission({ userId, scope: 'profile:read', reason: REASON });
  const out = gate.approve({ requestId: req.requestId, approverId: userId, approverRole: 'owner' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_ROLE');
});
