-- Certificates are evidence: they can never be deleted. The runtime role has no
-- DELETE or TRUNCATE privilege; these triggers also stop the table owner.
-- TRUNCATE does not fire DELETE triggers, so it needs its own.
CREATE FUNCTION certificate_prevent_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Certificates cannot be deleted';
END;
$$;

CREATE TRIGGER "Certificate_no_delete"
BEFORE DELETE ON "Certificate"
FOR EACH ROW EXECUTE FUNCTION certificate_prevent_delete();

CREATE TRIGGER "Certificate_no_truncate"
BEFORE TRUNCATE ON "Certificate"
FOR EACH STATEMENT EXECUTE FUNCTION certificate_prevent_delete();
