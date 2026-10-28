# API notes

All routes use `/api`. Protected routes require the authenticated session and
enforce roles and ownership on the server.

## Unique field conflicts

Known unique conflicts return HTTP 409 with a generic field message, for
example `{ "error": "Serial number already exists.", "fieldErrors": {
"serialNumber": "Serial number already exists." } }`. Supported fields are
`serialNumber`, `macAddress`, `sapId`, and `email`. Responses never include
the value or identity of the record that caused the conflict. The current
baseline migrations do not make email unique; an email field error is returned
if the deployed schema enforces email uniqueness.

## Laptop keys

`POST /employee/requests` accepts `multipart/form-data` fields including
`operatingSystem` (`Windows` or `macOS`), optional `windowsKey`, optional
`officeKey`, optional `msOfficeAccountEmail`, and the required invoice file.
An MS Office account email is required whenever an MS Office key is entered;
it is validated, trimmed, and stored in lowercase. `windowsKey` is rejected
for macOS. `PATCH /engineer/requests/:requestId` and the correction endpoints
accept the same typed key and `msOfficeAccountEmail` fields in JSON; a value
of `null` clears a saved key. An Engineer cannot change a Windows device to macOS while its Windows
key remains saved. Clients may show only key-presence flags, type-specific
duplicate warnings, and the literal `Legacy key` label for old generic keys.
Each optional Windows or MS Office key must contain 25 letters or digits,
continuously or in five groups of five separated by hyphens. The server
removes hyphens and uppercases the value before encryption and HMAC
fingerprinting, so either form identifies the same key.
Plaintext keys, ciphertext, and fingerprints are never returned by normal
request or report responses.

## Engineer registration on behalf

`GET /engineer/employees/search?sapId=XXXXXXXX` searches active employee
profiles by SAP ID. `POST /engineer/requests/register` accepts multipart
laptop and invoice fields plus `employeeSapId`. The employee is the owner,
while the Engineer is recorded as creator and audit event
`registered_on_behalf` is written. The registering Engineer cannot approve
that request at Engineer review, including after corrections; another
Engineer must approve it. Admins can only approve after Engineer review.
Final approval requires an `ENGINEER_APPROVED` history event and writes the
`ADMIN_APPROVED` event in the same transaction as the final status change.

## Retirement clearance

`POST /admin/retirement-clearances` requires `{ "sapId": "…", "reason":
"Retirement|Transfer|Resignation" }`. The same reason is required if an older
clearance has no recorded reason before `POST
/admin/retirement-clearances/:clearanceId/clear`. The API exposes only the
mandatory `company_software_removal` and `antivirus_removal` checks.

## Admin account profiles

`POST /admin/accounts` requires name, designation, category, and department
for every role. It creates the user and their profile in one transaction.
`PATCH /admin/accounts/:userId/profile` is Admin-only and creates a missing
profile or updates an existing one in one transaction with an audit entry.
Each user can have at most one profile; profile SAP ID and email stay synced
with the user account. Category values are `Workman`, `Executive`, and `JO`;
the interface and Excel export display `JO` as `JO (Junior Officer)`.

## Reports

`GET /admin/reports/export.xlsx` applies the same filters as the paginated
report endpoint and exports all matching rows. Key columns contain Yes/No and
type-specific duplicate results; legacy key presence is labeled separately.
The workbook never contains key values, encrypted values, HMACs, invoice
metadata, or private storage names. Export activity logs the filters only.
Columns are ordered as employee details, laptop details, key presence and
duplicate checks, readable status, remarks, then creator/updater identities
and timestamps. Creator and updater display values are `Name (SAP ID)` when
the employee profile is available, `System` for SYSTEM/BOOTSTRAP actors, the
SAP ID alone when no matching employee name exists, and `Unknown (legacy)`
when historical actor data is absent. The Legacy Key column is omitted when
none of the matching export rows has a legacy key. SAP ID, serial number and
MAC cells are emitted as text; the header row is bold and frozen, with
column widths set for readability.

Laptop request rows include `createdBySapId` and `updatedBySapId` in database
exports where those trigger-maintained fields are available. The spreadsheet
includes Created By and Updated By SAP ID columns.

## Admin audit

`GET /admin/audit` is Admin-only. Role authorization is checked against the
current database account on every request. Optional filters are `sapId`,
`action`, `from` and `to` (`YYYY-MM-DD`); pagination uses `limit` (1–100) and
`offset`. The response contains the timestamp, actor (`Name (SAP ID)`, `System`,
SAP ID alone, or `Unknown (legacy)`), readable action label, affected record,
safe change summary, and pagination metadata. Old audit rows without field
values show changed field names when available. Secret values, tokens, OTPs,
license key values, ciphertext and HMAC fingerprints are excluded.

`GET /admin/audit/export.xlsx` applies the same filters and exports every
matching audit entry. Export activity is recorded as `audit_exported`, with
the filters only. The Audit interface is read-only; there are no update or
delete endpoints.

New laptop edits record old and new values for ordinary edited fields in the
same transaction as the update and audit row. License key changes record only
`changed`. This covers Engineer edits, Employee corrections, Engineer
corrections, register-on-behalf submissions, account profile edits, and
account role/activation/profile changes.
