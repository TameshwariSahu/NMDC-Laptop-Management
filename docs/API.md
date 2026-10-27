# API notes

All routes use `/api`. Protected routes require the authenticated session and
enforce roles and ownership on the server.

## Laptop keys

`POST /employee/requests` accepts `multipart/form-data` fields including
`operatingSystem` (`Windows` or `macOS`), optional `windowsKey`, optional
`officeKey`, and the required invoice file. `windowsKey` is rejected for
macOS. `PATCH /engineer/requests/:requestId` and the correction endpoints
accept the same typed key fields in JSON; a value of `null` clears a saved
key. An Engineer cannot change a Windows device to macOS while its Windows
key remains saved. Clients may show only key-presence flags, type-specific
duplicate warnings, and the literal `Legacy key` label for old generic keys.
Plaintext keys, ciphertext, and fingerprints are never returned by normal
request or report responses.

## Retirement clearance

`POST /admin/retirement-clearances` requires `{ "sapId": "…", "reason":
"Retirement|Transfer|Resignation" }`. The same reason is required if an older
clearance has no recorded reason before `POST
/admin/retirement-clearances/:clearanceId/clear`. The API exposes only the
mandatory `company_software_removal` and `antivirus_removal` checks.

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
