CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('employee', 'engineer', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE employee_category AS ENUM ('Workman', 'Executive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sap_id VARCHAR(40) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL,
  role user_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_sap_id_nonempty CHECK (length(trim(sap_id)) > 0),
  CONSTRAINT users_email_nonempty CHECK (length(trim(email)) > 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_sap_id_case_insensitive_idx ON users (upper(sap_id));

CREATE TABLE IF NOT EXISTS employees (
  employee_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  sap_id VARCHAR(40) NOT NULL UNIQUE,
  employee_name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL,
  designation VARCHAR(120) NOT NULL,
  employee_category employee_category NOT NULL,
  department VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employees_name_nonempty CHECK (length(trim(employee_name)) > 0),
  CONSTRAINT employees_sap_id_matches_user UNIQUE (user_id, sap_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_sap_id_case_insensitive_idx ON employees (upper(sap_id));

CREATE INDEX IF NOT EXISTS employees_department_idx ON employees(department);

CREATE OR REPLACE FUNCTION ensure_employee_role() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.user_id AND role = 'employee') THEN
    RAISE EXCEPTION 'Employee profile must reference a user with employee role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_require_employee_role ON employees;
CREATE TRIGGER employees_require_employee_role
BEFORE INSERT OR UPDATE OF user_id ON employees
FOR EACH ROW EXECUTE FUNCTION ensure_employee_role();

CREATE TABLE IF NOT EXISTS login_otps (
  otp_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  otp_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_otps_user_created_idx ON login_otps(user_id, created_at DESC);

-- Keep the account and employee contact identifiers synchronized.
CREATE OR REPLACE FUNCTION sync_employee_user_fields() RETURNS TRIGGER AS $$
BEGIN
  UPDATE users SET sap_id = NEW.sap_id, email = NEW.email, updated_at = NOW()
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_sync_user_fields ON employees;
CREATE TRIGGER employees_sync_user_fields
AFTER INSERT OR UPDATE OF sap_id, email ON employees
FOR EACH ROW EXECUTE FUNCTION sync_employee_user_fields();
