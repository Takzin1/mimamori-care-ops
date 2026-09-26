export const CARE_OPS_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9._:-]{1,128}$/;

export function isCareOpsIdentifier(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    CARE_OPS_IDENTIFIER_PATTERN.test(value)
  );
}

export function requireCareOpsIdentifier(
  value: string,
  label: string,
): string {
  if (!isCareOpsIdentifier(value)) {
    throw new Error(
      `${label} is not a valid Care Ops identifier`,
    );
  }

  return value;
}
