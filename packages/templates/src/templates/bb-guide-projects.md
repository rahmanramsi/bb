---
kind: instruction
title: bb Guide — Projects
summary: Command reference for project CRUD, access, attachments, and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

A project maps to a code repository. All threads belong to a project.

  bb project list                         List ordinary projects
    --include-personal                    Also include the personal project
    --visibility public|private           Only list public or private projects
  bb project discover                     Find recently used git repos
    --machine <id-or-name>                Machine to scan (default: local)
    --host <id-or-name>                   Alias for --machine
  bb project history <id>                 List prompt history
  bb project reorder <id>                 Reorder in the sidebar
    --after <id>                          Previous project, or omit for start
    --before <id>                         Next project, or omit for end
  bb project create --name "..." [options]
    --root <path>                         Project source path
    --machine <id-or-name>                Bind the path to a connected machine
    --host <id-or-name>                   Alias for --machine
    --visibility public|private           Access (default: public)
    --member <id-or-email>                Give a user access (repeatable)

  An explicit machine/host selector accepts an exact ID or unambiguous name and
  binds --root to that machine. Omitting the selector preserves the existing
  local CLI machine fallback (normally the server machine).

  bb project show <id>                    Show project details
    Accepts proj_personal to inspect Personal.
  bb project update <id>                  Update a project
    --name <name>                         New name

  bb project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Access:

  bb project visibility <id> public|private
                                          Make a project public or private
  bb project member list <id>             List the owner and members
  bb project member add <id> <user>       Give a user access (ID or email)
  bb project member remove <id> <user>    Remove a user's access

  On a server with BB_AUTH_MODE=multi, a project created by a signed-in user
  is owned by that user; projects created before ownership existed, or by the
  local machine, have no owner (ownerUserId is null) and are team projects.
  Public projects are visible to everyone on the server. Private projects,
  and their threads, environments, terminals, and files, are visible only to
  the owner, members, and admins; to anyone else they do not exist (404).
  Only the owner and admins can rename, delete, change visibility, or manage
  members; others get 403. Adding the owner or an existing member is a no-op.
  Personal is always public and has no members. Agents in threads act as the
  user who started them, so they see the same projects. In local auth mode
  every project is visible and manageable.

Global prompt history:

  bb prompt-history list [--cursor <cursor>] [--limit <number>]

  Lists your accepted prompts across projects and threads newest first. Each
  user has their own prompt history. Pass the returned cursor to continue from
  the next page.

People:

  bb user list                            List users with ids and roles

  Maps createdByUserId, authorUserId, and resolvedByUserId on threads, queued
  messages, and interactions to names.

Discovery:

  bb project branches <id> --host <id>   List branches for a machine source
  bb project paths <id>                   Search workspace paths
  bb project files <id>                   List workspace files
  bb project content <id> <path>          Read file content (binary is base64)
  bb project commands <id> --provider <id>
                                          List commands and skills
    --machine <id-or-name>                Target project source machine
    --host <id-or-name>                   Alias for --machine
    --environment <id>                    Target environment workspace

  The machine/host and environment selectors are mutually exclusive. An
  environment selects its owning machine and workspace; otherwise an explicit
  machine selects that machine's project source. Omitting both intentionally
  falls back to the server machine's project source.

  Personal file access (`paths`, `files`, `content`) requires an explicit
  --environment <id> belonging to Personal. Personal has no default project
  source; the selected environment must be ready.

Attachments:

  bb project attachment upload <id>       Upload bytes from the CLI machine
    --client-file <path>                  Path read on this CLI machine
    --filename <name>                     Attachment filename override
    --mime-type <type>                    MIME override (otherwise inferred)
  bb project attachment download <id> <attachment-path>
    --client-file <path>                  Destination on this CLI machine

  Uploads use multipart bytes and return a server-managed attachment DTO. Pass
  its relative `path` to thread --file/--image input. Thread --file and --image
  upload absolute paths and file: URLs from the CLI machine automatically;
  relative values remain existing server attachment paths.
  image/* uploads are limited to 10MB; other files are limited to 25MB.
  image/heic and image/heif uploads are rejected because no renderer or
  provider can decode them; convert them to JPEG or PNG first.

Sources:

  Projects can have multiple machine-local path sources.

  bb project source add <projectId>       Add a source
    --path <path>                         Local path
    --clone                               Clone the project's Git remote
    --remote-url <url>                    Git remote override for --clone
    --target-path <path>                  Destination override for --clone
    --machine <id-or-name>                Target machine (--host is an alias)
    --default                             Set as default source

  Explicit project source selectors must name a connected machine. Omitting
  the selector preserves the same local CLI machine fallback as project create.

  bb project source update <projectId> <sourceId>
    --path <path>
    --default

  bb project source delete <projectId> <sourceId>

Project source deletion remains available while a project is pending deletion so providers can finish cleanup. A live project must retain at least one source; a deleting project may remove its last source.

Workspace file and path searches honor Git ignore rules, including local and
global exclusions. Tracked files and non-ignored untracked files remain
searchable, including hidden files. Non-Git workspaces use filesystem listings.
Use `bb file list|paths` for filesystem listings that include ignored files,
subject to their explicit exclusion options.
