export const GATE_IDENTITY_HEADER = "x-bb-gate-identity";
export const GATE_IDENTITY_TTL_MS = 60_000;

export interface GateIdentity {
  userId: string;
  email: string;
  serverId: string;
  expiresAt: number;
}

export function parseGateIdentity(value: unknown): GateIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const userId: unknown = Reflect.get(value, "userId");
  const email: unknown = Reflect.get(value, "email");
  const serverId: unknown = Reflect.get(value, "serverId");
  const expiresAt: unknown = Reflect.get(value, "expiresAt");
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    userId.length > 256 ||
    typeof email !== "string" ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    typeof serverId !== "string" ||
    serverId.length === 0 ||
    serverId.length > 256 ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  )
    return null;
  return { userId, email, serverId, expiresAt };
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("Invalid identity encoding");
  return Uint8Array.from(
    atob(value.replace(/-/gu, "+").replace(/_/gu, "/")),
    (char) => char.charCodeAt(0),
  );
}

async function signingKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function signingInput(payload: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(`bb-connect-identity.v1.${payload}`),
  );
}

export async function signGateIdentity(
  identity: GateIdentity,
  secret: string,
): Promise<string> {
  const payload = encode(new TextEncoder().encode(JSON.stringify(identity)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret, "sign"),
    signingInput(payload),
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyGateIdentity(
  token: string,
  secret: string,
  serverId: string,
  now = Date.now(),
): Promise<GateIdentity | null> {
  if (token.length > 4096 || secret.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret, "verify"),
      new Uint8Array(decode(signature)),
      signingInput(payload),
    );
    if (!valid) return null;
    const value: unknown = JSON.parse(
      new TextDecoder().decode(decode(payload)),
    );
    const identity = parseGateIdentity(value);
    if (
      identity === null ||
      identity.serverId !== serverId ||
      identity.expiresAt <= now ||
      identity.expiresAt > now + GATE_IDENTITY_TTL_MS
    )
      return null;
    return identity;
  } catch {
    return null;
  }
}
