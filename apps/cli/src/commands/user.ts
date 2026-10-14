import { userRoleSchema } from "@bb/domain";
import { Command } from "commander";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface UserListOptions {
  json?: boolean;
}

export function registerUserCommands(
  program: Command,
  getUrl: () => string,
): void {
  const user = program
    .command("user")
    .description("Manage the people who use this server (admin)");

  user
    .command("list")
    .description("List users with their ids and roles")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: UserListOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const result = await sdk.experimental_users.list();
        if (outputJson(opts, result)) return;
        const rows = result.users.map((entry) => [
          entry.id,
          entry.name,
          entry.email,
          entry.role,
        ]);
        printBorderlessTable(
          {
            head: ["Id", "Name", "Email", "Role"],
            colWidths: columnWidths(rows, [2, 4, 5, 4]),
            trimTrailingWhitespace: true,
          },
          rows,
        );
      }),
    );
  user
    .command("role <userId> <role>")
    .description("Set a user's role to admin or member")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (userId: string, role: string, opts: UserListOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_users.updateRole({
          userId,
          role: userRoleSchema.parse(role),
        });
        if (!outputJson(opts, result))
          console.log(`${result.user.id}: ${result.user.role}`);
      }),
    );
  user
    .command("remove <userId>")
    .description(
      "Remove a user, revoke their credentials, and delete their queued messages",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (userId: string, opts: UserListOptions) => {
        const result = await createCliBbSdk(getUrl()).experimental_users.remove(
          { userId },
        );
        if (!outputJson(opts, result)) console.log(`Removed ${userId}`);
      }),
    );
  const connect = user
    .command("connect-members")
    .description(
      "Manage bb accounts allowed through this server's connect gate (owner)",
    );
  connect
    .command("list")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: UserListOptions) => {
        const result =
          await createCliBbSdk(
            getUrl(),
          ).experimental_users.listConnectMembers();
        if (!outputJson(opts, result))
          for (const member of result.members)
            console.log(`${member.userId} ${member.email} ${member.role}`);
      }),
    );
  connect
    .command("add <email>")
    .option("--role <role>", "Gate role: admin or member", "member")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (email: string, opts: UserListOptions & { role: string }) => {
          const result = await createCliBbSdk(
            getUrl(),
          ).experimental_users.addConnectMember({
            email,
            role: userRoleSchema.parse(opts.role),
          });
          if (!outputJson(opts, result))
            console.log(`Added ${result.member.email} (${result.member.role})`);
        },
      ),
    );
  connect
    .command("remove <userId>")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (userId: string, opts: UserListOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_users.removeConnectMember({ userId });
        if (!outputJson(opts, result))
          console.log(`Removed connect access for ${userId}`);
      }),
    );
}
