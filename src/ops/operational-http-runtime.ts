import type {
  CareOpsMetricLabels,
  CareOpsOperationalLogRecord,
  CareOpsRouteClass,
  OperationalCareOpsRuntimeOptions,
} from "./types.ts";

function json(
  body: unknown,
  status: number,
  requestId?: string,
): Response {
  const headers = new Headers({
    "content-type":
      "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  if (requestId) {
    headers.set(
      "x-request-id",
      requestId,
    );
  }

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers,
    },
  );
}

function statusClass(
  status: number,
): string {
  if (status >= 100 && status <= 599) {
    return `${Math.floor(status / 100)}xx`;
  }

  return "unknown";
}

function method(
  request: Request,
): string {
  return request.method
    .trim()
    .toUpperCase() || "UNKNOWN";
}

function routeClass(
  request: Request,
): CareOpsRouteClass {
  const pathname =
    new URL(request.url).pathname;

  if (pathname === "/healthz") {
    return "health";
  }

  if (pathname === "/readyz") {
    return "readiness";
  }

  return "care_ops";
}

function bodyless(
  response: Response,
  requestMethod: string,
): Response {
  if (requestMethod !== "HEAD") {
    return response;
  }

  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}

export class OperationalCareOpsRuntime {
  readonly #handler:
    OperationalCareOpsRuntimeOptions["handler"];
  readonly #logger:
    OperationalCareOpsRuntimeOptions["logger"];
  readonly #metrics:
    OperationalCareOpsRuntimeOptions["metrics"];
  readonly #readinessChecks:
    readonly NonNullable<
      OperationalCareOpsRuntimeOptions[
        "readinessChecks"
      ]
    >[number][];
  readonly #now: () => string;
  readonly #nowMs: () => number;
  readonly #requestIdFactory: () => string;

  constructor(
    options: OperationalCareOpsRuntimeOptions,
  ) {
    this.#handler = options.handler;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#readinessChecks =
      options.readinessChecks ?? [];
    this.#now =
      options.now ??
      (() => new Date().toISOString());
    this.#nowMs =
      options.nowMs ??
      (() => performance.now());
    this.#requestIdFactory =
      options.requestIdFactory ??
      (() => crypto.randomUUID());
  }

  async #safeLog(
    record: CareOpsOperationalLogRecord,
  ): Promise<void> {
    try {
      await this.#logger?.write(record);
    } catch {
      // Observability must not break request handling.
    }
  }

  async #safeMetrics(
    route: CareOpsRouteClass,
    requestMethod: string,
    status: number,
    durationMs: number,
  ): Promise<void> {
    if (!this.#metrics) return;

    const labels: CareOpsMetricLabels = {
      routeClass: route,
      method: requestMethod,
      statusClass: statusClass(status),
    };

    try {
      await this.#metrics.increment(
        "care_ops_http_requests_total",
        labels,
      );
    } catch {
      // Metrics are best-effort.
    }

    try {
      await this.#metrics.observe(
        "care_ops_http_request_duration_ms",
        durationMs,
        labels,
      );
    } catch {
      // Metrics are best-effort.
    }
  }

  async #finish(
    route: CareOpsRouteClass,
    requestMethod: string,
    response: Response,
    startedAt: number,
  ): Promise<Response> {
    const durationMs = Math.max(
      0,
      this.#nowMs() - startedAt,
    );

    const requestId =
      response.headers.get(
        "x-request-id",
      );

    await this.#safeLog({
      event: "http_request_completed",
      at: this.#now(),
      requestId,
      routeClass: route,
      method: requestMethod,
      status: response.status,
      durationMs,
    });

    await this.#safeMetrics(
      route,
      requestMethod,
      response.status,
      durationMs,
    );

    return response;
  }

  async #health(
    requestMethod: string,
    startedAt: number,
  ): Promise<Response> {
    const response = json(
      { status: "ok" },
      200,
    );

    return bodyless(
      await this.#finish(
        "health",
        requestMethod,
        response,
        startedAt,
      ),
      requestMethod,
    );
  }

  async #readiness(
    requestMethod: string,
    startedAt: number,
  ): Promise<Response> {
    let ready = true;

    for (
      const check of
        this.#readinessChecks
    ) {
      try {
        if (!(await check.check())) {
          ready = false;
        }
      } catch {
        ready = false;
      }
    }

    const status = ready ? 200 : 503;
    const durationMs = Math.max(
      0,
      this.#nowMs() - startedAt,
    );

    await this.#safeLog({
      event: "readiness_evaluated",
      at: this.#now(),
      requestId: null,
      routeClass: "readiness",
      method:
        requestMethod === "HEAD"
          ? "HEAD"
          : "GET",
      status,
      durationMs,
      ready,
      checkCount:
        this.#readinessChecks.length,
    });

    await this.#safeMetrics(
      "readiness",
      requestMethod,
      status,
      durationMs,
    );

    return bodyless(
      json(
        {
          status:
            ready
              ? "ready"
              : "not_ready",
        },
        status,
      ),
      requestMethod,
    );
  }

  async handle(
    request: Request,
  ): Promise<Response> {
    const startedAt =
      this.#nowMs();
    const requestMethod =
      method(request);
    const route =
      routeClass(request);

    if (
      route === "health" &&
      (
        requestMethod === "GET" ||
        requestMethod === "HEAD"
      )
    ) {
      return this.#health(
        requestMethod,
        startedAt,
      );
    }

    if (
      route === "readiness" &&
      (
        requestMethod === "GET" ||
        requestMethod === "HEAD"
      )
    ) {
      return this.#readiness(
        requestMethod,
        startedAt,
      );
    }

    try {
      const response =
        await this.#handler.handle(request);

      return await this.#finish(
        "care_ops",
        requestMethod,
        response,
        startedAt,
      );
    } catch {
      const requestId =
        this.#requestIdFactory();

      const response = json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message:
              "Internal server error",
            requestId,
          },
        },
        500,
        requestId,
      );

      return await this.#finish(
        "care_ops",
        requestMethod,
        response,
        startedAt,
      );
    }
  }
}
