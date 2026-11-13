-- Functions get EXECUTE for PUBLIC by default. The trigger functions are only
-- fired by the owner's own statements (spaceproof_app cannot UPDATE or DELETE),
-- so nobody else needs them. Also applies to functions the owner creates later
-- in this database.
REVOKE EXECUTE ON FUNCTION certificate_prevent_tampering() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION certificate_prevent_delete() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE spaceproof_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
