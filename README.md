# Backend setup

## Supabase configuration

1. In Supabase **Authentication → Providers**, enable Google and Email as needed. Configure the Google OAuth callback shown by Supabase in the Google Cloud OAuth client.
2. In **Authentication → URL Configuration**, add the frontend callback URL (for local development, `http://localhost:5173/auth/callback`) to the allowed redirect URLs.
3. Configure SMTP under **Authentication → SMTP Settings** before relying on confirmation, password-reset, or invitation email delivery.
4. Copy `.env.example` to `.env`. For a local network without IPv6, open **Connect** in the Supabase Dashboard, select **Session pooler**, and copy its connection string into both `DATABASE_URL` and `DIRECT_URL`. Keep the username, hostname, and port exactly as provided by Supabase; the pooler host is region-specific. If the database password contains reserved URI characters, URL-encode them. Use a direct connection only when the environment has IPv6 connectivity or the project has the IPv4 add-on. Set the project URL, publishable/anon key, and callback URL too. Set `SUPABASE_SERVICE_ROLE_KEY` only in this backend environment; never use it in frontend code.
5. To bootstrap a platform administrator, set `SYSTEM_ADMIN_EMAIL` to the intended account email. That verified Supabase Auth account receives `SYSTEM_ADMIN` when it first calls `GET /api/auth/me`.

Supabase Auth performs sign-up, sign-in, OAuth, email confirmation, and password reset in the frontend. The backend validates access tokens with Supabase Auth and creates/updates the corresponding application profile.

## Database migrations

The only active migration is `20261022144500_auth_rbac_invitations`. It creates the minimal business profile table required for onboarding, application user profiles linked to `auth.users`, memberships, roles/permissions, platform-role assignments, and invitations. It does not create product, inventory, sales, finance, forecasting, or other business-domain tables.

The original business-domain schema and its un-applied initial migration are preserved under `prisma/legacy/`, outside Prisma's migration path. They do not run when using `prisma migrate deploy`. The active `schema.prisma` describes only the tables for this first phase; add later domain models and migrations intentionally when implementing those features.

After reviewing the SQL and confirming the target Supabase project is the intended empty database, apply it from the backend folder with:

```powershell
npx prisma migrate deploy
```

Prisma runs the checked-in SQL and records the migration in `public._prisma_migrations`. Do not first run the SQL separately in Supabase SQL Editor. If you do apply it manually, run the exact checked-in SQL successfully and then mark that same migration as applied with `npx prisma migrate resolve --applied 20261022144500_auth_rbac_invitations`; otherwise the Prisma history will not match the database.

The migration enables Row Level Security on the new public tables and intentionally creates no client-side RLS policies. The backend connects directly to PostgreSQL and enforces access in its API; do not access these tables directly from the frontend Supabase client.

## Initial API

- `GET /api/auth/me` — validate the Supabase access token, synchronize the app profile, and return membership/permissions or indicate onboarding is required.
- `POST /api/businesses/onboarding` — create a business and its `OWNER` membership for the authenticated, email-verified account.
- `POST /api/businesses/invitations` — invite a `STAFF` account by email. The request body is `{ "email": "staff@example.com" }`. New Auth users receive a Supabase invitation; existing Auth users receive a sign-in link.
- `POST /api/businesses/invitations/accept` — accept an invitation using `{ "token": "..." }` after Supabase sign-in and email verification.
- `DELETE /api/businesses/invitations/:invitationId` — revoke a pending invitation.

All protected endpoints require `Authorization: Bearer <supabase-access-token>`. The invitation callback must preserve the `invitation_token` query parameter and send its value to the acceptance endpoint after Supabase has established the session.
