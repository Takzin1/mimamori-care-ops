import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type PrincipalAuthenticator,
} from "./types.ts";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseAuthAuthenticatorOptions {
  baseUrl: string;
  publishableKey: string;
  fetchImpl?: FetchLike;
}

interface SupabaseUserResponse {
  id?: unknown;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export class SupabaseAuthAuthenticator
implements PrincipalAuthenticator {
  private readonly baseUrl: string;
  private readonly publishableKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SupabaseAuthAuthenticatorOptions) {
    const baseUrl = requireText(
      options.baseUrl,
      "Supabase base URL",
    );

    this.baseUrl = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    this.publishableKey = requireText(
      options.publishableKey,
      "Supabase publishable key",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authenticate(
    accessToken: string,
  ): Promise<AuthenticatedPrincipal> {
    const token = requireText(
      accessToken,
      "access token",
    );

    let response: Response;

    try {
      response = await this.fetchImpl(
        new URL(`${this.baseUrl}/auth/v1/user`),
        {
          method: "GET",
          headers: {
            apikey: this.publishableKey,
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
        },
      );
    } catch {
      throw new AuthenticationError();
    }

    if (!response.ok) {
      throw new AuthenticationError();
    }

    let body: SupabaseUserResponse;

    try {
      body = await response.json() as SupabaseUserResponse;
    } catch {
      throw new AuthenticationError();
    }

    if (
      typeof body.id !== "string" ||
      !body.id.trim()
    ) {
      throw new AuthenticationError();
    }

    return {
      principalId: body.id,
      provider: "supabase-auth",
    };
  }
}
