# Template contracts

Templates are reusable single-domain structures without executable dose. Read `get_training_taxonomy` and use returned IDs. `list_session_templates` lists metadata only; `get_session_template` returns the chosen template's nodes.

A template contains name, concise intent, one domain, and ordered `nodes`. Each node has a role, optional name, required `variables`, optional `optionalVariables`, and `optional: true` only when the whole node is optional. Do not include extra notes, use cases, identity ranges, prescription fields, or dose defaults.

Use `create_session_template`, `update_session_template`, or `delete_session_template` only after approval of the exact operation. User updates/deletes require `expectedRevision`. Built-ins carry `catalogVersion`, not user revisions: customize with `create_session_template` to derive a user replacement with the same ID; deleting a built-in only hides it and needs no revision. Never delete a referenced template.

Create a user template before committing a plan referencing its exact revision. Weekly sessions still own complete authoritative prescriptions. Template changes never rewrite sessions.
