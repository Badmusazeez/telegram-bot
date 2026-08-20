import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatDropStagesSummary,
  isPublicOrGeneralStage,
  type OpenSeaDrop,
  type OpenSeaDropStage,
} from "./openseaDrop";
import { formatScheduleCreated } from "../telegram/formatter";
import type { ScheduledMint } from "../types";

describe("isPublicOrGeneralStage", () => {
  it("detects public / general stages", () => {
    assert.equal(
      isPublicOrGeneralStage({ stage_type: "public_sale", label: "Public" }),
      true
    );
    assert.equal(
      isPublicOrGeneralStage({ stage_type: "PUBLIC", label: "General mint" }),
      true
    );
  });

  it("rejects allowlist / whitelist", () => {
    assert.equal(
      isPublicOrGeneralStage({ stage_type: "allowlist", label: "WL" }),
      false
    );
    assert.equal(
      isPublicOrGeneralStage({
        stage_type: "public",
        label: "Allowlist holders",
      }),
      false
    );
  });
});

describe("formatDropStagesSummary", () => {
  it("lists every stage time and marks TARGET", () => {
    const publicStage: OpenSeaDropStage = {
      uuid: "2",
      label: "Public",
      stage_type: "public_sale",
      price: "0",
      start_time: "2026-08-21T20:00:00.000Z",
    };
    const drop: OpenSeaDrop = {
      collection_slug: "phoenix-in-the-hood",
      chain: "robinhood",
      contract_address: "0x6209e8d1e28cc40427f8e7ec8cc1e9410a35612a",
      stages: [
        {
          uuid: "1",
          label: "Allowlist",
          stage_type: "allowlist",
          price: "0",
          start_time: "2026-08-21T18:00:00.000Z",
        },
        publicStage,
      ],
    };
    const summary = formatDropStagesSummary(drop, publicStage);
    assert.match(summary, /Allowlist/);
    assert.match(summary, /Public/);
    assert.match(summary, /← TARGET/);
    assert.match(summary, /2026-08-21T20:00:00\.000Z/);
  });
});

describe("formatScheduleCreated sharp mode", () => {
  it("matches sharp Telegram copy", () => {
    const job: ScheduledMint = {
      id: "sch_test",
      scheduleNumber: 213,
      label: "phoenix-in-the-hood",
      to: "0x6209e8d1e28cc40427f8e7ec8cc1e9410a35612a",
      data: "0x",
      executeAt: "2026-08-21T20:00:00.000Z",
      createdAt: "2026-08-20T20:00:00.000Z",
      status: "pending",
      openSeaSlug: "phoenix-in-the-hood",
      sharpMode: true,
      leadMs: 15_000,
      stageLabel: "Public",
      stageType: "public_sale",
      stagesSummary: "• Allowlist — …\n• Public — … ← TARGET",
    };
    const html = formatScheduleCreated(job);
    assert.match(html, /Scheduled #213/);
    assert.match(html, /phoenix-in-the-hood/);
    assert.match(html, /Keys:<\/b> all/);
    assert.match(html, /T-15s · sharp mode \(exact timer \+ burst\)/);
    assert.match(html, /Keep the bot running/);
  });
});
