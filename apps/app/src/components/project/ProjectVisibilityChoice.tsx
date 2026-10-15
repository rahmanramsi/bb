import "@bb/shared-ui/icon-extended";
import { Icon } from "@bb/shared-ui/icon";
import { ToggleGroup, ToggleGroupItem } from "@bb/shared-ui/toggle-group";
import { projectVisibilitySchema, type ProjectVisibility } from "@bb/domain";

export function ProjectVisibilityChoice({
  value,
  disabled,
  privateDescription = "Only you, members you add, and admins can see this project.",
  publicDescription = "Everyone on this server can see this project.",
  onChange,
}: {
  value: ProjectVisibility;
  disabled: boolean;
  privateDescription?: string;
  publicDescription?: string;
  onChange: (value: ProjectVisibility) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-foreground">Access</p>
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label="Project access"
        value={value}
        disabled={disabled}
        className="grid grid-cols-2 gap-2"
        onValueChange={(next) => {
          const parsed = projectVisibilitySchema.safeParse(next);
          if (parsed.success) onChange(parsed.data);
        }}
      >
        <ToggleGroupItem value="public" className="font-normal">
          <Icon name="Globe" />
          Public
        </ToggleGroupItem>
        <ToggleGroupItem value="private" className="font-normal">
          <Icon name="Lock" />
          Private
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-subtle-foreground">
        {value === "private" ? privateDescription : publicDescription}
      </p>
    </div>
  );
}
