# Rebuild contract - consent-gate

Anything that satisfies this document and passes `test/consent-gate.test.mjs` is a valid
reconstruction. The tests are the oracle; this is the map.

## 1. File tree

```
07-consent-gate/
├─ package.json            type: module, scripts: test/start/verify, no dependencies
├─ src/index.mjs           exports createGate(), SCOPES
├─ src/cli.mjs             signup -> request -> refusal -> guardian grant demo
├─ test/consent-gate.test.mjs  21 acceptance tests
├─ verify.mjs              runs tests + CLI smoke, writes evidence.json
├─ permission-manifest.json
├─ .github/workflows/ci.yml
├─ README.md
├─ SPEC.md
├─ SECURITY.md
├─ LICENSE
└─ .gitignore
```

## 2. Public API

```ts
const SCOPES: readonly ['profile:read','tutor:use','review:use','data:export','data:delete'];

function createGate(options?: {
  now?: () => number;          // default () => Date.now()
  minAge?: number;             // default 13
  consentTtlDays?: number;     // default 365
}): {
  signup(input: { email: string; birthYear: number }):
    | { ok: true; userId: string; requiresGuardian: boolean }
    | { ok: false; code: string };
  requestPermission(input: { userId: string; scope: string; reason: string }):
    | { ok: true; existing: false; requestId: string; status: 'pending' }
    | { ok: true; existing: true; grant: Grant }
    | { ok: false; code: string };
  approve(input: { requestId: string; approverId: string; approverRole: 'self' | 'guardian' }):
    | { ok: true; grant: Grant }
    | { ok: false; code: string };
  deny(input: { requestId: string; approverId: string }):
    | { ok: true; requestId: string; status: 'denied' }
    | { ok: false; code: string };
  check(input: { userId: string; scope: string; at?: number }): boolean;
  revoke(input: { userId: string; scope: string }): { ok: true; revoked: number };
  grants(userId: string): readonly Grant[];
  audit(): readonly AuditEntry[];
  closeAccount(userId: string):
    | { ok: true; removedGrants: number; removedRequests: number }
    | { ok: false; code: 'UNKNOWN_USER' };
};
```

`Grant = { grantId, userId, scope, grantedAt, expiresAt, revokedAt, approvedBy, approverRole }`.
`AuditEntry = { at, actorId, action, userId, scope, outcome }`, all frozen.

## 3. Algorithm

1. **Signup.** Trim and lower-case the email; reject if it fails `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
   (`INVALID_EMAIL`) or is already registered (`DUPLICATE_EMAIL`). Reject a `birthYear` that is not
   an integer in `[1900, current UTC year]`. Age = `current UTC year - birthYear`. Age `< minAge`
   returns `UNDER_13`. Age `< 18` sets `requiresGuardian: true`. Store `ageAttestedAt = now()`,
   which is never null.
2. **Request.** Resolve the user (must exist and not be closed). Scope must be in `SCOPES`
   (`UNKNOWN_SCOPE`). Trimmed reason must be at least 10 characters (`REASON_REQUIRED`). If an
   unrevoked grant with `expiresAt > now()` already exists, return `{ ok: true, existing: true }`.
   Otherwise create a pending request.
3. **Approve.** The request must exist (`NOT_FOUND`) and still be pending (`ALREADY_RESOLVED`).
   Role must be `self` or `guardian` (`INVALID_ROLE`). For a minor: role must be `guardian`,
   `approverId` must be a non-empty string and must differ from the request's `userId`; otherwise
   `GUARDIAN_REQUIRED` and an `approve-refused` audit entry. For an adult with role `self`,
   `approverId` must equal the request's `userId` (`INVALID_APPROVER`).
4. **Grant.** `expiresAt = now() + ttlDays * 86400000`, where `ttlDays = consentTtlDays` for a minor
   and `3650` for an adult. Record `approve`.
5. **Deny.** Only a pending request; set `status: 'denied'` and record `deny` with outcome `denied`.
6. **Check.** Return `false` for an unknown scope or no user. Return `true` only when a grant exists
   for that user and scope with `revokedAt === null` and `expiresAt > at`, where `at` defaults to
   `now()`.
7. **Revoke.** Set `revokedAt = now()` on every unrevoked grant for that user and scope. Return the
   count.
8. **Close.** Set `closedAt`, delete every grant and every pending request for the user, keep all
   audit entries, record `close`.
9. **Audit.** `record()` pushes a frozen entry. `audit()` returns a frozen shallow copy, so a caller
   cannot push, pop, or reorder the log. Entries themselves are frozen.

## 4. Invariants -> owning test

| # | Invariant | Test |
|---|---|---|
| C1 | A person under 13 cannot sign up | `under-13 signup is rejected with UNDER_13` |
| C2 | Exactly 13 is allowed but needs a guardian | `a user exactly 13 may sign up but requires a guardian` |
| C3 | 14 is still a minor | `a user just past the boundary at 14 also requires a guardian` |
| C4 | 17 is a minor | `a 17-year-old requires a guardian` |
| C5 | 18 is an adult | `an 18-year-old does not require a guardian` |
| C6 | A minor cannot self-approve | `a minor may not self-approve a permission request` |
| C7 | Guardian approval grants a scoped, 365-day right | `a guardian approval grants a minor a 365-day scope` |
| C8 | An adult self-approval works for 3650 days | `an adult may self-approve and receives a 3650-day scope` |
| C9 | Nothing is allowed before approval | `check denies every scope before any approval` |
| C10 | An unknown scope is refused | `an unknown scope is refused at request time` |
| C11 | A short reason is refused | `a reason shorter than 10 characters is refused` |
| C12 | Validity is `expiresAt` exclusive | `a grant is valid one millisecond before expiry and invalid exactly at expiry` |
| C13 | Revocation is immediate | `revoking a grant makes check false immediately` |
| C14 | An unknown scope check is false | `checking an unknown scope is false, never an exception` |
| C15 | Audit is frozen, append-only, records refusals | `the audit log is frozen, append-only and records a refusal` |
| C16 | Duplicate emails cannot create a second user | `a duplicate email is refused, including a different case` |
| C17 | An active grant short-circuits a new request | `asking again for an active scope reports existing instead of a new request` |
| C18 | Denied requests cannot later be approved | `deny closes the request and is audited; approval afterwards is refused` |
| C19 | Closure removes grants and pending requests, keeps audit | `closeAccount removes grants and pending requests but keeps the audit log` |
| C20 | Guardian TTL is configurable | `a configured consent TTL applies to guardian grants` |
| C21 | Unknown roles cannot approve | `an approval with an invalid role is refused` |

## 5. Boundaries

- **Age.** The only signal is `birthYear`, so the age is a year difference. A learner born late in
  the year is treated as their age on January 1. If exact age is required, change `signup` to accept
  a date of birth and add a test; nothing else moves.
- **Guardian identity.** `approve` trusts its caller. There is no guardian account, invitation, or
  signature. That belongs in the caller, and must be tested there.
- **Time.** All time comes from `now`. Nothing expires by itself: `check` compares against `at`.
- **Memory only.** A restart loses users, grants, requests and audit. Persistence must preserve the
  same shapes and the same default-deny check.

## 6. Rebuild checklist

- [ ] `node --test test/` -> 21 passing.
- [ ] `node src/cli.mjs` exits 0 and prints `"ok": true`.
- [ ] `node verify.mjs` writes `evidence.json` with `ok: true`.
- [ ] `package.json` has no `dependencies` key with entries.
- [ ] `SCOPES` is frozen and has exactly five entries.
- [ ] `audit()` is frozen and a push throws.
