CREATE UNIQUE INDEX request_invoices_one_per_request
  ON request_invoices (request_id);
