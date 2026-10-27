ALTER TABLE laptop_requests
  ADD COLUMN created_by_sap_id VARCHAR(40),
  ADD COLUMN updated_by_sap_id VARCHAR(40),
  ADD CONSTRAINT laptop_requests_created_by_sap_nonempty
    CHECK (created_by_sap_id IS NULL OR length(btrim(created_by_sap_id)) > 0),
  ADD CONSTRAINT laptop_requests_updated_by_sap_nonempty
    CHECK (updated_by_sap_id IS NULL OR length(btrim(updated_by_sap_id)) > 0);

CREATE FUNCTION set_laptop_request_actor_sap_ids()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actor_sap_id VARCHAR(40);
BEGIN
  actor_sap_id := NULLIF(current_setting('app.actor_sap_id', TRUE), '');

  IF TG_OP = 'INSERT' THEN
    NEW.created_by_sap_id := actor_sap_id;
    NEW.updated_by_sap_id := actor_sap_id;
  ELSE
    NEW.updated_by_sap_id := actor_sap_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER laptop_requests_set_actor_sap_ids
BEFORE INSERT OR UPDATE ON laptop_requests
FOR EACH ROW
EXECUTE FUNCTION set_laptop_request_actor_sap_ids();
