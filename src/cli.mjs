// SPDX-License-Identifier: MIT
import { createGate, SCOPES } from './index.mjs';

const DAY = 86_400_000;
let clock = Date.UTC(2026, 0, 1);
const gate = createGate({ now: () => clock });

const adult = gate.signup({ email: 'adult@example.com', birthYear: 1990 });
const minor = gate.signup({ email: 'minor@example.com', birthYear: 2012 });

const minorRequest = gate.requestPermission({
  userId: minor.userId,
  scope: 'tutor:use',
  reason: 'Tutor support for algebra homework',
});
const selfAttempt = gate.approve({
  requestId: minorRequest.requestId,
  approverId: minor.userId,
  approverRole: 'self',
});
const guardianApproval = gate.approve({
  requestId: minorRequest.requestId,
  approverId: 'guardian_1',
  approverRole: 'guardian',
});
const introGrant = gate.approve({
  requestId: gate.requestPermission({
    userId: adult.userId,
    scope: 'profile:read',
    reason: 'Show my own profile settings page',
  }).requestId,
  approverId: adult.userId,
  approverRole: 'self',
});

const allowedNow = gate.check({ userId: minor.userId, scope: 'tutor:use' });
clock += 366 * DAY;
const expiredLater = gate.check({ userId: minor.userId, scope: 'tutor:use' });
const under13 = gate.signup({
  email: 'child@example.com',
  birthYear: new Date(clock).getUTCFullYear() - 12,
});

const demo = {
  ok:
    under13.code === 'UNDER_13' &&
    selfAttempt.code === 'GUARDIAN_REQUIRED' &&
    guardianApproval.ok &&
    introGrant.ok &&
    allowedNow === true &&
    expiredLater === false &&
    gate.check({ userId: adult.userId, scope: 'data:export' }) === false,
  scopes: SCOPES,
  under13,
  selfAttempt,
  guardianExpiresInDays: (guardianApproval.grant.expiresAt - Date.UTC(2026, 0, 1)) / DAY,
  allowedNow,
  expiredLater,
  auditEntries: gate.audit().length,
};

process.stdout.write(JSON.stringify(demo, null, 2) + '\n');
process.exitCode = demo.ok ? 0 : 1;
