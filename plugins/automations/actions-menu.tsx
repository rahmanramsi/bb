import { ResourceOverflowMenu } from "@/components/ui/resource-list";

export function AutomationActionsMenu({
  name,
  pending,
  runDisabledReason,
  onRunNow,
  onAdopt,
  onDelete,
}: {
  name: string;
  pending: boolean;
  runDisabledReason?: string;
  onRunNow: () => void;
  onAdopt?: () => void;
  onDelete: () => void;
}) {
  return (
    <ResourceOverflowMenu
      label={`${name} actions`}
      disabled={pending}
      items={[
        {
          label: "Run now",
          icon: "Play",
          disabled: runDisabledReason !== undefined,
          disabledReason: runDisabledReason,
          onSelect: onRunNow,
        },
        ...(onAdopt === undefined
          ? []
          : [
              {
                label: "Run as me",
                icon: "UserRound" as const,
                onSelect: onAdopt,
              },
            ]),
        { kind: "separator" },
        {
          label: "Delete",
          icon: "Trash2",
          tone: "destructive",
          onSelect: onDelete,
        },
      ]}
    />
  );
}
