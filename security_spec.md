# Security Specification (`firestore.rules`)

## 1. Data Invariants
1. **Authentication & Verification**: All application read/write operations require an authenticated, email-verified user (`request.auth != null && request.auth.token.email_verified == true`).
2. **PII Isolation**: User email is stored exclusively in `/users/{userId}/private/info` and is readable/writable only by that exact owner (`request.auth.uid == userId`) or a verified Super Admin.
3. **Master Gate & Ownership**: Every warehouse and every child document (`catalog`, `transactions`, `batches`, `defects`, `cycleCounts`, `cycleCounts/lines`, `inboundRegister`) must bind `ownerId == request.auth.uid` on creation, verify parent existence via `exists()`, and lock `ownerId`, `warehouseId`, and `createdAt` against mutation.
4. **No Self-Assigned Privilege**: Users creating `/users/{userId}` can only assign `role == 'stockkeeper'` unless they already exist in `/admins/{request.auth.uid}` or are Super Admin.
5. **Terminal State Locking**: Once a `WarehouseTransaction` reaches `ancanthoDone == true`, a `DefectRecord` reaches `'MUSNAH'`, `'RETUR'`, or `'RETUR SUPPLIER'`, or a `CycleCountSession` reaches `'SELESAI'`, standard updates are blocked unless overridden by a verified admin (`isAdmin()`).
6. **Strict ID & String Bounds**: All path IDs match `^[a-zA-Z0-9_\-]+$` with length `1..128`. Every string field has an explicit `.size()` upper bound, and `memberEmails` arrays are strictly bounded (`<= 50` entries).
7. **Server Timestamps**: `createdAt` on create and `updatedAt` on create/update must strictly equal `request.time`.
8. **Query Enforcement**: Every `allow list` rule evaluates `resource.data` (`ownerId == request.auth.uid`, bootstrapped super admin email claim, or bounded `memberEmails` containment) without `get()` or `exists()` lookups.
9. **Cloud PIN Config Protection**: Admin/Super Admin PIN hashes in `/pinConfigs/{configId}` use salted PBKDF2-SHA256 digests and can only be written by the workspace owner or Super Admin with immutable `ownerId` and `createdAt`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: `create /warehouses/gp1` with `request.auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `create /warehouses/gp1` with `token.email == adminEmail` and `token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Self-Assigned Admin Role**: `create /users/u1` with `{ uid: 'u1', displayName: 'Attacker', role: 'admin', ... }` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection**: `create /warehouses/gp1/transactions/tx1` with extra ghost key `isVerified: true` -> `PERMISSION_DENIED`.
5. **Identity Spoofing on Create**: `create /warehouses/gp1` with `ownerId: 'victim_uid'` while authenticated as `'attacker_uid'` -> `PERMISSION_DENIED`.
6. **Cross-Tenant List Scraping**: `list /warehouses/gp1/transactions` without matching `ownerId` or `memberEmails` -> `PERMISSION_DENIED`.
7. **PII Leak Attempt**: `get /users/victim_uid/private/info` authenticated as `'attacker_uid'` -> `PERMISSION_DENIED`.
8. **Orphan Subcollection Record**: `create /warehouses/nonexistent_wh/transactions/tx1` -> `PERMISSION_DENIED` (blocked by `exists()` parent gate).
9. **ID Poisoning**: `create /warehouses/bad..id/transactions/tx1` or >128 char ID -> `PERMISSION_DENIED`.
10. **Immortal Field Mutation**: `update /warehouses/gp1/transactions/tx1` changing `ownerId` or `createdAt` -> `PERMISSION_DENIED`.
11. **Terminal State Bypass**: `update /warehouses/gp1/cycleCounts/cc1` modifying a session whose existing `status == 'SELESAI'` (as non-admin) -> `PERMISSION_DENIED`.
12. **Client Timestamp Forgery**: `create /warehouses/gp1` with backdated `createdAt` != `request.time` -> `PERMISSION_DENIED`.
