CREATE TYPE retirement_clearance_status AS ENUM (
    'BLOCKED',
    'CLEARED'
);

CREATE TABLE retirement_clearances (
    clearance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL
        REFERENCES employees(employee_id) ON DELETE RESTRICT,

    status retirement_clearance_status NOT NULL DEFAULT 'BLOCKED',

    created_by_user_id UUID
        REFERENCES users(user_id) ON DELETE SET NULL,
    created_by_sap_id VARCHAR(40) NOT NULL,

    officer_user_id UUID
        REFERENCES users(user_id) ON DELETE SET NULL,
    officer_sap_id VARCHAR(40),

    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleared_at TIMESTAMPTZ,

    CONSTRAINT retirement_clearances_creator_sap_nonempty
        CHECK (length(trim(created_by_sap_id)) > 0),

    CONSTRAINT retirement_clearances_final_state_fields
        CHECK (
            (status = 'BLOCKED'
             AND officer_sap_id IS NULL
             AND cleared_at IS NULL)
            OR
            (status = 'CLEARED'
             AND officer_sap_id IS NOT NULL
             AND length(trim(officer_sap_id)) > 0
             AND cleared_at IS NOT NULL)
        )
);

CREATE UNIQUE INDEX retirement_clearances_one_blocked_per_employee
    ON retirement_clearances (employee_id)
    WHERE status = 'BLOCKED';

CREATE INDEX retirement_clearances_employee_created_idx
    ON retirement_clearances (employee_id, created_at DESC);


CREATE TABLE retirement_clearance_checks (
    check_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clearance_id UUID NOT NULL
        REFERENCES retirement_clearances(clearance_id) ON DELETE RESTRICT,

    check_key VARCHAR(80) NOT NULL,
    check_label VARCHAR(255) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    is_complete BOOLEAN NOT NULL DEFAULT FALSE,

    checked_by_user_id UUID
        REFERENCES users(user_id) ON DELETE SET NULL,
    checked_by_sap_id VARCHAR(40),
    checked_at TIMESTAMPTZ,
    remarks TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT retirement_clearance_checks_key_nonempty
        CHECK (length(trim(check_key)) > 0),

    CONSTRAINT retirement_clearance_checks_label_nonempty
        CHECK (length(trim(check_label)) > 0),

    CONSTRAINT retirement_clearance_checks_unique_key
        UNIQUE (clearance_id, check_key),

    CONSTRAINT retirement_clearance_checks_completion_fields
        CHECK (
            (is_complete
             AND checked_by_sap_id IS NOT NULL
             AND length(trim(checked_by_sap_id)) > 0
             AND checked_at IS NOT NULL)
            OR
            (NOT is_complete
             AND checked_by_user_id IS NULL
             AND checked_by_sap_id IS NULL
             AND checked_at IS NULL)
        )
);

CREATE INDEX retirement_clearance_checks_required_status_idx
    ON retirement_clearance_checks (clearance_id, is_mandatory, is_complete);


CREATE FUNCTION guard_retirement_clearance_finalization()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = 'CLEARED' THEN
        RAISE EXCEPTION 'cleared retirement clearances are locked';
    END IF;

    IF NEW.status = 'CLEARED' THEN
        PERFORM check_id
        FROM retirement_clearance_checks
        WHERE clearance_id = NEW.clearance_id
        FOR SHARE;

        IF NOT EXISTS (
            SELECT 1
            FROM retirement_clearance_checks
            WHERE clearance_id = NEW.clearance_id
              AND is_mandatory = TRUE
        ) OR EXISTS (
            SELECT 1
            FROM retirement_clearance_checks
            WHERE clearance_id = NEW.clearance_id
              AND is_mandatory = TRUE
              AND is_complete = FALSE
        ) THEN
            RAISE EXCEPTION 'all mandatory retirement checks must be complete';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retirement_clearances_guard_finalization
BEFORE INSERT OR UPDATE ON retirement_clearances
FOR EACH ROW
EXECUTE FUNCTION guard_retirement_clearance_finalization();


CREATE FUNCTION guard_retirement_clearance_check_changes()
RETURNS TRIGGER AS $$
DECLARE
    target_clearance_id UUID;
    parent_status retirement_clearance_status;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_clearance_id = OLD.clearance_id;
    ELSE
        target_clearance_id = NEW.clearance_id;
    END IF;

    SELECT status INTO parent_status
    FROM retirement_clearances
    WHERE clearance_id = target_clearance_id
    FOR UPDATE;

    IF parent_status = 'CLEARED' THEN
        RAISE EXCEPTION 'checks for a cleared retirement clearance are locked';
    END IF;

    IF TG_OP = 'DELETE' AND OLD.is_mandatory THEN
        RAISE EXCEPTION 'mandatory retirement checks cannot be deleted';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retirement_clearance_checks_guard_changes
BEFORE INSERT OR UPDATE OR DELETE ON retirement_clearance_checks
FOR EACH ROW
EXECUTE FUNCTION guard_retirement_clearance_check_changes();


CREATE FUNCTION audit_retirement_clearance_check_change()
RETURNS TRIGGER AS $$
DECLARE
    actor_user_id UUID;
    actor_sap_id VARCHAR(40);
    change_action VARCHAR(100);
    change_entity_id TEXT;
    change_details JSONB;
BEGIN
    actor_user_id := NULLIF(current_setting('app.actor_user_id', TRUE), '')::UUID;
    actor_sap_id := NULLIF(current_setting('app.actor_sap_id', TRUE), '');

    IF TG_OP = 'INSERT' THEN
        change_action := 'retirement_check_added';
        change_entity_id := NEW.check_id::TEXT;
        change_details := jsonb_build_object(
            'checkKey', NEW.check_key,
            'changedFields', jsonb_build_array('checkKey', 'checkLabel', 'isMandatory', 'isComplete')
        );
    ELSIF TG_OP = 'UPDATE' THEN
        change_action := 'retirement_check_updated';
        change_entity_id := NEW.check_id::TEXT;
        change_details := jsonb_build_object(
            'checkKey', NEW.check_key,
            'changedFields', to_jsonb(array_remove(ARRAY[
                CASE WHEN OLD.check_key IS DISTINCT FROM NEW.check_key THEN 'checkKey' END,
                CASE WHEN OLD.check_label IS DISTINCT FROM NEW.check_label THEN 'checkLabel' END,
                CASE WHEN OLD.is_mandatory IS DISTINCT FROM NEW.is_mandatory THEN 'isMandatory' END,
                CASE WHEN OLD.is_complete IS DISTINCT FROM NEW.is_complete THEN 'isComplete' END,
                CASE WHEN OLD.checked_by_user_id IS DISTINCT FROM NEW.checked_by_user_id THEN 'checkedByUserId' END,
                CASE WHEN OLD.checked_by_sap_id IS DISTINCT FROM NEW.checked_by_sap_id THEN 'checkedBySapId' END,
                CASE WHEN OLD.checked_at IS DISTINCT FROM NEW.checked_at THEN 'checkedAt' END,
                CASE WHEN OLD.remarks IS DISTINCT FROM NEW.remarks THEN 'remarks' END
            ]::TEXT[], NULL))
        );
    ELSE
        change_action := 'retirement_check_deleted';
        change_entity_id := OLD.check_id::TEXT;
        change_details := jsonb_build_object(
            'checkKey', OLD.check_key,
            'changedFields', jsonb_build_array('deleted')
        );
    END IF;

    INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
    VALUES (actor_user_id, actor_sap_id, change_action, 'retirement_clearance_check',
            change_entity_id, change_details);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retirement_clearance_checks_audit
AFTER INSERT OR UPDATE OR DELETE ON retirement_clearance_checks
FOR EACH ROW
EXECUTE FUNCTION audit_retirement_clearance_check_change();


CREATE FUNCTION set_retirement_clearance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retirement_clearances_set_updated_at
BEFORE UPDATE ON retirement_clearances
FOR EACH ROW
EXECUTE FUNCTION set_retirement_clearance_updated_at();

CREATE TRIGGER retirement_clearance_checks_set_updated_at
BEFORE UPDATE ON retirement_clearance_checks
FOR EACH ROW
EXECUTE FUNCTION set_retirement_clearance_updated_at();
