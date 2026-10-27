# NMDC Laptop Management System — Project Instructions

Act as a senior full-stack developer and help me build a secure, maintainable Laptop Management System for an organization.

## 1. Technology stack
- Frontend: React
- Backend: Node.js + Express
- Database: PostgreSQL
- ORM: Prisma
- Authentication: SAP ID + OTP sent to the employee's registered email
- Use a clean, modular, maintainable project structure.

## 2. User roles

**Employee**
- Log in using SAP ID and email OTP.
- Submit laptop details and upload an invoice.
- View request status and engineer/admin remarks.
- Correct and resubmit returned requests.

**Engineer**
- View pending laptop requests.
- Review laptop details and invoices.
- Edit permitted details, approve with optional remarks, or reject with mandatory remarks.
- View transaction reports and duplicate MS-key warnings.

**Admin**
- Manage employee, engineer and admin accounts.
- Review engineer-approved requests and give final approval with optional remarks or rejection with mandatory remarks.
- View transaction reports and duplicate MS-key warnings.
- Manage employee retirement/no-dues clearance.

## 3. Employee and laptop information

Employee fields: SAP ID, name, official email, designation, category (Workman/Executive) and department.

Laptop fields: serial number, purchase date, model number, MAC address, operating system (Windows/macOS), optional MS license key and invoice.

## 4. Approval workflow
- Employee submits a request → Engineer reviews it.
- Engineer rejection → Employee corrects and resubmits.
- Engineer approval → Admin performs final review.
- Admin rejection → Both Employee and Engineer must be able to correct permitted fields. The request must return to Engineer verification before going to Admin again.
- Admin final approval → Lock ordinary edits. Any exceptional change must follow an authorized, audited process.
- Keep a complete history of decisions, remarks, actors and timestamps.

## 5. Security requirements
- Enforce role-based permissions on the backend, not just the UI.
- Use expiring, rate-limited OTPs with attempt limits and secure verification.
- Protect invoice files and restrict access to authorized users.
- Encrypt stored MS license keys and use a server-secret HMAC fingerprint for duplicate detection.
- Highlight all matching duplicate keys in Engineer and Admin reports. Do not treat a duplicate match alone as proof of misuse.
- Keep secrets in environment variables; never commit credentials or real organizational data.
- Add audit logs and validate all inputs.

## 6. Retirement clearance
Allow Admin to find an employee by SAP ID and track removal of company-installed software and antivirus. Clearance must remain blocked until both mandatory checks are complete and an authorized officer records clearance. Keep license deactivation/reassignment consistent with the organization's actual policy.

## 7. How I want you to work
I am learning full-stack development, so explain important decisions in simple language.

**Work in stages. Do not generate the entire application at once.**

### Stage 0 — Planning only
1. Inspect the existing repository and identify its current structure and setup.
2. Propose the architecture, folder structure, Prisma/PostgreSQL schema, API endpoints, permissions matrix and request-status transitions.
3. Identify security risks, validation rules and missing business requirements.
4. Explain important design choices and list assumptions that need confirmation.
5. Do not modify files or start implementation yet. Present the plan and wait for my approval.

After I approve, implement one stage at a time:
- Stage 1: Database schema, Prisma migrations and backend foundation.
- Stage 2: Authentication, OTP and role-based APIs.
- Stage 3: Employee, Engineer and Admin interfaces.
- Stage 4: Approval workflow, reports, duplicate detection and retirement clearance.
- Stage 5: Automated tests, security checks, setup instructions and documentation.

Before each stage, state the intended changes. After each stage, run available tests and report what passed, failed or remains incomplete. Do not claim functionality works unless you have verified it.

Preserve existing working code unless a change is necessary. Never overwrite or delete existing files without explaining why. Use synthetic sample data only.

Start with Stage 0 and wait for my approval.
