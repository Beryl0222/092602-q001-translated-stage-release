import { Service } from "../src/service.js";
import { Repository } from "../src/repository.js";
import { ManualClock } from "../src/clock.js";

/** 搭好片段、原稿（含敏感行）、英文分支与剧目。 */
export function baseService(options = {}) {
  const { journalPath = null, ...serviceOptions } = options;
  const clock = new ManualClock("2026-10-01T00:00:00.000Z");
  const service = new Service({
    clock,
    packageLeadMs: 60 * 60 * 1000,
    ...(journalPath ? { repository: new Repository({ journalPath }) } : {}),
    ...serviceOptions,
  });
  service.registerChannel({ channel_id: "ch-live", kind: "现场字幕" });
  service.registerFragment({ fragment_id: "frag-1", title: "搬迁记忆" });
  service.registerManuscript({
    manuscript_id: "ms-1",
    fragment_id: "frag-1",
    author_id: "writer-1",
    lines: [
      { line_id: "L1", text: "我们搬到了闽宁镇。" },
      { line_id: "L2", text: "那是1997年的春天。", involves_history: true },
      { line_id: "L3", text: "马得福站在村口。", involves_identity: true, person_refs: ["person-ma"], requires_license: true },
    ],
  });
  service.openBranch({
    branch_id: "br-en",
    manuscript_id: "ms-1",
    manuscript_version: 1,
    language: "en",
    translator_id: "tr-1",
    base_lines: {
      L1: "We moved to Minning.",
      L2: "It was the spring of 1997.",
      L3: "Ma Defu stood at the village gate.",
    },
  });
  service.registerProduction({
    production_id: "prod-1",
    fragment_id: "frag-1",
    manuscript_id: "ms-1",
    manuscript_version: 1,
    branch_id: "br-en",
    title: "山海情·选段",
  });
  return { service, clock };
}
