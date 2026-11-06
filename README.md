# Backend setup

## F04 sales API

Run `npm run dev`, then open [F04 Swagger UI](http://localhost:5000/fo4/) to test counter sales independently of F03. See [F04 flow, API and test guide](docs/f04-sales.md) for setup, request examples and stock/payment checks. The API requires the existing sales and inventory domain tables; the auth-only Prisma migration does not create those tables.

## Supabase configuration

1. In Supabase **Authentication → Providers**, enable Google and Email as needed. Configure the Google OAuth callback shown by Supabase in the Google Cloud OAuth client.
2. In **Authentication → URL Configuration**, add the frontend callback URL (for local development, `http://localhost:5173/auth/callback`) to the allowed redirect URLs.
3. Configure SMTP under **Authentication → SMTP Settings** before relying on confirmation, password-reset, or invitation email delivery.
4. Copy `.env.example` to `.env`. For a local network without IPv6, open **Connect** in the Supabase Dashboard, select **Session pooler**, and copy its connection string into both `DATABASE_URL` and `DIRECT_URL`. Keep the username, hostname, and port exactly as provided by Supabase; the pooler host is region-specific. If the database password contains reserved URI characters, URL-encode them. Use a direct connection only when the environment has IPv6 connectivity or the project has the IPv4 add-on. Set the project URL, publishable/anon key, and callback URL too. Set `SUPABASE_SERVICE_ROLE_KEY` only in this backend environment; never use it in frontend code.
5. To bootstrap a platform administrator, set `SYSTEM_ADMIN_EMAIL` to the intended account email. That verified Supabase Auth account receives `SYSTEM_ADMIN` when it first calls `GET /api/auth/me`.

Supabase Auth performs sign-up, sign-in, OAuth, email confirmation, and password reset in the frontend. The backend validates access tokens with Supabase Auth and creates/updates the corresponding application profile.

## Database migrations

The `20261022144500_auth_rbac_invitations` migration establishes the auth, membership, invitation, and two-scope RBAC tables. `20261106170000_platform_admin_mvp` adds account/business status, inactive memberships, business activity permissions, and the audit log used by system administration. Existing business-domain models and migrations cover product, inventory, sales, and other operational features.

The original business-domain schema and its un-applied initial migration are preserved under `prisma/legacy/`, outside Prisma's migration path. They do not run when using `prisma migrate deploy`. The active `schema.prisma` and checked-in migration chain describe the current database; keep them aligned when adding later features.

After reviewing the migration and confirming the target Supabase project and backup, apply pending migrations from the backend folder with:

```powershell
npx prisma migrate deploy
```

Prisma runs the checked-in SQL and records each migration in `public._prisma_migrations`. Do not first run SQL separately in Supabase SQL Editor. If a migration is applied manually, mark that exact migration name as applied (for example, `npx prisma migrate resolve --applied 20261106170000_platform_admin_mvp`); otherwise the Prisma history will not match the database.

The migration enables Row Level Security on the new public tables and intentionally creates no client-side RLS policies. The backend connects directly to PostgreSQL and enforces access in its API; do not access these tables directly from the frontend Supabase client.

## Admin and membership management

- `GET /api/admin/dashboard`, `/api/admin/users`, `/api/admin/businesses`, and `/api/admin/audit-logs` provide platform-admin views.
- `PATCH /api/admin/users/:userId/status` suspends or restores an account. `PATCH /api/admin/businesses/:businessId/status` suspends or restores a business; `PATCH /api/admin/businesses/:businessId` edits its profile.
- `PATCH /api/admin/users/:userId/system-admin` grants or revokes the seeded `SYSTEM_ADMIN` role. Only the verified account configured by `SYSTEM_ADMIN_EMAIL` can use this endpoint; that bootstrap account cannot have its role revoked or be suspended through the platform API. Other System Admins can manage platform users and businesses but cannot change System Admin assignments. A System Admin cannot simultaneously hold an active/suspended business membership; role grants, bootstrap, business onboarding, invitations, and invitation acceptance enforce this separation. The last active System Admin cannot be suspended or removed.
- `PATCH /api/businesses/profile` lets the owner update their business profile. `PATCH /api/businesses/members/:membershipId/status` changes a staff membership to `ACTIVE`, `SUSPENDED`, or `INACTIVE`. It does not lock the person's platform account. One user can have only one active/suspended business membership at a time; inactive membership history is retained. `GET /api/businesses/activity` is restricted to the signed-in business.
- Platform account suspension blocks authenticated API access. Business suspension and non-active membership block business-scoped operations without suspending the user's platform account. Status/role changes require a reason and are recorded in `platform_audit_logs`; profile edits record field-level before/after values.

Business roles are tenant-scoped. The migration creates a default Staff role for each business and copies the existing Staff permissions without changing access at migration time. Owners can edit that default role, create additional roles, assign them to employees, and choose a role when inviting a new employee. Platform permissions and business administration/audit permissions cannot be assigned to employee roles. Archived roles retain historical memberships and audit records; roles in use by active members or pending invitations cannot be archived.

The custom-RBAC migration is `20261106174000_business_custom_rbac` and must be applied before using these endpoints. Platform and business API authorization remain the security boundary; frontend route and menu checks are for user experience only.

## Initial API

- `GET /api/auth/me` — validate the Supabase access token, synchronize the app profile, and return membership/permissions or indicate onboarding is required.
- `POST /api/businesses/onboarding` — create a business and its `OWNER` membership for the authenticated, email-verified account.
- `POST /api/businesses/invitations` — invite an employee by email. The request body accepts `{ "email": "staff@example.com", "roleId": "<business-role-uuid>" }`; omitting `roleId` selects the business's default Staff role. New Auth users receive a Supabase invitation; existing Auth users receive a sign-in link.
- `POST /api/businesses/invitations/accept` — accept an invitation using `{ "token": "..." }` after Supabase sign-in and email verification.
- `DELETE /api/businesses/invitations/:invitationId` — revoke a pending invitation.
- `GET /api/businesses/roles` — list this business's roles and assignable business permissions (Owner only).
- `POST /api/businesses/roles`, `PATCH /api/businesses/roles/:roleId` — create roles or edit role names, descriptions, and permission sets. Each change requires an audit reason.
- `POST /api/businesses/roles/:roleId/archive` and `/restore` — archive or restore a role with an audit reason.
- `PATCH /api/businesses/members/:membershipId/role` — assign an active business role to a non-owner member.
- `GET /api/businesses/activity` — paginated business activity for members, invitations, roles, and permissions. Supports `page`, `pageSize`, `search` (actor, action, reason, or target), `action`, `from`/`to` (`YYYY-MM-DD`), and `sort` (`newest` or `oldest`).
- `GET /api/admin/audit-logs` — paginated platform audit log. Supports `page`, `pageSize`, `search` (actor, business, action, reason, or target), `action`, `from`/`to` (`YYYY-MM-DD`), and `sort` (`newest` or `oldest`).

All protected endpoints require `Authorization: Bearer <supabase-access-token>`. The invitation callback must preserve the `invitation_token` query parameter and send its value to the acceptance endpoint after Supabase has established the session.
