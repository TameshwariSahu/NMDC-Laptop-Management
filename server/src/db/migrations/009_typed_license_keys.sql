ALTER TABLE laptop_requests
  ADD COLUMN windows_license_key_ciphertext BYTEA,
  ADD COLUMN windows_license_key_nonce BYTEA,
  ADD COLUMN windows_license_key_auth_tag BYTEA,
  ADD COLUMN windows_license_key_hmac BYTEA,
  ADD COLUMN office_license_key_ciphertext BYTEA,
  ADD COLUMN office_license_key_nonce BYTEA,
  ADD COLUMN office_license_key_auth_tag BYTEA,
  ADD COLUMN office_license_key_hmac BYTEA,
  ADD CONSTRAINT laptop_requests_windows_key_parts
    CHECK (
      (
        windows_license_key_ciphertext IS NULL
        AND windows_license_key_nonce IS NULL
        AND windows_license_key_auth_tag IS NULL
        AND windows_license_key_hmac IS NULL
      )
      OR
      (
        windows_license_key_ciphertext IS NOT NULL
        AND windows_license_key_nonce IS NOT NULL
        AND windows_license_key_auth_tag IS NOT NULL
        AND windows_license_key_hmac IS NOT NULL
      )
    ),
  ADD CONSTRAINT laptop_requests_office_key_parts
    CHECK (
      (
        office_license_key_ciphertext IS NULL
        AND office_license_key_nonce IS NULL
        AND office_license_key_auth_tag IS NULL
        AND office_license_key_hmac IS NULL
      )
      OR
      (
        office_license_key_ciphertext IS NOT NULL
        AND office_license_key_nonce IS NOT NULL
        AND office_license_key_auth_tag IS NOT NULL
        AND office_license_key_hmac IS NOT NULL
      )
    ),
  ADD CONSTRAINT laptop_requests_windows_key_requires_windows_os
    CHECK (
      operating_system = 'Windows'
      OR (
        windows_license_key_ciphertext IS NULL
        AND windows_license_key_nonce IS NULL
        AND windows_license_key_auth_tag IS NULL
        AND windows_license_key_hmac IS NULL
      )
    );

CREATE INDEX laptop_requests_windows_key_hmac_idx
  ON laptop_requests (windows_license_key_hmac)
  WHERE windows_license_key_hmac IS NOT NULL;

CREATE INDEX laptop_requests_office_key_hmac_idx
  ON laptop_requests (office_license_key_hmac)
  WHERE office_license_key_hmac IS NOT NULL;
