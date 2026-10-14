import { useAuth } from "@/hooks/useAuth";
import { useUserDirectory } from "@/hooks/queries/user-queries";

function CreatorName({ userId }: { userId: string }) {
  const directory = useUserDirectory();
  if (directory.data === undefined) return null;
  const name =
    directory.data.users.find((user) => user.id === userId)?.name ??
    "Deleted user";
  return (
    <span
      className="max-w-40 truncate text-xs font-normal text-subtle-foreground"
      title={`Created by ${name}`}
    >
      by {name}
    </span>
  );
}

export function ThreadCreator({ userId }: { userId: string | null }) {
  const auth = useAuth();
  return auth?.authMode === "multi" && userId !== null ? (
    <CreatorName userId={userId} />
  ) : null;
}
