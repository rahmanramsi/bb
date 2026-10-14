import { describe, expect, it } from "vitest";
import { createBBSdk } from "../src/public-sdk.js";

describe("public SDK", () => {
  it("exposes authentication alongside the other SDK areas", () => {
    const sdk = createBBSdk({ baseUrl: "http://127.0.0.1:4000" });
    expect(sdk.experimental_auth).toBeDefined();
    expect(sdk.experimental_auth.session).toBeTypeOf("function");
  });
});
