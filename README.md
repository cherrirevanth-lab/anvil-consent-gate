# consent-gate

Scoped consent for learner data. **Nothing is allowed by default**, and a minor can never be granted
a scope without a guardian.

```
signup          13..17 -> requiresGuardian: true
request         pending, reason required, scope must exist
approve         minor + role 'self' -> GUARDIAN_REQUIRED
check           no grant -> false
```

## Why

A consent screen that defaults to "on", or that lets a 14-year-old click their own approval, is not
consent. This module keeps the decision in one place: a grant exists or it does not, it has an
expiry, and every refusal is written down. The caller cannot read data by asking a different
function, because `check()` is the only read path and it answers `false` until a valid grant exists.

The guardian rule is structural, not cosmetic: for a minor the approver must carry role `guardian`
**and** an approver id different from the learner's id. Self-approval is refused with a code, and a
test asserts that refusal.

## Quickstart

```sh
node --test test/     # 21 tests, no dependencies
node src/cli.mjs      # runs a signup -> request -> refusal -> guardian grant demo
node verify.mjs       # writes evidence.json
```

```js
import { createGate } from './src/index.mjs';

const gate = createGate({ now: () => Date.now() });
const { userId, requiresGuardian } = gate.signup({ email: 'learner@example.com', birthYear: 2012 });

const req = gate.requestPermission({
  userId,
  scope: 'tutor:use',
  reason: 'Tutor help with algebra homework',
});
gate.approve({ requestId: req.requestId, approverId: 'guardian_1', approverRole: 'guardian' });
gate.check({ userId, scope: 'tutor:use' }); // true until expiresAt
```

## Contract

`createGate({ now?, minAge?, consentTtlDays? }) -> Gate`

| Option | Default | Meaning |
|---|---|---|
| `now` | `() => Date.now()` | injected clock in milliseconds |
| `minAge` | `13` | signups below this age are refused with `UNDER_13` |
| `consentTtlDays` | `365` | lifetime of a guardian-approved grant |

Scopes: `profile:read`, `tutor:use`, `review:use`, `data:export`, `data:delete`.

| Method | Result |
|---|---|
| `signup({ email, birthYear })` | `{ ok, userId, requiresGuardian }` or `{ ok: false, code }` |
| `requestPermission({ userId, scope, reason })` | `{ ok, requestId, status }`, or `{ ok: true, existing: true }` when already granted |
| `approve({ requestId, approverId, approverRole })` | `{ ok, grant: { grantId, scope, expiresAt, ... } }` |
| `deny({ requestId, approverId })` | `{ ok, requestId, status: 'denied' }` |
| `check({ userId, scope, at? })` | `true` only for an unrevoked, unexpired grant |
| `revoke({ userId, scope })` | `{ ok, revoked: number }` |
| `grants(userId)` | frozen array of grant records, including revoked and expired ones |
| `audit()` | frozen array of `{ at, actorId, action, userId, scope, outcome }` |
| `closeAccount(userId)` | removes grants and pending requests; audit is retained |

Codes: `UNDER_13`, `INVALID_EMAIL`, `INVALID_BIRTH_YEAR`, `DUPLICATE_EMAIL`, `UNKNOWN_USER`,
`UNKNOWN_SCOPE`, `REASON_REQUIRED`, `GUARDIAN_REQUIRED`, `INVALID_APPROVER`, `INVALID_ROLE`,
`NOT_FOUND`, `ALREADY_RESOLVED`, `ACCOUNT_CLOSED`.

Age is the difference between the UTC year of the injected clock and `birthYear`. That is the only
age signal accepted; there is no date of birth and no document verification.

## Limits

- A grant is per `(userId, scope)`. There is no role hierarchy, no delegation, no org model.
- Approval is a trusted call: this module does not authenticate the guardian. The caller must verify
  the guardian relationship before calling `approve` with role `guardian`.
- Revoking one grant does not revoke a second grant for the same scope; all matching unrevoked grants
  are revoked together.
- `closeAccount` is logical: it deletes grants and pending requests from memory. Persistence and
  erasure from backups are the caller's problem.

## What this proves, and what it does not

Proven by `test/consent-gate.test.mjs`: under-13 refusal, the exact 13 boundary and 14 just past it,
17 still a minor, 18 an adult, minor self-approval refused, guardian grant, adult self-approval,
default deny, unknown scope, short reason, exact expiry boundary at `expiresAt` and 1 ms before it,
revocation, unknown-scope check, frozen append-only audit with a recorded refusal, duplicate email,
existing-grant reuse, denial, account closure, configurable TTL, invalid role.

Not proven here: guardian identity, email ownership, durable storage, concurrency, or that a caller
actually enforces `check()` before returning data. A test can prove the library says no; only an
integration test can prove the product asks the library.

## Permissions

None at runtime. No network, no secrets, no filesystem access, no child processes. The CI workflow
requests `contents: read` only. See `permission-manifest.json`.

## License

MIT (c) 2026 Revan
