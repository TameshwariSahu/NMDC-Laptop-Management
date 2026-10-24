DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
    WHERE char_length(btrim(sap_id)) <> 8
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: a user SAP ID is not exactly 8 characters after trimming';
  END IF;

  IF EXISTS (
    SELECT 1 FROM employees
    WHERE char_length(btrim(sap_id)) <> 8
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: an employee SAP ID is not exactly 8 characters after trimming';
  END IF;

  IF EXISTS (
    SELECT upper(btrim(sap_id))
    FROM users
    GROUP BY upper(btrim(sap_id))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: user SAP IDs collide after normalization';
  END IF;

  IF EXISTS (
    SELECT upper(btrim(sap_id))
    FROM employees
    GROUP BY upper(btrim(sap_id))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: employee SAP IDs collide after normalization';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users u
    JOIN employees e ON e.user_id = u.user_id
    WHERE upper(btrim(u.sap_id)) <> upper(btrim(e.sap_id))
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: employee SAP IDs do not match their user accounts';
  END IF;
END;
$$;

UPDATE users
SET sap_id = upper(btrim(sap_id))
WHERE sap_id <> upper(btrim(sap_id));

UPDATE employees
SET sap_id = upper(btrim(sap_id))
WHERE sap_id <> upper(btrim(sap_id));

ALTER TABLE users
  ADD CONSTRAINT users_sap_id_exactly_8
  CHECK (char_length(sap_id) = 8 AND sap_id = upper(btrim(sap_id)));

ALTER TABLE employees
  ADD CONSTRAINT employees_sap_id_exactly_8
  CHECK (char_length(sap_id) = 8 AND sap_id = upper(btrim(sap_id)));

CREATE FUNCTION normalize_sap_id_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.sap_id := upper(btrim(NEW.sap_id));

  IF char_length(NEW.sap_id) <> 8 THEN
    RAISE EXCEPTION 'SAP ID must be exactly 8 characters';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_normalize_sap_id
BEFORE INSERT OR UPDATE OF sap_id ON users
FOR EACH ROW
EXECUTE FUNCTION normalize_sap_id_before_write();

CREATE TRIGGER employees_normalize_sap_id
BEFORE INSERT OR UPDATE OF sap_id ON employees
FOR EACH ROW
EXECUTE FUNCTION normalize_sap_id_before_write();

