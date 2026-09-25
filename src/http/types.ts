export interface AuthenticatedPrincipal {
  principalId: string;
}

export interface RequestAuthenticator {
  authenticate(
    request: Request,
  ): Promise<AuthenticatedPrincipal | null>;
}

export interface HttpApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export type RequestIdFactory = () => string;
