import type { FrameworkSector, IndustryPack } from "../types.ts";
import { CARE_PACK } from "./care.ts";
import { EDUCATION_PACK } from "./education.ts";
import { HEALTHCARE_PACK } from "./healthcare.ts";
import { PUBLIC_PACK } from "./public.ts";

export const INDUSTRY_PACKS: Readonly<Record<FrameworkSector, IndustryPack>> = {
  care: CARE_PACK,
  education: EDUCATION_PACK,
  healthcare: HEALTHCARE_PACK,
  public: PUBLIC_PACK,
};

export function industryPack(sector: FrameworkSector): IndustryPack {
  return INDUSTRY_PACKS[sector];
}

export function templateRef(pack: IndustryPack, key: string): string {
  return `pack:${pack.id}@${pack.version}#${key}`;
}

export { standardScenario } from "./scenario-builder.ts";
export { CARE_PACK, EDUCATION_PACK, HEALTHCARE_PACK, PUBLIC_PACK };
