-- Whether a ref starts the workflow it names (AWML 0.7): set at push. A ref
-- written before is left null here, since whether its part is an outside
-- action is in the stored YAML, converted, which SQL can't read; the registry
-- works it out the first time it reads the ref, and writes it back.
ALTER TABLE `workflow_ref` ADD `starts` integer;
