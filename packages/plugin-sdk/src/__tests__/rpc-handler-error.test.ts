import { describe, expect, it } from "vitest";
import { rpcHandlerError } from "../internal/host-policy.js";
import { experimental_PluginRpcForbiddenError } from "../rpc-contract.js";

const FALLBACK = "handler failed";

function namedError(name: string, code: unknown): Error {
  const error = new Error("denied");
  error.name = name;
  Reflect.set(error, "code", code);
  return error;
}

describe("rpcHandlerError", () => {
  it("maps the forbidden error to forbidden with its message", () => {
    expect(
      rpcHandlerError(
        new experimental_PluginRpcForbiddenError("Admins only"),
        FALLBACK,
      ),
    ).toEqual({ code: "forbidden", message: "Admins only" });
  });

  it("treats any Error carrying the reserved name and code pair as forbidden", () => {
    expect(
      rpcHandlerError(
        namedError("PluginRpcForbiddenError", "forbidden"),
        FALLBACK,
      ),
    ).toEqual({ code: "forbidden", message: "denied" });
  });

  it.each([
    ["only the code", namedError("Error", "forbidden")],
    ["only the name", namedError("PluginRpcForbiddenError", "not_forbidden")],
    [
      "the name without a code",
      namedError("PluginRpcForbiddenError", undefined),
    ],
    [
      "a plain object with the pair",
      { name: "PluginRpcForbiddenError", code: "forbidden", message: "denied" },
    ],
    ["a string", "forbidden"],
  ])("keeps %s as handler_error", (_label, error) => {
    expect(rpcHandlerError(error, FALLBACK)).toEqual({
      code: "handler_error",
      message: FALLBACK,
    });
  });
});
