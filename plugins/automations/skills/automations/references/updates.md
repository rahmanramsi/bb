`list` and `show` are diagnostic reads: a damaged record remains visible as
`Prompt required` or `Invalid data` instead of failing the whole read. A
`Prompt required` record opens in the Automations panel's standard editor,
where the user can add its prompt while reviewing the other settings. It can
also be repaired directly:

```bash
bb automation update <automationId> --project <id> --prompt "<prompt>"
```

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical. Every successful
create/update persists the canonical format.

Choose one of two execution update forms:

- A complete replacement uses `--prompt`, `--provider`, and `--model` together
  to replace the execution with an agent, or `--script`/`--script-file` to
  replace it with a script. Add `--reasoning` and `--service-tier` when needed.
  Include every desired mode-specific setting;
  settings from the previous execution do not carry over.
- A partial agent update preserves every omitted execution field and edits the
  existing agent automation in place. Use any combination of `--prompt`,
  `--provider`, `--model`, `--reasoning`, `--service-tier`, and
  `--permission-mode accept-edits|auto|full`, then choose at most one execution
  target. When changing providers, pass the provider's coherent model,
  reasoning, tier, and permission selection together:

```bash
bb automation update <automationId> --project <id> \
  --environment <environment-id-or-path>
bb automation update <automationId> --project <id> \
  --target-thread <thread-id>
bb automation update <automationId> --project <id> \
  --new-environment worktree [--base-branch <branch>]
```

`--target-thread`, `--environment`, and `--new-environment` are mutually
exclusive. These flags apply only to agent automations; script automations have
no execution environment.

For a script automation, update only its working-directory policy without
replacing the stored script:

```bash
bb automation update <automationId> --project <id> \
  --working-directory automation-storage|project|<absolute-server-path>
```

A complete script replacement preserves the current policy when the flag is
omitted.

## Who an agent automation runs as

An agent automation runs as the person in `show`'s "Runs as" line
(`runsAsUserId` in JSON). Updates fall into two groups:

- `--name` and the schedule flags (`--cron`, `--timezone`, `--at`, `--in`),
  `pause`, and `resume` never change who it runs as.
- Everything that changes what the agent does or where — the prompt,
  `--target-thread`, `--environment`, `--new-environment`, `--base-branch`,
  the provider, model, reasoning, service tier, permission mode, or a complete
  execution replacement — bumps the execution revision (`Revision` in `show`,
  `executionRevision` in JSON). Saving the same values is not a change.

When the person it runs as changes the execution, it keeps running as them.
When anyone else does, the update is refused with
`automation_adoption_required`: the new execution would otherwise run with
someone's identity who did not write it. Review the full execution first, then
adopt the exact revision you reviewed:

```bash
bb automation adopt <automationId> --project <id>
bb automation adopt <automationId> --project <id> --revision <n>
bb automation update <automationId> --project <id> --prompt "<prompt>" \
  --adopt-revision <n>
```

`adopt` without `--revision` prints the prompt, target, provider, model,
reasoning, tier, permission mode, and revision and changes nothing. With
`--revision`, or with `--adopt-revision` on `update`, the automation runs as
you and the previous person's grant is revoked. Either fails with
`automation_revision_stale`, changing nothing, when the execution or the
person it runs as changed after that revision. Over RPC, use
`automations_adopt` with `expectedRevision`, or pass
`adopt: { expectedRevision }` to `automations_update`. Script automations never
run as a person and cannot be adopted.

When a plugin or bb itself changes an agent automation's execution, the grant
is revoked and the automation runs without a user identity until someone
adopts it.

Every command supports `--json`. For `list` and `show`, the JSON result is a
union discriminated by `problem`: canonical records omit it, while degraded
records use `"missing-agent-prompt"` or `"invalid-stored-data"`. The
missing-prompt variant retains the full readable automation; the invalid-data
variant contains only `id`, `projectId`, `name`, and `problem`.
