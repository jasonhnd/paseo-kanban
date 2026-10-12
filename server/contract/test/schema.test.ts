import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONTRACT_SCHEMA, EXPORTS, Envelope, RoleMatrix, type ExportKind } from "../../../shared/contract/schema";
import { INVALID, VALID } from "./fixtures";

const KINDS = Object.keys(EXPORTS) as ExportKind[];

test("model branches survive parsing alongside legacy metadata and malformed models cannot fall back", () => {
  const legacy = { byExecutorFamily: { demo: { L2: [{ profile: "Demo legacy", effort: "high" }] } } };
  const model = { byExecutorModel: { "demo-alpha": { L2: [{ profile: "Demo reviewer", effort: "high" }] } } };
  assert.deepEqual(RoleMatrix.parse({ ...legacy, ...model }), { ...legacy, ...model });
  assert.deepEqual(RoleMatrix.parse(legacy), legacy);
  for (const bad of [null, [], "invalid", { "": { L2: [] } }, { "demo-alpha": { L2: [{ effort: "high" }] } }]) {
    assert.equal(RoleMatrix.safeParse({ ...legacy, byExecutorModel: bad }).success, false);
  }
  assert.deepEqual(RoleMatrix.parse({ byExecutorModel: {} }), { byExecutorModel: {} });
});

describe("export payload schemas", () => {
  for (const kind of KINDS) {
    test(`${kind}: accepts the demo payload`, () => {
      const result = EXPORTS[kind].schema.safeParse(VALID[kind]);
      assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
    });

    test(`${kind}: rejects ${INVALID[kind].label}`, () => {
      assert.equal(EXPORTS[kind].schema.safeParse(INVALID[kind].value).success, false);
    });

    test(`${kind}: rejects another schema version`, () => {
      const result = EXPORTS[kind].schema.safeParse({ ...VALID[kind], schema: "fleet-quota/v2" });
      assert.equal(result.success, false);
    });

    test(`${kind}: default TTL matches the envelope rules`, () => {
      assert.ok(Number.isInteger(EXPORTS[kind].ttlSeconds) && EXPORTS[kind].ttlSeconds > 0);
    });
  }

  test("file names are unique per producer", () => {
    const keys = KINDS.map((kind) => `${EXPORTS[kind].producer}/${EXPORTS[kind].file}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  test("unknown extra fields are tolerated so v1 can grow", () => {
    const result = EXPORTS.poolStatus.schema.safeParse({ ...VALID.poolStatus, addedLater: true });
    assert.equal(result.success, true);
  });
});

describe("envelope", () => {
  const base = { ...VALID.cockpit };

  test("requires a positive integer TTL", () => {
    assert.equal(Envelope.safeParse({ ...base, ttlSeconds: 0 }).success, false);
    assert.equal(Envelope.safeParse({ ...base, ttlSeconds: 1.5 }).success, false);
  });

  test("requires an ISO timestamp", () => {
    assert.equal(Envelope.safeParse({ ...base, generatedAt: "2030-01-01" }).success, false);
    assert.equal(Envelope.safeParse({ ...base, generatedAt: "2030-01-01T09:00:00+09:00" }).success, true);
  });

  test("only knows the two plugins as producers", () => {
    assert.equal(Envelope.safeParse({ ...base, producer: "someone-else" }).success, false);
  });

  test("schema literal is fleet-quota/v1", () => {
    assert.equal(CONTRACT_SCHEMA, "fleet-quota/v1");
  });
});
