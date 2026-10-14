import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  schema,
  server,
  serverMembers,
  user,
  parseVisitorHost,
  type ConnectDb,
} from "@bb/connect-db";
import { GATE_IDENTITY_TTL_MS, type GateIdentity } from "@bb/tunnel-contract";
import { resolveAccount } from "./servers.js";
import { resolveConnectRuntime } from "./cloud-dev.js";
import { jsonResponse, methodNotAllowed } from "./json-response.js";
import type { Env } from "./tunnel-do.js";

export async function gateIdentityForUser(
  db: ConnectDb,
  userId: string,
  ownerUserId: string,
  serverId: string,
): Promise<GateIdentity | null> {
  if (userId !== ownerUserId) {
    const member = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, serverId),
          eq(serverMembers.userId, userId),
        ),
      )
      .get();
    if (member === undefined) return null;
  }
  const account = await db
    .select({ email: user.email, verified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (account === undefined || !account.verified) return null;
  return {
    userId,
    email: account.email,
    serverId,
    expiresAt: Date.now() + GATE_IDENTITY_TTL_MS,
  };
}

export async function handleServerMembers(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!["GET", "POST", "DELETE"].includes(request.method))
    return methodNotAllowed("GET, POST, DELETE");
  const db = drizzle(env.DB, { schema });
  const runtime = resolveConnectRuntime(env);
  const origin = request.headers.get("origin");
  if (
    request.method !== "GET" &&
    origin !== null &&
    origin !== new URL(request.url).origin &&
    origin !== runtime.accountAppUrl
  )
    return jsonResponse({ error: "untrusted_origin" }, 403);
  const account = await resolveAccount(
    request,
    env.BETTER_AUTH_SECRET,
    db,
    runtime.sessionCookieName,
  );
  if (account === null || account.grant.kind === "machine")
    return jsonResponse({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  let serverId = url.searchParams.get("serverId");
  if (account.grant.kind === "server") {
    const row = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.credentialHash, account.grant.credentialHash))
      .get();
    if (row === undefined)
      return jsonResponse({ error: "unauthorized" }, 401);
    if (serverId !== null && serverId !== row.id)
      return jsonResponse({ error: "server_mismatch" }, 403);
    serverId = row.id;
  }
  if (serverId === null) {
    const visitor = parseVisitorHost(url.host, env.BASE_DOMAIN);
    if (visitor !== null && visitor.target === null) {
      const row = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.subdomain, visitor.handle))
        .get();
      serverId = row?.id ?? null;
    }
  }
  if (serverId === null || serverId.length === 0)
    return jsonResponse({ error: "server_id_required" }, 400);
  const owned = await db
    .select({ userId: server.userId })
    .from(server)
    .where(
      and(
        eq(server.id, serverId),
        eq(server.userId, account.userId),
        isNull(server.revokedAt),
      ),
    )
    .get();
  if (owned === undefined)
    return jsonResponse({ error: "owner_required" }, 403);
  if (request.method === "GET") {
    const members = await db
      .select({ userId: user.id, email: user.email, role: serverMembers.role })
      .from(serverMembers)
      .innerJoin(user, eq(user.id, serverMembers.userId))
      .where(eq(serverMembers.serverId, serverId))
      .all();
    if (request.headers.get("accept")?.includes("text/html"))
      return membershipPage(members);
    return jsonResponse({ members }, 200);
  }
  if (request.method === "DELETE") {
    const userId = url.searchParams.get("userId");
    if (!userId) return jsonResponse({ error: "user_id_required" }, 400);
    await db
      .delete(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, serverId),
          eq(serverMembers.userId, userId),
        ),
      )
      .run();
    return jsonResponse({ ok: true }, 200);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (typeof body !== "object" || body === null)
    return jsonResponse({ error: "invalid_request" }, 400);
  const email: unknown = Reflect.get(body, "email");
  const role: unknown = Reflect.get(body, "role");
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    (role !== "admin" && role !== "member")
  )
    return jsonResponse({ error: "invalid_request" }, 400);
  const member = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .get();
  if (member === undefined)
    return jsonResponse({ error: "account_not_found" }, 404);
  if (member.id === owned.userId)
    return jsonResponse({ error: "owner_cannot_be_member" }, 409);
  await db
    .insert(serverMembers)
    .values({ serverId, userId: member.id, role, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [serverMembers.serverId, serverMembers.userId],
      set: { role },
    })
    .run();
  return jsonResponse(
    { member: { userId: member.id, email: email.trim().toLowerCase(), role } },
    200,
  );
}

function membershipPage(
  members: { userId: string; email: string; role: "admin" | "member" }[],
): Response {
  const data = JSON.stringify(members).replace(/</gu, "\\u003c");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Server access</title>
<style>:root{color-scheme:light dark}body{font:1rem/1.5 system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem}input,select,button{font:inherit;padding:.5rem}li{margin:1rem 0}button{margin-left:.5rem}</style>
<h1>Server access</h1><p>Share this server with an existing bb account. In multi-user mode, also invite their email in the server's Account settings. New accounts join as members. People who run agents can access the host shell and secrets.</p>
<form id="add"><label>Email <input type="email" name="email" required></label><label>Gate role <select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button>Add account</button></form>
<p>Gate roles do not change local server roles. Only the owner can manage this list.</p><p id="status" role="status"></p><ul id="members"></ul>
<script type="module">const members=${data};const list=document.getElementById('members');const status=document.getElementById('status');
async function send(method,body,userId){const url=new URL(location.href);if(userId)url.searchParams.set('userId',userId);const response=await fetch(url,{method,headers:{'content-type':'application/json',accept:'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.error);location.reload()}
for(const member of members){const item=document.createElement('li');item.append(document.createTextNode(member.email+' ('+member.role+')'));const button=document.createElement('button');button.textContent='Remove';button.addEventListener('click',()=>send('DELETE',null,member.userId).catch(error=>status.textContent=error.message));item.append(button);list.append(item)}
document.getElementById('add').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.target);send('POST',{email:form.get('email'),role:form.get('role')}).catch(error=>status.textContent=error.message)});</script></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
