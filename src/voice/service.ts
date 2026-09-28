import {
  DemoIndonesianGuidanceTranslator,
} from "./language.ts";
import {
  RuleBasedDemoIncidentExtractor,
} from "./incident.ts";
import {
  buildVoiceOpsPlan,
  type VoiceOpsPlan,
} from "./workflow.ts";
import type {
  GuidanceTranslator,
  IncidentExtractor,
  VoiceTranscriptEvidence,
} from "./types.ts";

export interface VoiceOpsServiceOptions {
  extractor?: IncidentExtractor;
  translator?: GuidanceTranslator;
}

export class VoiceOpsService {
  readonly #extractor:
    IncidentExtractor;
  readonly #translator:
    GuidanceTranslator;

  constructor(
    options:
      VoiceOpsServiceOptions = {},
  ) {
    this.#extractor =
      options.extractor ??
      new RuleBasedDemoIncidentExtractor();
    this.#translator =
      options.translator ??
      new DemoIndonesianGuidanceTranslator();
  }

  plan(input: {
    tenantId: string;
    caseId: string;
    subjectId: string;
    locale: string;
    transcript:
      VoiceTranscriptEvidence;
  }): Promise<VoiceOpsPlan> {
    return buildVoiceOpsPlan({
      ...input,
      extractor:
        this.#extractor,
      translator:
        this.#translator,
    });
  }
}
