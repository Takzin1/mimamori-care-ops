import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

import { CRITICAL_FACT_KEYS } from "./critical-facts.ts";
import {
  GuardedApiSituationUnderstandingProvider,
  RuleBasedSituationUnderstandingProvider,
  SituationProviderError,
} from "./situation.ts";
import type {
  SituationUnderstandingTransport,
  SituationUnderstandingTransportRequest,
} from "./situation.ts";

export interface BedrockSituationOptions {
  region: string;
  modelId: string;
  bearerToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface LambdaBedrockSituationOptions {
  region: string;
  functionName: string;
  roleArn: string;
  timeoutMs?: number;
}

function validRegion(region: string): boolean {
  return /^(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d$/.test(region);
}

function validRoleArn(roleArn: string): boolean {
  return /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/.test(roleArn);
}

function validFunctionName(functionName: string): boolean {
  return (
    /^[A-Za-z0-9-_]{1,64}$/.test(functionName) ||
    /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9-_]{1,64}$/.test(
      functionName,
    )
  );
}

// Server-only Converse adapter retained for API-key compatibility.
export class BedrockSituationUnderstandingTransport
implements SituationUnderstandingTransport {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: BedrockSituationOptions) {
    if (
      !validRegion(options.region) ||
      !options.modelId ||
      options.modelId.length > 2048 ||
      /[\s/?#]/.test(options.modelId) ||
      !options.bearerToken ||
      /[\r\n]/.test(options.bearerToken)
    ) {
      throw new Error("Invalid Bedrock situation configuration");
    }

    this.#endpoint =
      `https://bedrock-runtime.${options.region}.amazonaws.com/model/${encodeURIComponent(options.modelId)}/converse`;
    this.#token = options.bearerToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async analyze(
    request: SituationUnderstandingTransportRequest,
  ): Promise<unknown> {
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          system: [{ text: request.instructions.join("\n") }],
          messages: [
            {
              role: "user",
              content: [
                {
                  text: JSON.stringify({
                    language: request.language,
                    rawTranscript: request.text,
                  }),
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 320, temperature: 0 },
        }),
      });

      if (!response.ok) {
        void response.body?.cancel();
        throw new Error("upstream failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty response");

      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 16384) {
            void reader.cancel();
            throw new Error("response too large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (
        body.stopReason !== "end_turn" ||
        body.output?.message?.role !== "assistant"
      ) {
        throw new Error("incomplete response");
      }

      const content = body.output.message.content;
      if (
        !Array.isArray(content) ||
        content.length !== 1 ||
        typeof content[0]?.text !== "string"
      ) {
        throw new Error("invalid response");
      }

      return JSON.parse(content[0].text);
    } catch {
      throw new SituationProviderError("Bedrock situation request failed");
    }
  }
}

// Preferred Preview transport:
// Vercel OIDC -> short-lived AWS credentials -> Lambda -> Bedrock.
// No AWS access key, secret key, or Bedrock API key is stored in Vercel.
export class LambdaBedrockSituationUnderstandingTransport
implements SituationUnderstandingTransport {
  readonly #functionName: string;
  readonly #client: LambdaClient;

  constructor(options: LambdaBedrockSituationOptions) {
    if (
      !validRegion(options.region) ||
      !validFunctionName(options.functionName) ||
      !validRoleArn(options.roleArn)
    ) {
      throw new Error("Invalid Lambda Bedrock situation configuration");
    }

    this.#functionName = options.functionName;
    this.#client = new LambdaClient({
      region: options.region,
      credentials: awsCredentialsProvider({
        roleArn: options.roleArn,
      }),
    });
  }

  async analyze(
    request: SituationUnderstandingTransportRequest,
  ): Promise<unknown> {
    try {
      const output = await this.#client.send(
        new InvokeCommand({
          FunctionName: this.#functionName,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(
            JSON.stringify({
              transcript: request.text,
              language: request.language,
            }),
          ),
        }),
        {
          abortSignal: request.signal,
        },
      );

      if (output.FunctionError || !output.Payload) {
        throw new Error("Lambda invocation failed");
      }

      const envelope = JSON.parse(
        new TextDecoder().decode(output.Payload),
      ) as {
        statusCode?: unknown;
        body?: unknown;
      };

      if (
        envelope.statusCode !== 200 ||
        typeof envelope.body !== "string"
      ) {
        throw new Error("Lambda returned non-success");
      }

      const body = JSON.parse(envelope.body) as {
        structured?: unknown;
      };

      if (
        !body.structured ||
        typeof body.structured !== "object" ||
        Array.isArray(body.structured)
      ) {
        throw new Error("Lambda returned invalid structured response");
      }

      const structured =
        body.structured as Record<string, unknown>;

      return Object.fromEntries(
        CRITICAL_FACT_KEYS.map(
          (key) => [key, structured[key]],
        ),
      );
    } catch {
      // Never propagate Lambda payloads, transcript, IAM details, or provider
      // bodies into logs/UI. Guarded provider will fail closed to local rules.
      throw new SituationProviderError(
        "Lambda Bedrock situation request failed",
      );
    }
  }
}

export class BedrockSituationUnderstandingProvider
extends GuardedApiSituationUnderstandingProvider {
  constructor(options: BedrockSituationOptions) {
    super({
      transport:
        new BedrockSituationUnderstandingTransport(options),
      fallback:
        new RuleBasedSituationUnderstandingProvider(),
      timeoutMs:
        options.timeoutMs,
      provider:
        "bedrock",
    });
  }
}

export class LambdaBedrockSituationUnderstandingProvider
extends GuardedApiSituationUnderstandingProvider {
  constructor(options: LambdaBedrockSituationOptions) {
    super({
      transport:
        new LambdaBedrockSituationUnderstandingTransport(options),
      fallback:
        new RuleBasedSituationUnderstandingProvider(),
      timeoutMs:
        options.timeoutMs,
      provider:
        "bedrock",
    });
  }
}

export function situationProviderFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
) {
  const selected =
    env.CARE_OPS_SITUATION_PROVIDER?.trim() ||
    "rule_based";

  if (selected === "rule_based") {
    return new RuleBasedSituationUnderstandingProvider();
  }

  if (selected !== "bedrock") {
    throw new Error("Invalid situation provider");
  }

  const timeoutMs =
    env.CARE_OPS_SITUATION_TIMEOUT_MS === undefined
      ? undefined
      : Number(env.CARE_OPS_SITUATION_TIMEOUT_MS);

  const transport =
    env.CARE_OPS_BEDROCK_TRANSPORT?.trim() ||
    "api_key";

  if (transport === "lambda") {
    return new LambdaBedrockSituationUnderstandingProvider({
      region:
        env.AWS_REGION?.trim() ?? "",
      functionName:
        env.CARE_OPS_BEDROCK_LAMBDA_FUNCTION_NAME?.trim() ?? "",
      roleArn:
        env.AWS_ROLE_ARN?.trim() ?? "",
      timeoutMs,
    });
  }

  if (transport !== "api_key") {
    throw new Error("Invalid Bedrock transport");
  }

  return new BedrockSituationUnderstandingProvider({
    region:
      env.AWS_REGION?.trim() ?? "",
    modelId:
      env.CARE_OPS_BEDROCK_MODEL_ID?.trim() ?? "",
    bearerToken:
      env.AWS_BEARER_TOKEN_BEDROCK?.trim() ?? "",
    timeoutMs,
  });
}
