import {
  outboundAbortSignal,
  outboundTimeoutMs,
} from "../outbound.ts";
import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type PrincipalAuthenticator,
} from "./types.ts";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LineAccessTokenAuthenticatorOptions {
  /** LINE Login channel ID that issued the LIFF / LINE MINI App access token. */
  channelId: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  /** Overridable only for tests; production uses https://api.line.me. */
  apiOrigin?: string;
}

export const LINE_PRINCIPAL_PREFIX = "line:";

const LINE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

async function readObject(
  response: Response,
): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new AuthenticationError();
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new AuthenticationError();
  }

  return body as Record<string, unknown>;
}

/**
 * Verifies a LINE Login (LIFF / LINE MINI App) access token server-side.
 *
 * 1. `GET /oauth2/v2.1/verify` — the token must be issued for the configured
 *    LINE Login channel and must not be expired.
 * 2. `GET /v2/profile` — the LINE user ID becomes the principal ID
 *    (`line:<userId>`). It is only an identity key for tenant membership;
 *    roles and actor IDs still come exclusively from the membership directory.
 *
 * Every failure, including upstream unavailability, fails closed as an
 * AuthenticationError, matching the Supabase Auth authenticator contract.
 * The access token is never logged or echoed.
 */
export class LineAccessTokenAuthenticator
implements PrincipalAuthenticator {
  private readonly channelId: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly apiOrigin: string;

  constructor(options: LineAccessTokenAuthenticatorOptions) {
    this.channelId = requireText(
      options.channelId,
      "LINE Login channel ID",
    );
    if (!/^\d{6,20}$/.test(this.channelId)) {
      throw new Error("LINE Login channel ID must be numeric");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = outboundTimeoutMs(
      options.requestTimeoutMs,
    );
    const origin = new URL(
      options.apiOrigin ?? "https://api.line.me",
    );
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("LINE API origin must be an https origin");
    }
    this.apiOrigin = origin.origin;
  }

  private async get(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(
        url,
        {
          method: "GET",
          signal: outboundAbortSignal(
            this.requestTimeoutMs,
          ),
          headers: {
            accept: "application/json",
            ...headers,
          },
          redirect: "error",
        },
      );
    } catch {
      throw new AuthenticationError();
    }
  }

  async authenticate(
    accessToken: string,
  ): Promise<AuthenticatedPrincipal> {
    const token = requireText(
      accessToken,
      "access token",
    );

    const verifyUrl = new URL(
      "/oauth2/v2.1/verify",
      this.apiOrigin,
    );
    verifyUrl.searchParams.set("access_token", token);

    const verification = await this.get(verifyUrl, {});
    if (!verification.ok) {
      throw new AuthenticationError();
    }

    const verified = await readObject(verification);
    if (
      verified.client_id !== this.channelId ||
      typeof verified.expires_in !== "number" ||
      !(verified.expires_in > 0)
    ) {
      throw new AuthenticationError();
    }

    const profileResponse = await this.get(
      new URL("/v2/profile", this.apiOrigin),
      { authorization: `Bearer ${token}` },
    );
    if (!profileResponse.ok) {
      throw new AuthenticationError();
    }

    const profile = await readObject(profileResponse);
    if (
      typeof profile.userId !== "string" ||
      !LINE_USER_ID.test(profile.userId)
    ) {
      throw new AuthenticationError();
    }

    return {
      principalId: `${LINE_PRINCIPAL_PREFIX}${profile.userId}`,
      provider: "line",
    };
  }
}
