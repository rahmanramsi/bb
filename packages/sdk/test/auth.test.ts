import { describe, expect, it } from "vitest";
import { createNodeBbSdk } from "../src/node.js";
import { createBrowserBbSdk } from "../src/browser.js";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("SDK authentication", () => {
  it.each(["node", "browser", "core"] as const)(
    "sends the configured bearer on %s typed requests and uploads",
    async (runtime) => {
      const requests: Request[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          user: {
            id: "u",
            name: "User",
            email: "user@example.test",
            role: "member",
          },
        });
      };
      const args = {
        baseUrl: "http://server",
        fetch: fetchImpl,
        context: { authToken: "bbpat_test" },
      };
      const sdk =
        runtime === "node"
          ? createNodeBbSdk(args)
          : runtime === "browser"
            ? createBrowserBbSdk(args)
            : createBbSdk({
                context: args.context,
                transport: createHttpTransport({
                  baseUrl: args.baseUrl,
                  fetch: fetchImpl,
                  runtime: "node",
                }),
              });
      await sdk.experimental_auth.me();
      expect(requests[0].url).toBe("http://server/api/v1/me");
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer bbpat_test",
      );
      const transport = createHttpTransport({ ...args, runtime: "node" });
      await transport.fetch("http://server/api/v1/projects/p/attachments", {
        method: "POST",
        headers: { "x-custom": "kept" },
        body: new FormData(),
      });
      expect(requests[1].headers.get("authorization")).toBe(
        "Bearer bbpat_test",
      );
      expect(requests[1].headers.get("x-custom")).toBe("kept");
    },
  );
  it("leaves cookie authentication intact without a token", async () => {
    let authorization: string | null = null;
    const sdk = createBrowserBbSdk({
      baseUrl: "http://server",
      fetch: async (input, init) => {
        authorization = new Request(input, init).headers.get("authorization");
        return Response.json({ user: null });
      },
    });
    await sdk.experimental_auth.me();
    expect(authorization).toBeNull();
  });
});
