-- Audit events are only ever added: refuse any change or removal.
CREATE TRIGGER `audit_event_no_update` BEFORE UPDATE ON `audit_event`
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be changed');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_event_no_delete` BEFORE DELETE ON `audit_event`
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be removed');
END;
