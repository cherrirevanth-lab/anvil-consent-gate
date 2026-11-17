# Security

## Threat model

The untrusted inputs are the learner's signup data, the requested scope, and the approval attempt.
The safety property is default deny: without a live grant, `check()` answers `false`, and a minor
cannot create that grant alone.

Mitigations in this repository:

- `check()` is deny-by-default and treats unknown scopes and unknown users as `false`;
- minor approval requires role `guardian` and an approver id different from the learner's id;
- every grant carries a hard expiry; `expiresAt` is exclusive;
- revocation takes effect immediately and is visible in the grant record;
- the audit log and each entry are frozen, and `audit()` returns a frozen copy;
- no network, no dependencies, no environment secrets, no filesystem access.

## Known limits

This library does not authenticate anybody. `approve` with role `guardian` succeeds if the caller
says so; the caller must establish the guardian relationship (an authenticated guardian account,
an invitation, or a signed approval) before making that call. Email ownership is not verified. Age is
derived from a self-attested birth year, not a document.

The store is in memory. An attacker with process access can read it; an attacker with a restart can
erase it. Persistence, multi-process concurrency, rate limiting of approval attempts, and notification
of the guardian are out of scope.

Consent is necessary, not sufficient: a product must still enforce `check()` on every read path.
A test here cannot prove a caller used it.

## Reporting

Open a private security advisory on the repository. Do not file a public issue with a working
bypass of the guardian requirement.
