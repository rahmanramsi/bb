import type { Hono } from "hono";
import { setRequestPrincipal } from "../../src/request-context.js";
import { LOCAL_OWNER_PRINCIPAL } from "../../src/services/user-auth.js";

export function actAsLocalOwner(app: Hono): void {
  app.use("*", async (context, next) => {
    setRequestPrincipal(context, LOCAL_OWNER_PRINCIPAL);
    await next();
  });
}
