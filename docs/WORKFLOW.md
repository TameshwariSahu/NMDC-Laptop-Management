# Request Workflow and Permissions

## Roles
EMPLOYEE, ENGINEER, ADMIN. The role comes from the user's account record.

## Statuses
PENDING_ENGINEER, NEEDS_EMPLOYEE_CORRECTION, PENDING_ADMIN,
NEEDS_ENGINEER_CORRECTION, APPROVED

## Allowed transitions (anything not listed is forbidden)

| From | Action | Actor | To | Remarks |
|---|---|---|---|---|
| (new) | Submit laptop + invoice | Employee | PENDING_ENGINEER | optional |
| PENDING_ENGINEER | Approve | Engineer | PENDING_ADMIN | optional |
| PENDING_ENGINEER | Reject | Engineer | NEEDS_EMPLOYEE_CORRECTION | mandatory |
| NEEDS_EMPLOYEE_CORRECTION | Correct and resubmit | Employee | PENDING_ENGINEER | optional |
| PENDING_ADMIN | Approve | Admin | APPROVED | optional |
| PENDING_ADMIN | Reject | Admin | NEEDS_ENGINEER_CORRECTION | mandatory |
| NEEDS_ENGINEER_CORRECTION | Submit correction | Employee or Engineer | PENDING_ENGINEER | optional |

Key rules:
- After an Admin rejection, the request ALWAYS returns to the Engineer
  (PENDING_ENGINEER) before the Admin sees it again.
- After an Engineer rejection to `NEEDS_EMPLOYEE_CORRECTION`, the current
  invoice stays visible with a replacement notice. The Employee must upload
  a replacement invoice before resubmitting. Uploading a replacement replaces
  the database row in the same transaction; after commit, the old private file
  is deleted. Only the current invoice is available to any role.
- Only Engineer approval can move a request to PENDING_ADMIN.
- APPROVED locks ordinary edits. Exceptional changes need an authorized,
  audited process (to be defined).
- Engineer edits to permitted laptop fields while `PENDING_ENGINEER` require
  mandatory remarks. The edit remarks and changed field names are audited;
  license-key values are never included in audit data.
- Rejections by Engineer or Admin require remarks. Approval remarks are
  optional.
- MAC addresses accept exactly 12 hexadecimal characters, either continuous
  or separated into six colon-delimited pairs. Colons are stripped and the
  stored value is uppercase. Other separators are invalid.
- Windows devices may have an optional Windows key and optional MS Office
  key. macOS devices may have an optional MS Office key only. Both key types
  are encrypted separately and duplicate checks compare Windows with Windows
  and Office with Office. New requests do not write the old generic key
  columns; existing values in those columns appear only as `Legacy key`.
- Retirement clearance requires a reason (Retirement, Transfer, or
  Resignation) at creation and before final approval.
- Laptop requests record the acting user's SAP ID as creator and last updater
  through the database trigger using the transaction-local
  `app.actor_sap_id` setting.
- Every transition runs in ONE database transaction that updates the request
  and inserts the approval history and audit records together.

## Who can do what, by status

| Status | Employee (owner) | Engineer | Admin |
|---|---|---|---|
| PENDING_ENGINEER | view only | view, edit permitted fields, approve/reject | view |
| NEEDS_EMPLOYEE_CORRECTION | edit and resubmit | view | view |
| PENDING_ADMIN | view only | view | approve/reject |
| NEEDS_ENGINEER_CORRECTION | edit and resubmit | edit and resubmit | view |
| APPROVED | view only | view only | view only |

An Employee can only see their own requests.

## Other flows (from the diagram)
- Engineer and Admin: view transaction reports with duplicate MS-key warnings.
- Admin: manage employee, engineer and admin accounts.
- Admin: retirement clearance. Search by SAP ID and complete the two mandatory
  checks: remove company-installed software and remove antivirus. If either is
  incomplete, clearance is BLOCKED. Otherwise an authorized officer records
  clearance.
- Login: SAP ID + email OTP for all roles. The role is read from the
  database; the login screen's role selector must never decide privileges.

## Open decisions (fill these in)
- Which fields can the Engineer edit? Serial number, purchase date, model number, MAC address, operating system, optional Microsoft license key and invoice; only in the statuses shown in the permissions table.
- Which fields can the Employee edit during correction? Serial number, purchase date, model number, MAC address, operating system, optional Microsoft license key and invoice; only in the correction statuses shown in the permissions table.
- Can an Employee have more than one laptop? ______
- Is a serial or MAC still "taken" after a rejected request? ______
- Who authorizes exceptional edits after APPROVED? ______
