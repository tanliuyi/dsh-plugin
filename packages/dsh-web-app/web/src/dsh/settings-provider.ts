export const CUSTOM_PROVIDER_ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

export function deriveCredentialRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function apiKeyError(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const trimmed = value.trim();
  if (!trimmed || ENV_LINE.test(trimmed) || !LEGAL_API_KEY.test(trimmed)) return "API Key 格式无效。";
  const first = trimmed[0];
  if ((first === "\"" || first === "'" || first === "`") && trimmed.endsWith(first)) {
    return "API Key 格式无效。";
  }
  return undefined;
}

export function parseModelCapacity(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim());
  if (!match) return value.trim() ? Number.NaN : undefined;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const parsed = Number(match[1]) * scale;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}
