-- The migration runner executes this file within a single transaction.

SELECT
  set_config('app.actor_user_id', '', TRUE),
  set_config('app.actor_sap_id', 'SYSTEM', TRUE);

ALTER TABLE laptop_requests
  DROP CONSTRAINT laptop_requests_mac_format;

ALTER TABLE laptop_requests
  DISABLE TRIGGER laptop_requests_lock_approved;

UPDATE laptop_requests
SET mac_address = UPPER(REPLACE(mac_address, ':', ''));

ALTER TABLE laptop_requests
  ENABLE TRIGGER laptop_requests_lock_approved;

INSERT INTO audit_log (
  actor_user_id,
  actor_sap_id,
  action,
  entity_type,
  entity_id,
  details
)
VALUES (
  NULL,
  'SYSTEM',
  'migration_007_mac_normalized',
  'schema_migration',
  '007',
  '{"operation":"normalize_mac_address"}'::jsonb
);

ALTER TABLE laptop_requests
  ALTER COLUMN mac_address TYPE VARCHAR(12);

ALTER TABLE laptop_requests
  ADD CONSTRAINT laptop_requests_mac_format
  CHECK (mac_address ~ '^[0-9A-F]{12}$');

UPDATE retirement_clearance_checks AS checks
SET is_mandatory = FALSE
FROM retirement_clearances AS clearances
WHERE checks.clearance_id = clearances.clearance_id
  AND clearances.status = 'BLOCKED'
  AND checks.is_mandatory IS DISTINCT FROM FALSE;

INSERT INTO retirement_clearance_checks
  (clearance_id, check_key, check_label, is_mandatory)
SELECT clearances.clearance_id, required.check_key, required.check_label, TRUE
FROM retirement_clearances AS clearances
CROSS JOIN (
  VALUES
    ('company_software_removal', 'Remove company-installed software'),
    ('antivirus_removal', 'Remove antivirus')
) AS required(check_key, check_label)
WHERE clearances.status = 'BLOCKED'
  AND NOT EXISTS (
    SELECT 1
    FROM retirement_clearance_checks AS existing
    WHERE existing.clearance_id = clearances.clearance_id
      AND existing.check_key = required.check_key
  );

