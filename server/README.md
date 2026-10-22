# Backend API

Express API and PostgreSQL database for the Laptop Management System.

## Setup

1. Copy `.env.example` to the workspace root as `.env` (or to `server/.env`); set `DATABASE_URL`, a random `JWT_SECRET` of at least 32 characters, and SMTP credentials. The PostgreSQL account in the URL needs permission to create a database for the next step.
2. Install dependencies, create the PostgreSQL database named in `DATABASE_URL`, and apply the schema:

   ```sh
   npm install
   npm run db:create
   npm run db:migrate
   npm run dev
   ```

The migration creates `users`, `employees`, and `login_otps`. Create accounts through a trusted admin provisioning process: insert a `users` row with role `employee`, `engineer`, or `admin`; for employees, also insert the corresponding `employees` profile. Never expose unrestricted account creation publicly. SAP IDs are stored as unique account identifiers; email OTPs go only to the account's registered email.

For local development without SMTP, set `AUTH_EXPOSE_OTP=true` and `NODE_ENV=development`; the OTP is printed to the API terminal. Do not enable this in production.

## Auth routes

- `POST /api/auth/request-otp` — JSON `{ "sapId": "..." }`; sends a six-digit, expiring OTP to the account email. The response does not disclose whether the SAP ID exists.
- `POST /api/auth/verify-otp` — JSON `{ "sapId": "...", "otp": "123456" }`; consumes the OTP and returns an eight-hour bearer token plus the database-assigned role and profile.
- `GET /api/auth/me` — requires `Authorization: Bearer <token>`; returns the active account/profile.
- `GET /api/health` — liveness check.

Roles are `employee`, `engineer`, and `admin`. Add role authorization to protected feature routes with the `requireRole` middleware.
