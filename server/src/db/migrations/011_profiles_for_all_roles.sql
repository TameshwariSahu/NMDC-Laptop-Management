CREATE OR REPLACE FUNCTION ensure_employee_role() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE user_id = NEW.user_id
      AND role IN ('employee', 'engineer', 'admin')
  ) THEN
    RAISE EXCEPTION 'Profile must reference a valid user role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
