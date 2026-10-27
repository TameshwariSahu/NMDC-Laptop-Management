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

The migrations create the user, session, audit, laptop-request, approval-history and invoice-metadata tables. Migration `005` enforces exactly one invoice row per request. Migration `006` normalizes SAP IDs to uppercase and enforces exactly 8 characters in `users` and `employees`; migration `007` normalizes stored MAC addresses and updates blocked clearance checklists. Existing SAP IDs that are not 8 characters after trimming prevent migration until corrected. The migration runner records each migration and its SHA-256 checksum in `schema_migrations`. If the original schema from migration `001` already exists without tracking records, the runner validates the expected tables, columns, and enum types, then records `001` as applied without running it again. A partial initial schema causes the runner to stop. Create accounts through a trusted admin provisioning process. The demo seed command below uses synthetic `.invalid` email addresses only.

SAP IDs are trimmed and stored in uppercase. They must contain exactly 8 characters. Login, account creation, bootstrap and SAP ID searches apply the same normalization and length validation. MAC addresses accept exactly 12 hexadecimal characters, with or without colons, and are stored uppercase without colons.

`audit_log` permits nullable actor IDs for system events such as unknown-SAP-ID login attempts. Actor SAP IDs are snapshots rather than foreign keys, so deleting a user does not remove audit identity. Database triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` operations on that table.

### First Admin bootstrap

If there is no active Admin, the one-time bootstrap command creates the Admin user, required employee profile and `BOOTSTRAP` audit entry in one transaction. It refuses to proceed if an active Admin already exists. SAP ID, name, official email, designation, employee category and department must be supplied as command arguments or with `BOOTSTRAP_ADMIN_SAP_ID`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_DESIGNATION`, `BOOTSTRAP_ADMIN_EMPLOYEE_CATEGORY` and `BOOTSTRAP_ADMIN_DEPARTMENT`. The command does not print the email or an OTP.

Run from `server/` only after an authorized operator has reviewed the account details:

```sh
npm run admin:bootstrap -- --sap-id "<SAP_ID>" --name "<FULL_NAME>" --email "<OFFICIAL_EMAIL>" --designation "<DESIGNATION>" --employee-category Executive --department "<DEPARTMENT>"
```

The account signs in using the usual SAP ID and email OTP. Do not use this command for ordinary account creation; after bootstrap, use the protected Admin account API.

Run the automated backend tests with `npm test` from this folder. The migration runner unit tests use a fake PostgreSQL client. To run the PostgreSQL integration tests, use `npm run test:integration`; that command creates uniquely named test databases through the `postgres` maintenance database, runs migrations only against those databases, and leaves them available for inspection. It never connects to the configured application database. The PostgreSQL account needs `CREATEDB` permission.

For local development without SMTP, set `AUTH_EXPOSE_OTP=true` and `NODE_ENV=development`; the OTP is printed to the API terminal. Do not enable this in production.

## Employee laptop requests

Set `LICENSE_ENCRYPTION_KEY` and `LICENSE_HMAC_KEY` to separate 32-byte keys, each encoded as 64 hex characters or base64. The optional private invoice directory defaults to `server/private-invoices`; it is not served as static content. Invoice uploads accept PDF, JPEG and PNG, verify the file signature, and enforce a 5 MB maximum.

To create the synthetic demo employee, engineer and admin accounts after applying migrations:

```sh
npm run db:seed:demo
```

The seed creates `DEMP0001`, `DENG0001`, and `DADM0001` using `example.invalid` emails. OTP delivery still requires SMTP or the development-only OTP option above.

- `POST /api/employee/requests` — employee bearer token plus `multipart/form-data`: `serialNumber`, `purchaseDate` (`YYYY-MM-DD`), `modelNumber`, `macAddress`, `operatingSystem` (`Windows` or `macOS`), optional `licenseKey`, and required `invoice` file.
- `POST /api/employee/requests/:requestId/invoice` — attach a replacement invoice to the employee's own request during an allowed correction. Uses `multipart/form-data` with an `invoice` file.
- `GET /api/employee/requests` — returns only the logged-in employee's requests, status, approval remarks/history, current invoice metadata, and `needsInvoiceReplacement` when an Engineer rejection requires a new invoice.

## Review workflow

Workflow endpoints use the active role read from PostgreSQL and require `expectedVersion` for every edit or transition. A stale version returns `409 Conflict`; reload the request and retry. Approval remarks are optional, rejection remarks are required, and Engineer edits require remarks.

- `GET /api/engineer/requests?limit=25&offset=0` — paginated `PENDING_ENGINEER` queue. `GET /api/engineer/requests/:requestId` returns details, history and invoice metadata without license-key material.
- `PATCH /api/engineer/requests/:requestId` — edit permitted laptop fields while `PENDING_ENGINEER`; JSON body contains `expectedVersion` and one or more of `serialNumber`, `purchaseDate`, `modelNumber`, `macAddress`, `operatingSystem`, `licenseKey`.
- `POST /api/engineer/requests/:requestId/decision` — JSON `{ "expectedVersion": 1, "action": "approve|reject", "remarks": "..." }`; remarks may be omitted for approval and are required for rejection.
- `GET /api/admin/requests?limit=25&offset=0` and `GET /api/admin/requests/:requestId` — paginated `PENDING_ADMIN` queue and details.
- `POST /api/admin/requests/:requestId/decision` — same decision body; remarks may be omitted for approval and are required for rejection. Admin approval moves the request to `APPROVED`.
- `POST /api/employee/requests/:requestId/corrections` — employee resubmission from `NEEDS_EMPLOYEE_CORRECTION`, or employee correction from `NEEDS_ENGINEER_CORRECTION`.
- `POST /api/engineer/requests/:requestId/corrections` — engineer correction from `NEEDS_ENGINEER_CORRECTION`.
- `POST /api/employee/requests/:requestId/invoice` or `POST /api/engineer/requests/:requestId/invoice` — attach a revised invoice using multipart form data with `expectedVersion` and `invoice`. Employee and engineer access is limited by request status and ownership/role. Replacement inserts the new invoice and deletes prior invoice rows in one transaction, writes an `invoice_replaced` audit entry without file names or contents, then deletes old private files after commit.
- `GET /api/invoices/:fileId/download` — private invoice download for the owning employee, engineer, or admin; storage keys are never returned. Only the current invoice exists and is downloadable. The response MIME type and filename extension match the stored invoice type.

Each status transition updates the request version and inserts approval history and audit rows in one database transaction. Engineer edits that do not change status update the version and audit log in one transaction.

The employee feature middleware looks up the active account and role in PostgreSQL on each request. License keys are encrypted with AES-256-GCM; a separate HMAC key produces the indexed duplicate fingerprint. Neither key is returned by the employee API.

## Reports, accounts and retirement clearance

- `GET /api/engineer/reports` and `GET /api/admin/reports` — paginated report list. Optional filters: `limit`, `offset`, `status`, `sapId`, `from`, `to`, and `duplicateOnly=true`. Duplicate warnings compare the private HMAC fingerprint; neither fingerprint nor license value is returned.
- `GET /api/admin/accounts?limit=50&offset=0&q=...` — account list. `POST /api/admin/accounts` creates `{sapId,email,role}`. For `role: "employee"`, also provide `employeeName`, `designation`, `employeeCategory` (`Workman` or `Executive`) and `department`; the employee profile is created in the same transaction. Engineer and Admin entries without employee profiles display their SAP ID in the Person column instead of their email. `PATCH /api/admin/accounts/:userId` accepts `role` and/or `isActive`, plus employee-profile fields when applicable. Self demotion/deactivation and removal of the last active Admin return `409`. Account changes are audited.
- `GET /api/admin/retirement-clearances?sapId=...` — employee clearance history and checklist.
- `POST /api/admin/retirement-clearances` — create a clearance with `{sapId, remarks?}`. It creates exactly two mandatory checks: remove company-installed software and remove antivirus. Additional checks are not accepted.
- `PATCH /api/admin/retirement-clearances/:clearanceId/checks/:checkId` — set `{isComplete,remarks?}`. Check changes are audited with changed field names. Mandatory checks cannot be deleted. Check rows and clearance records lock after final clearance.
- `POST /api/admin/retirement-clearances/:clearanceId/clear` — finalize with required officer `{remarks}`. The database requires at least one mandatory check and all mandatory checks complete; the database locks checklist rows while checking finalization to serialize concurrent updates.

## Auth routes

- `POST /api/auth/request-otp` — JSON `{ "sapId": "..." }`; sends a six-digit, expiring OTP only to an active account. Unknown and deactivated accounts return `Account does not exist. Please contact the admin.`; neither receives an OTP.
- `POST /api/auth/verify-otp` — JSON `{ "sapId": "...", "otp": "123456" }`; consumes the OTP and returns an eight-hour bearer token plus the database-assigned role and profile.
- `GET /api/auth/me` — requires `Authorization: Bearer <token>`; returns the active account/profile.
- `GET /api/health` — liveness check.

Roles are `employee`, `engineer`, and `admin`. The laptop request routes check active account roles from PostgreSQL for each request.
