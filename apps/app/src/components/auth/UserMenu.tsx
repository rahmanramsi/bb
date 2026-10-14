import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import "@bb/shared-ui/icon-extended";
import { Icon } from "@bb/shared-ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { useAuth } from "@/hooks/useAuth";
import { sdk } from "@/lib/sdk";
import type { AuthUser } from "@bb/server-contract";

export function UserMenu() {
  const auth = useAuth();
  return auth?.authMode === "multi" && auth.user !== null ? (
    <SignedInUserMenu user={auth.user} />
  ) : null;
}

function SignedInUserMenu({ user }: { user: AuthUser }) {
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: () => sdk.experimental_auth.signOut(),
    onSuccess: () => window.location.reload(),
  });
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 max-md:pointer-coarse:size-9"
          aria-label={`User menu for ${user.name}`}
        >
          <Icon name="UserRound" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        mobileTitle="Your account"
        className="w-64"
      >
        <div className="px-2 py-2 text-sm">
          <p className="truncate font-medium">{user.name}</p>
          <p className="break-all text-xs text-subtle-foreground">
            {user.email}
          </p>
          <p className="text-xs capitalize text-subtle-foreground">
            {user.role}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate("/settings/account")}>
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={signOut.isPending}
          onSelect={(event) => {
            event.preventDefault();
            signOut.mutate();
          }}
        >
          Sign out
        </DropdownMenuItem>
        {signOut.error && (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {signOut.error.message}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
