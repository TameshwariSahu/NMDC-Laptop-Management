ALTER TABLE laptop_requests
  ADD COLUMN ms_office_account_email TEXT,
  ADD COLUMN registered_by_user_id UUID
    REFERENCES users(user_id) ON DELETE RESTRICT;
