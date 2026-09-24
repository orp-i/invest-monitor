import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "@invest/adapters";
import { CollectorScheduler } from "@invest/collector";
import { parseConfigText, type ConfigSnapshot } from "@invest/config";
import type { EgressHttpClient } from "@invest/egress";
import type { StorageDriver } from "@invest/storage";

async function snapshotWithMassiveEnabled(enabled: boolean): Promise<ConfigSnapshot> {
  const text = await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8");
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return {
    config: {
      ...parsed.config,
      sources: parsed.config.sources.map((source) =>
        source.id === "massive-stocks" ? { ...source, enabled } : source),
    },
    generation: 1,
    sha256: parsed.sha256,
    loadedAt: parsed.loadedAt,
  };
}

function storageStub(): StorageDriver {
  return {
    upsertInstrument: async () => undefined,
    upsertSourceBinding: async () => undefined,
  } as unknown as StorageDriver;
}

describe("M1 source capability negotiation", () => {
  it("keeps Massive capabilities unavailable while the configured source is disabled", async () => {
    const scheduler = new CollectorScheduler(
      storageStub(),
      {} as EgressHttpClient,
      createAdapterRegistry(),
      async () => "fixture-key",
    );
    await scheduler.applySnapshot(await snapshotWithMassiveEnabled(false));
    expect(scheduler.sourceFreshnessClass("massive-stocks")).toBe("delayed");
    expect(scheduler.sourceCapabilityAvailable("massive-stocks", "quote")).toBe(false);
  });

  it("requires both an enabled source and a resolved credential", async () => {
    const missingCredential = new CollectorScheduler(
      storageStub(),
      {} as EgressHttpClient,
      createAdapterRegistry(),
      async () => null,
    );
    await missingCredential.applySnapshot(await snapshotWithMassiveEnabled(true));
    expect(missingCredential.sourceAuthConfigured("massive-stocks")).toBe(false);
    expect(missingCredential.sourceCapabilityAvailable("massive-stocks", "quote")).toBe(false);

    const configured = new CollectorScheduler(
      storageStub(),
      {} as EgressHttpClient,
      createAdapterRegistry(),
      async () => "fixture-key",
    );
    await configured.applySnapshot(await snapshotWithMassiveEnabled(true));
    expect(configured.sourceAuthConfigured("massive-stocks")).toBe(true);
    expect(configured.sourceCapabilityAvailable("massive-stocks", "quote")).toBe(true);
  });
});
