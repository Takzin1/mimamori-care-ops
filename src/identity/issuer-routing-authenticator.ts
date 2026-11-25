import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type PrincipalAuthenticator,
} from "./types.ts";

/**
 * Chooses ONE identity provider per bearer token (ADR 0021):
 *  - a JWT whose unverified `iss` claim equals the configured Supabase Auth
 *    issuer goes to Supabase Auth;
 *  - every other token goes to the fallback provider (LINE Login).
 * The claim is used only for routing. The chosen provider fully verifies the
 * token, and a token is never offered to a second provider after a failure, so
 * a Supabase session token is never sent to LINE and vice versa.
 * Principal IDs stay provider-namespaced (Supabase user ID vs `line:<userId>`).
 */
export interface IssuerRoutingAuthenticatorOptions {
  supabaseIssuer: string;
  supabase: PrincipalAuthenticator;
  fallback: PrincipalAuthenticator;
}

const MAX_TOKEN_LENGTH = 8 * 1024;

function decodeSegment(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Unverified `iss` claim of a compact JWS, or null for anything else. */
export function claimedIssuer(token: string): string | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodeSegment(parts[1]!);
  if (!payload) return null;
  try {
    const claims = JSON.parse(payload) as unknown;
    const iss = claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as { iss?: unknown }).iss : undefined;
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

export function supabaseAuthIssuer(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  return `${url.origin}/auth/v1`;
}

export class IssuerRoutingAuthenticator implements PrincipalAuthenticator {
  readonly #supabaseIssuer: string;
  readonly #supabase: PrincipalAuthenticator;
  readonly #fallback: PrincipalAuthenticator;

  constructor(options: IssuerRoutingAuthenticatorOptions) {
    const issuer = options.supabaseIssuer?.trim();
    if (!issuer) throw new Error("Supabase Auth issuer is required");
    this.#supabaseIssuer = issuer;
    this.#supabase = options.supabase;
    this.#fallback = options.fallback;
  }

  authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
    if (typeof accessToken !== "string" || !accessToken || accessToken.length > MAX_TOKEN_LENGTH) {
      return Promise.reject(new AuthenticationError());
    }
    return claimedIssuer(accessToken) === this.#supabaseIssuer
      ? this.#supabase.authenticate(accessToken)
      : this.#fallback.authenticate(accessToken);
  }
}
