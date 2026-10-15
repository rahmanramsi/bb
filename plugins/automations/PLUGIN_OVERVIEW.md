Schedule work once or on a repeat, and let bb run it while you do something else. An automation can start an agent thread with a prompt, or run a stored script on the bb server.

## What you get

- An Automations panel in the sidebar. Create, edit, pause, resume, and run automations there. Each automation shows its run history.
- Two schedule types. Use a cron expression with a timezone for repeating work. Use a date, or a delay such as `2h`, for one-shot work.
- Agent mode. Pick the provider, model, reasoning level, and permission mode. Start a new thread, re-prompt an existing thread, or create a new worktree for each run.
- Script mode. Store a bash, sh, node, or python3 script. Each run records stdout, stderr, and the exit code. A script that prints nothing is recorded as a silent tick.

## For agents

Agents get the `automations` skill and the `bb automation` command: `create`, `list`, `show`, `update`, `adopt`, `pause`, `resume`, `run`, `runs`, and `delete`. All commands accept `--json`. Threads that an automation starts cannot create automations.

Scripts run on the machine that hosts the bb server. New standard-project scripts use that host's project source when available; Personal and projects without one run in the plugin's shared script storage. Existing scripts run there until changed. A script can instead select an absolute server-host path, and its detail view shows the resolved directory. Agent runs use the providers you already have installed.

On a multi-user server only admins can create, update, run, pause, or resume script automations, because scripts run with the bb server's own environment. Members can create, edit, run, pause, and resume agent automations, and can delete either kind.

An agent automation runs as one person, shown in its detail view and in `bb automation show`. Renaming or rescheduling it keeps that person. Changing what it runs, such as its prompt, target, model, or permissions, keeps that person only when they make the change. Anyone else must adopt the automation first: Run as me, or `bb automation adopt`, shows exactly what it runs and then makes it run as you.
