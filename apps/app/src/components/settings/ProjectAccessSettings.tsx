import { useMemo } from "react";
import {
  PERSONAL_PROJECT_ID,
  projectVisibilitySchema,
  type ProjectVisibility,
} from "@bb/domain";
import type { ProjectMember, ProjectResponse } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import "@bb/shared-ui/icon-extended";
import { Icon } from "@bb/shared-ui/icon";
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  useAddProjectMember,
  useRemoveProjectMember,
  useUpdateProject,
} from "@/hooks/mutations/project-mutations";
import { useProjectMembers } from "@/hooks/queries/project-member-queries";
import { useUserDirectory } from "@/hooks/queries/user-queries";
import { useAuth } from "@/hooks/useAuth";
import {
  ChoiceDropdownSetting,
  type ChoiceDropdownOption,
} from "./ChoiceDropdownSetting";

const ACCESS_DESCRIPTION =
  "Who can see this project and its threads. Admins can always see every project.";

export const PROJECT_VISIBILITY_OPTIONS = [
  {
    key: "public",
    title: "Public",
    description: "Everyone on this server can see it.",
  },
  {
    key: "private",
    title: "Private",
    description: "Only the owner, members, and admins can see it.",
  },
] as const satisfies readonly (ChoiceDropdownOption & {
  key: ProjectVisibility;
})[];

export function ProjectPrivateBadge({
  visibility,
}: {
  visibility: ProjectVisibility;
}) {
  const auth = useAuth();
  if (auth?.authMode !== "multi" || visibility !== "private") return null;
  return (
    <SettingsBadge>
      <span className="inline-flex items-center gap-1">
        <Icon name="Lock" className="size-2.5" aria-hidden />
        private
      </span>
    </SettingsBadge>
  );
}

export function ProjectAccessSettings({
  project,
}: {
  project: ProjectResponse;
}) {
  const auth = useAuth();
  if (auth?.authMode !== "multi" || project.id === PERSONAL_PROJECT_ID) {
    return null;
  }
  return <ProjectAccessSection project={project} />;
}

function ProjectAccessSection({ project }: { project: ProjectResponse }) {
  const canManage = project.viewerCanManage;
  const updateProject = useUpdateProject();
  const membersQuery = useProjectMembers(project.id);
  const directory = useUserDirectory();
  const addMember = useAddProjectMember();
  const removeMember = useRemoveProjectMember();
  const members = membersQuery.data?.members;
  const owner = membersQuery.data?.owner ?? null;
  const memberPending = addMember.isPending || removeMember.isPending;

  const candidates = useMemo(() => {
    if (directory.data === undefined || members === undefined) return [];
    const excluded = new Set([
      ...members.map((member) => member.userId),
      ...(project.ownerUserId === null ? [] : [project.ownerUserId]),
    ]);
    return directory.data.users.filter((user) => !excluded.has(user.id));
  }, [directory.data, members, project.ownerUserId]);

  const selectedVisibility =
    PROJECT_VISIBILITY_OPTIONS.find(
      (option) => option.key === project.visibility,
    ) ?? PROJECT_VISIBILITY_OPTIONS[0];

  return (
    <SettingsSection
      title="Access"
      description={ACCESS_DESCRIPTION}
      action={
        canManage ? (
          <AddMemberMenu
            disabled={memberPending || members === undefined}
            candidates={candidates}
            onAdd={(userId) =>
              addMember.mutate({ projectId: project.id, userId })
            }
          />
        ) : null
      }
    >
      <ChoiceDropdownSetting
        label="Visibility"
        description={
          canManage
            ? "Members can see a private project. Everyone can see a public one."
            : "Only the project owner or an admin can change access."
        }
        triggerAriaLabel="Project visibility"
        options={PROJECT_VISIBILITY_OPTIONS}
        selected={selectedVisibility}
        disabled={!canManage || updateProject.isPending}
        onSelect={(key) => {
          const visibility = projectVisibilitySchema.parse(key);
          if (visibility === project.visibility) return;
          updateProject.mutate({ id: project.id, visibility });
        }}
      />
      <SettingsRowList>
        <SettingsDetailRow label="Owner">
          {membersQuery.isPending ? (
            <span>Loading…</span>
          ) : owner === null ? (
            <span>Team project, managed by admins</span>
          ) : (
            <MemberIdentity member={owner} />
          )}
        </SettingsDetailRow>
      </SettingsRowList>
      <div className="space-y-1.5">
        <p className="text-sm text-foreground">Members</p>
        {membersQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Couldn't load members.
          </p>
        ) : members === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            No members yet.
            {canManage
              ? " Add people who should see this project while it is private."
              : null}
          </p>
        ) : (
          <SettingsRowList>
            {members.map((member) => (
              <SettingsRow key={member.userId}>
                <MemberIdentity member={member} />
                {canManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto shrink-0"
                    aria-label={`Remove ${member.name}`}
                    disabled={memberPending}
                    onClick={() =>
                      removeMember.mutate({
                        projectId: project.id,
                        userId: member.userId,
                      })
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </SettingsRow>
            ))}
          </SettingsRowList>
        )}
      </div>
    </SettingsSection>
  );
}

function MemberIdentity({ member }: { member: ProjectMember }) {
  return (
    <span className="flex min-w-0 flex-col text-left">
      <span className="truncate text-sm text-foreground">{member.name}</span>
      <span className="truncate text-xs text-subtle-foreground">
        {member.email}
      </span>
    </span>
  );
}

function AddMemberMenu({
  disabled,
  candidates,
  onAdd,
}: {
  disabled: boolean;
  candidates: readonly { id: string; name: string; email: string }[];
  onAdd: (userId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || candidates.length === 0}
        >
          <Icon name="Plus" className="size-3.5" />
          Add member
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Add member"
        className="max-h-72 w-64 overflow-y-auto"
      >
        {candidates.map((user) => (
          <DropdownMenuItem
            key={user.id}
            className="flex flex-col items-start gap-0"
            onSelect={() => onAdd(user.id)}
          >
            <span className="max-w-full truncate">{user.name}</span>
            <span className="max-w-full truncate text-xs text-muted-foreground">
              {user.email}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
