import { describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

describe("bb plugin logs", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  it("prints the log lines", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ok: true, lines: ["first", "second"] }),
    );

    await runCommand(["plugin", "logs", "demo", "-n", "2"], register);

    expect(fetch).toHaveBeenCalledWith(
      "http://server/api/v1/plugins/demo/logs?tail=2",
      expect.objectContaining({ method: "GET" }),
    );
    expect(vi.mocked(console.log).mock.calls).toEqual([["first"], ["second"]]);
  });

  it("reports the server's reason when a member is refused", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          code: "admin_required",
          message: "This action requires an admin account",
        },
        { status: 403 },
      ),
    );

    await expect(
      runCommand(["plugin", "logs", "demo"], register),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: This action requires an admin account",
    );
    expect(console.log).not.toHaveBeenCalled();
  });
});
