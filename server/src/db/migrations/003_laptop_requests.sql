CREATE TYPE laptop_request_status AS ENUM (
    'PENDING_ENGINEER',
    'NEEDS_EMPLOYEE_CORRECTION',
    'PENDING_ADMIN',
    'NEEDS_ENGINEER_CORRECTION',
    'APPROVED'
);

CREATE TYPE laptop_operating_system AS ENUM (
    'Windows',
    'macOS'
);

CREATE TABLE laptop_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_employee_id UUID NOT NULL
        REFERENCES employees(employee_id) ON DELETE RESTRICT,

    serial_number VARCHAR(255) NOT NULL,
    purchase_date DATE NOT NULL,
    model_number VARCHAR(255) NOT NULL,
    mac_address VARCHAR(17) NOT NULL,
    operating_system laptop_operating_system NOT NULL,

    license_key_ciphertext BYTEA,
    license_key_nonce BYTEA,
    license_key_auth_tag BYTEA,
    license_key_hmac BYTEA,

    status laptop_request_status NOT NULL DEFAULT 'PENDING_ENGINEER',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT laptop_requests_mac_format
        CHECK (mac_address ~* '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),

    CONSTRAINT laptop_requests_license_key_parts
        CHECK (
            (license_key_ciphertext IS NULL
             AND license_key_nonce IS NULL
             AND license_key_auth_tag IS NULL
             AND license_key_hmac IS NULL)
            OR
            (license_key_ciphertext IS NOT NULL
             AND license_key_nonce IS NOT NULL
             AND license_key_auth_tag IS NOT NULL
             AND license_key_hmac IS NOT NULL)
        )
);

CREATE UNIQUE INDEX laptop_requests_serial_number_unique
    ON laptop_requests (UPPER(BTRIM(serial_number)));

CREATE UNIQUE INDEX laptop_requests_mac_address_unique
    ON laptop_requests (UPPER(BTRIM(mac_address)));

CREATE INDEX laptop_requests_license_key_hmac_idx
    ON laptop_requests (license_key_hmac)
    WHERE license_key_hmac IS NOT NULL;

CREATE INDEX laptop_requests_owner_created_idx
    ON laptop_requests (owner_employee_id, created_at DESC);

CREATE INDEX laptop_requests_status_created_idx
    ON laptop_requests (status, created_at);

CREATE FUNCTION set_laptop_request_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER laptop_requests_set_updated_at
BEFORE UPDATE ON laptop_requests
FOR EACH ROW
EXECUTE FUNCTION set_laptop_request_updated_at();

CREATE FUNCTION prevent_approved_laptop_request_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'APPROVED' THEN
        RAISE EXCEPTION 'approved laptop requests cannot be updated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER laptop_requests_lock_approved
BEFORE UPDATE ON laptop_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_approved_laptop_request_update();


CREATE TABLE approval_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL
        REFERENCES laptop_requests(request_id) ON DELETE RESTRICT,

    actor_user_id UUID,
    actor_sap_id VARCHAR(40),
    action VARCHAR(80) NOT NULL,
    remarks TEXT,
    old_status laptop_request_status,
    new_status laptop_request_status NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX approval_history_request_created_idx
    ON approval_history (request_id, created_at);

CREATE FUNCTION prevent_approval_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'approval_history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_history_no_update_delete
BEFORE UPDATE OR DELETE ON approval_history
FOR EACH ROW
EXECUTE FUNCTION prevent_approval_history_mutation();

CREATE TRIGGER approval_history_no_truncate
BEFORE TRUNCATE ON approval_history
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_approval_history_mutation();


CREATE TABLE request_invoices (
    file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL
        REFERENCES laptop_requests(request_id) ON DELETE RESTRICT,

    storage_key VARCHAR(255) NOT NULL UNIQUE,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    sha256 BYTEA NOT NULL,
    uploaded_by_user_id UUID
        REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX request_invoices_request_created_idx
    ON request_invoices (request_id, created_at);
