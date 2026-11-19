# Security Specification & Payload-First TDD — CukaiDesk Personal Tax Portal

## 1. Data Invariants
1. **Identity & Verification**: Every read and write operation requires an authenticated Firebase user with `email_verified == true`.
2. **PII Isolation**: Client documents (`/clients/{clientId}`) contain taxpayer PII (`email`, `phone`, `name`). Reads and list queries are strictly restricted to the owning verified client (`ownerUid == request.auth.uid || email == request.auth.token.email`) or a verified staff admin.
3. **Master Gate Relational Integrity**: Subcollections (`/clients/{clientId}/verifications/{verificationId}` and `/clients/{clientId}/reminders/{reminderId}`) cannot be created unless the parent `/clients/{clientId}` document exists and the caller is authorized on the parent document.
4. **Terminal State Locking**: Once a tax file is locked for LHDN computation (`isLocked == true`), clients can no longer mutate the client record or append new verification runs; only staff admins may unlock or amend locked engagements.
5. **Immutable Audit & Timestamps**: `createdAt` must equal `request.time` on creation and never change; `updatedAt` must equal `request.time` on updates; `clientId` and `ownerUid` are immutable for non-admin updates.
6. **Zero Privilege Escalation**: Non-admins cannot write to `/admins/{uid}`, cannot set `isLocked: true` on creation, cannot send/fabricate staff reminder records, and cannot inject undeclared fields (`hasOnly`).

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unverified Email Spoofing**: Authenticated user with `email: "chwong0529@gmail.com"` and `email_verified: false` attempts to list `/clients`.
2. **Cross-Client PII Read**: Verified client B attempts `get` on `/clients/TAX-2026-089` belonging to client A.
3. **Unfiltered Collection Scrape**: Verified client B runs `list` on `/clients` without matching `ownerUid` or `email`.
4. **Shadow Field Injection**: Client A updates `/clients/TAX-2026-089` adding ghost field `{ "isAdmin": true }` or `{ "auditOverride": true }`.
5. **Client Self-Lock / Unauthorized Field Mutation**: Client A updates `reminderCount` or `taxYear` or `isLocked` on their own client document.
6. **Locked Engagement Tampering**: Client A attempts to update `requiredDocuments` on a document where `existing().isLocked == true`.
7. **Timestamp Forgery**: Client creates or updates a document with a backdated client timestamp instead of `request.time`.
8. **ID Poisoning / Resource Exhaustion**: Attacker attempts `create` at `/clients/invalid$id%with spaces` or a 200-char ID.
9. **Array Overflow (Denial of Wallet)**: Payload includes `requiredDocuments` array with 25 items (limit is 20).
10. **Orphaned Subcollection Write**: Attacker creates `/clients/NON_EXISTENT_ID/verifications/v1` where parent client does not exist.
11. **Reminder Forgery by Client**: Verified client A attempts to create a document in `/clients/TAX-2026-089/reminders/r1` (staff-only action).
12. **Self-Admin Promotion**: Verified client attempts `create` at `/admins/{ownUid}` to grant themselves admin role.
