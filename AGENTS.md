# AGENTS.md: Rules for NMDC Laptop Management System

## Read first
- docs/backend-instructions.md and docs/project-instructions.md
- docs/WORKFLOW.md for status transitions and permissions
- If documents conflict, this file and docs/backend-instructions.md win.

## Tech stack
- Node.js + Express, PostgreSQL with the `pg` library and plain SQL migrations.
- Do NOT use Prisma or any ORM. Ignore Prisma mentions in older documents.
- Use modular structure: routes, controllers, services, middleware, validation.
- Do not modify the React frontend unless the task says so.

## Safety rules
- Never print or commit secrets, OTP values, employee data or .env contents.
- Use synthetic test data only.
- Use parameterized SQL only. Never build SQL from user input.
- Do not reset, drop or recreate the database.
- No destructive migrations. Before ANY database change, show the exact SQL
  and explain its effect, then wait for my approval.
- Do not return stack traces, SQL errors or sensitive data to clients.

## Security rules
- Enforce authentication, role checks and ownership checks on the backend
  for every protected API.
- The user's role always comes from the database, never from the client
  and never from the token alone.
- Users can never assign themselves a role.
- License keys: encrypted with AES-256-GCM, plus a separate HMAC fingerprint
  for duplicate detection. Never stored or logged in plaintext.
- Invoices: private storage, generated file names, content validation,
  authorized downloads only.
- Audit and approval history are append-only. Never log secrets.

## How to work
- Work on ONE module at a time.
- For each module: (1) inspect and propose a plan, (2) wait for my approval,
  (3) implement, (4) write tests, (5) run them, (6) report real results.
- Preserve existing working code. Explain before changing or deleting files.
- Explain important decisions in simple language. I am learning.
- Never claim a feature is complete unless it is implemented AND tested.
- If something is unclear, ask instead of guessing.

## Definition of done
- Code implemented, tests written and passing (show output).
- API documentation updated.
- A short summary of what changed and what remains.