# NMDC Laptop Management System — Backend Implementation Instructions

Act as a senior Node.js backend developer. Implement the backend for my NMDC Laptop Management System using the existing repository.

## 1. Technology stack
- Node.js + Express
- PostgreSQL
- Existing `pg` database layer and SQL migrations
- Reuse the current authentication and session implementation wherever possible.
- Do not introduce Prisma or replace `pg` unless I explicitly approve that change.
- Use modular routes, controllers, services, middleware and validation.

## 2. Inspect before coding
Before modifying anything:
1. Inspect the existing backend files, SQL migrations, database schema and API documentation.
2. Identify working endpoints and current authentication/session behavior.
3. Create a short implementation plan listing files to change and any database changes required.
4. Preserve existing functionality and avoid unnecessary rewrites.
5. Do not print secrets, OTP values, employee information or `.env` contents.

## 3. Authentication and authorization
- Employees log in using SAP ID and an OTP sent to their registered official email.
- Reuse the existing OTP and PostgreSQL session implementation.
- OTPs must expire, be single-use, have attempt limits and be rate-limited.
- Use secure, HttpOnly cookies in deployment, with appropriate SameSite, Secure and CSRF protections.
- Engineer and Admin accounts must be provisioned through an authorized process. Users must never assign themselves privileged roles.
- Implement authentication, role-based access control and employee ownership checks on every protected API.
- Reject unauthorized access even if someone manually calls an API.

## 4. Employee APIs
Implement or complete endpoints for:
- Creating a laptop registration.
- Viewing the employee's own registrations and request history.
- Viewing the current request status and reviewer remarks.
- Editing and resubmitting requests when correction is permitted.
- Uploading an invoice securely.

Laptop fields:
- Serial number
- Purchase date
- Model number
- MAC address
- Operating system: Windows or macOS
- Optional Microsoft license key
- Invoice file

Validate all inputs on the server. Enforce unique serial numbers and MAC addresses. Prevent employees from viewing or modifying other employees' requests.

## 5. Engineer APIs
Implement endpoints for:
- Listing requests awaiting Engineer review.
- Viewing registration details and authorized invoice downloads.
- Editing permitted fields.
- Approving or rejecting a request with mandatory remarks.
- Viewing transaction reports and duplicate Microsoft license warnings.

Engineer approval moves the request to `PENDING_ADMIN`. Engineer rejection moves it to `NEEDS_EMPLOYEE_CORRECTION`.

## 6. Admin APIs
Implement endpoints for:
- Viewing requests awaiting final review.
- Approving or rejecting engineer-approved requests.
- Managing employee, Engineer and Admin accounts with secure role restrictions.
- Viewing transaction reports and duplicate Microsoft license warnings.
- Searching employees by SAP ID for retirement/no-dues clearance.

Admin approval changes the request to `APPROVED` and locks ordinary edits. Admin rejection moves it to `NEEDS_ENGINEER_CORRECTION`.

After Admin rejection, both the Employee and Engineer may make permitted corrections. Once corrections are submitted, the request must return to Engineer verification (`PENDING_ENGINEER`). Only Engineer approval can return it to Admin review.

## 7. Microsoft license protection and duplicate detection
- Never store license keys as plaintext.
- Encrypt keys using authenticated encryption, such as AES-256-GCM, with encryption keys stored outside the database.
- Generate a keyed HMAC fingerprint using a separate server secret for duplicate detection.
- Index fingerprints but do not make them unique.
- Report every matching duplicate to both Engineer and Admin, including records that are not finally approved.
- Treat duplicates as warnings for investigation, not proof of misuse.
- Do not expose the full license key through ordinary APIs or reports.

## 8. Invoice security
- Validate file size, allowed file types and actual file content.
- Store invoices outside public static directories, using private storage.
- Use generated storage identifiers rather than trusting uploaded filenames.
- Authorize every invoice download based on role and request ownership.
- Never expose private storage paths to unauthorized users.

## 9. Retirement clearance
- Search for an employee by SAP ID.
- Track asset return, license checks and the required additional checks.
- Prevent final clearance until all mandatory checks are complete and an authorized officer records clearance.
- Record remarks, officer identity and timestamps.
- Do not assume licenses must be deleted; follow the organization's approved deactivation or reassignment policy.

## 10. Audit history and data integrity
- Record authentication/security events and important registration, approval, correction, account-management and clearance actions.
- Keep approval history append-only.
- Record the actor, action, affected record, timestamp and relevant changed-field metadata without logging secrets.
- Use database transactions for operations that update a request and create its approval/audit records together.
- Preserve existing database constraints and migrations.
- Update timestamps reliably.
- Do not permit ordinary changes after final approval.

## 11. API conventions
- Use consistent HTTP status codes and JSON responses.
- Add centralized error handling and input validation.
- Use parameterized SQL queries.
- Add pagination and filtering for request queues and reports.
- Avoid leaking stack traces, SQL details or sensitive data to clients.
- Update API documentation with endpoint methods, request bodies, responses, roles and error cases.

## 12. Testing
Write or update automated tests for:
- OTP expiry, attempts, replay and rate limiting.
- Login/session handling and role authorization.
- Employee ownership restrictions.
- Registration validation and duplicate serial/MAC handling.
- Engineer approval and rejection.
- Admin rejection, corrections and Engineer re-verification.
- Final approval locking.
- Duplicate license detection and sensitive-data protection.
- Invoice access restrictions.
- Retirement clearance requirements.
- Audit history and transactional consistency.

Use synthetic test data only.

## 13. Implementation rules
- Work incrementally and explain important changes in simple language.
- First inspect and propose the backend implementation plan.
- Implement one logical module at a time.
- Run available tests after each module and report actual results.
- Do not modify the React frontend in this task.
- Do not reset, drop or recreate the database.
- Do not apply destructive migrations.
- Before any database modification, show me the exact SQL and explain its effect.
- Never claim a feature is complete unless it has been implemented and tested.

Start by inspecting the existing backend and presenting the implementation plan. Wait for my approval before making changes.