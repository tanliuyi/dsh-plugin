import assert from "node:assert/strict";
import test from "node:test";

import {
  apiKeyError,
  CUSTOM_PROVIDER_ROUTE_PATTERN,
  deriveCredentialRef,
  parseModelCapacity,
} from "../web/src/dsh/settings-provider.ts";

test("custom provider route and credential reference follow rc8 rules", () => {
  assert.equal(CUSTOM_PROVIDER_ROUTE_PATTERN.test("acme-gateway"), true);
  assert.equal(CUSTOM_PROVIDER_ROUTE_PATTERN.test("2gateway"), false);
  assert.equal(CUSTOM_PROVIDER_ROUTE_PATTERN.test("Acme_Gateway"), false);
  assert.equal(deriveCredentialRef("acme-gateway"), "ACME_GATEWAY_API_KEY");
});

test("provider API key validation matches printable unwrapped credential input", () => {
  assert.equal(apiKeyError(""), undefined);
  assert.equal(apiKeyError("sk-valid=="), undefined);
  assert.equal(apiKeyError("   "), "API Key 格式无效。");
  assert.equal(apiKeyError("OPENAI_API_KEY=value"), "API Key 格式无效。");
  assert.equal(apiKeyError("\"sk-wrapped\""), "API Key 格式无效。");
  assert.equal(apiKeyError("key with spaces"), "API Key 格式无效。");
});

test("provider model capacities accept decimal K and M suffixes", () => {
  assert.equal(parseModelCapacity("256K"), 256_000);
  assert.equal(parseModelCapacity("1M"), 1_000_000);
  assert.equal(parseModelCapacity("2.5M"), 2_500_000);
  assert.equal(parseModelCapacity(""), undefined);
  assert.equal(Number.isNaN(parseModelCapacity("0")), true);
  assert.equal(Number.isNaN(parseModelCapacity("many")), true);
});
