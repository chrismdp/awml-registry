-- Every check AWML ran on a workflow's file at push, with its result, and the
-- AWML that ran them. Versions stored before have none, and keep the Checks
-- tab they had.
ALTER TABLE `version` ADD `checks` text;
