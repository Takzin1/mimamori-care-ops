import {
  OperationalCareOpsRuntime,
} from "../ops/operational-http-runtime.ts";
import type {
  OperationalCareOpsRuntimeOptions,
} from "../ops/types.ts";
import {
  SupabaseCareOpsRuntime,
  type SupabaseCareOpsRuntimeOptions,
} from "./supabase-care-ops-runtime.ts";

export interface OperationalSupabaseCareOpsRuntimeOptions {
  runtime: SupabaseCareOpsRuntimeOptions;
  operations?: Omit<
    OperationalCareOpsRuntimeOptions,
    "handler"
  >;
}

export class OperationalSupabaseCareOpsRuntime {
  readonly #runtime:
    OperationalCareOpsRuntime;

  constructor(
    options:
      OperationalSupabaseCareOpsRuntimeOptions,
  ) {
    const careOps =
      new SupabaseCareOpsRuntime(
        options.runtime,
      );

    this.#runtime =
      new OperationalCareOpsRuntime({
        ...options.operations,
        handler: careOps,
      });
  }

  handle(
    request: Request,
  ): Promise<Response> {
    return this.#runtime.handle(request);
  }
}

export function createOperationalSupabaseCareOpsRuntime(
  options:
    OperationalSupabaseCareOpsRuntimeOptions,
): OperationalSupabaseCareOpsRuntime {
  return new OperationalSupabaseCareOpsRuntime(
    options,
  );
}
