ALTER TABLE retirement_clearances
  ADD COLUMN reason VARCHAR(20);

ALTER TABLE retirement_clearances
  ADD CONSTRAINT retirement_clearances_reason_valid
  CHECK (reason IS NULL OR reason IN ('Retirement', 'Transfer', 'Resignation'));

CREATE FUNCTION enforce_retirement_clearance_reason()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason IS NOT NULL
     AND NEW.reason NOT IN ('Retirement', 'Transfer', 'Resignation') THEN
    RAISE EXCEPTION 'Reason must be Retirement, Transfer, or Resignation'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required when creating a retirement clearance'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CLEARED' AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required before clearing a retirement clearance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER retirement_clearances_require_reason
BEFORE INSERT OR UPDATE OF reason, status ON retirement_clearances
FOR EACH ROW
EXECUTE FUNCTION enforce_retirement_clearance_reason();
