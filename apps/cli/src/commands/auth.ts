import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Command } from "commander";
import { userRoleSchema } from "@bb/domain";
import { createNodeBbSdk } from "@bb/sdk/node";
import { action } from "../action.js";
import { storeCliAuthToken } from "../auth-store.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}
interface LoginOptions extends JsonOptions {
  token?: string;
  email?: string;
  passwordFile?: string;
}

async function readSecret(label: string, file?: string): Promise<string> {
  if (file !== undefined)
    return (await readFile(file, "utf8")).replace(/\r?\n$/u, "");
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += chunk.toString();
    return value.replace(/\r?\n$/u, "");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  process.stderr.write(`${label}: `);
  muted = true;
  try {
    return await input.question("");
  } finally {
    input.close();
    process.stderr.write("\n");
  }
}

export function registerLoginCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("login")
    .description("Save a personal access token for this server profile")
    .option("--token <token>", "Use an existing personal access token")
    .option("--email <email>", "Sign in and create a CLI token")
    .option("--password-file <path>", "Read the sign-in password from a file")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: LoginOptions) => {
        if (opts.token !== undefined && opts.email !== undefined)
          throw new Error("Choose --token or --email");
        if (opts.passwordFile !== undefined && opts.email === undefined)
          throw new Error("--password-file requires --email");
        const baseUrl = getUrl();
        let token: string;
        if (opts.email !== undefined) {
          let cookie = "";
          const sdk = createNodeBbSdk({
            baseUrl,
            fetch: async (url, init) => {
              const headers = new Headers(init?.headers);
              if (cookie) headers.set("cookie", cookie);
              const response = await fetch(url, { ...init, headers });
              const cookies = response.headers.getSetCookie();
              if (cookies.length)
                cookie = cookies.map((entry) => entry.split(";")[0]).join("; ");
              return response;
            },
          });
          await sdk.experimental_auth.signIn({
            email: opts.email,
            password: await readSecret("Password", opts.passwordFile),
          });
          try {
            token = (
              await sdk.experimental_auth.createToken({ name: "bb CLI" })
            ).token;
          } finally {
            await sdk.experimental_auth.signOut();
          }
        } else
          token = (
            opts.token ?? (await readSecret("Personal access token"))
          ).trim();
        if (!token.startsWith("bbpat_"))
          throw new Error(
            "A personal access token beginning with bbpat_ is required",
          );
        const result = await createNodeBbSdk({
          baseUrl,
          context: { authToken: token },
        }).experimental_auth.me();
        await storeCliAuthToken(baseUrl, token);
        if (!outputJson(opts, result))
          console.log(`Signed in as ${result.user.email}`);
      }),
    );
}

export function registerLogoutCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("logout")
    .description("Remove the saved token for this server profile")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        await storeCliAuthToken(getUrl(), null);
        if (!outputJson(opts, { ok: true }))
          console.log(
            "Saved login removed. Revoke the token with bb token revoke if needed.",
          );
      }),
    );
}

export function registerWhoamiCommand(
  program: Command,
  getUrl: () => string,
): void {
  program
    .command("whoami")
    .description("Show the authenticated user")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result = await createCliBbSdk(getUrl()).experimental_auth.me();
        if (!outputJson(opts, result))
          console.log(
            `${result.user.id}  ${result.user.email}  ${result.user.role}`,
          );
      }),
    );
}

export function registerTokenCommands(
  program: Command,
  getUrl: () => string,
): void {
  const command = program
    .command("token")
    .description("Manage your personal access tokens");
  command
    .command("create <name>")
    .description("Create a token and print it once")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (name: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_auth.createToken({ name });
        if (!outputJson(opts, result)) console.log(result.token);
      }),
    );
  command
    .command("list")
    .description("List your tokens without exposing their values")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result =
          await createCliBbSdk(getUrl()).experimental_auth.listTokens();
        if (!outputJson(opts, result))
          for (const token of result.tokens)
            console.log(`${token.id}  ${token.name}`);
      }),
    );
  command
    .command("revoke <id>")
    .description("Revoke one of your tokens")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_auth.revokeToken({ id });
        if (!outputJson(opts, result)) console.log(`Revoked ${id}`);
      }),
    );
}

export function registerInviteCommands(
  program: Command,
  getUrl: () => string,
): void {
  const command = program
    .command("invite")
    .description("Manage server invites (admin), or accept an invite");
  command
    .command("create")
    .description("Create a seven-day invite and print its token once")
    .option("--email <email>", "Restrict the invite to an email address")
    .option("--role <role>", "Assign admin or member", "member")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions & { email?: string; role: string }) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_auth.createInvite({
          email: opts.email,
          role: userRoleSchema.parse(opts.role),
        });
        if (!outputJson(opts, result))
          console.log(`${result.id}  ${result.token}`);
      }),
    );
  command
    .command("list")
    .description("List pending unexpired invites")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const result =
          await createCliBbSdk(getUrl()).experimental_auth.listInvites();
        if (!outputJson(opts, result))
          for (const invite of result.invites)
            console.log(
              `${invite.id}  ${invite.email ?? "Any email"}  ${invite.role}`,
            );
      }),
    );
  command
    .command("revoke <id>")
    .description("Revoke an invite")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: JsonOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_auth.revokeInvite({ id });
        if (!outputJson(opts, result)) console.log(`Revoked ${id}`);
      }),
    );
  command
    .command("accept <inviteToken>")
    .description("Create an account using an invite")
    .requiredOption("--email <email>", "Account email")
    .requiredOption("--name <name>", "Display name")
    .option("--password-file <path>", "Read the account password from a file")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          inviteToken: string,
          opts: JsonOptions & {
            email: string;
            name: string;
            passwordFile?: string;
          },
        ) => {
          const result = await createNodeBbSdk({
            baseUrl: getUrl(),
          }).experimental_auth.acceptInvite({
            inviteToken,
            email: opts.email,
            name: opts.name,
            password: await readSecret("Password", opts.passwordFile),
          });
          if (!outputJson(opts, result))
            console.log(
              `Created ${result.user.email}. Sign in with bb login --email ${result.user.email}`,
            );
        },
      ),
    );
}
