/** 本地 JSON 命令入口。 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";
import { ManualClock } from "./clock.js";

const [command, arg] = [process.argv[2], process.argv[3]];
if (command === "validate" && arg) {
  const payload = JSON.parse(await readFile(arg, "utf8"));
  console.log(JSON.stringify(new Service().register(payload)));
} else if (command === "demo") {
  console.log(JSON.stringify(runDemo(), null, 2));
} else {
  console.log(JSON.stringify(new Service().health()));
}

/** 端到端演示：登记 → 敏感修订复核 → 时钟驱动生成发布包 → 撤回冻结 → 字幕追溯。 */
function runDemo() {
  const clock = new ManualClock("2026-10-07T08:00:00.000Z");
  const service = new Service({ clock, packageLeadMs: 2 * 60 * 60 * 1000 });
  service.registerChannel({ channel_id: "ch-live", kind: "现场字幕" });
  service.registerFragment({ fragment_id: "frag-1", title: "搬迁记忆" });
  service.registerManuscript({
    manuscript_id: "ms-1",
    fragment_id: "frag-1",
    author_id: "writer-1",
    lines: [
      { line_id: "L1", text: "我们搬到了闽宁镇。" },
      { line_id: "L2", text: "马得福站在村口。", involves_identity: true, person_refs: ["person-ma"], requires_license: true },
    ],
  });
  service.openBranch({
    branch_id: "br-en",
    manuscript_id: "ms-1",
    manuscript_version: 1,
    language: "en",
    translator_id: "tr-1",
    base_lines: { L1: "We moved to Minning.", L2: "Ma Defu stood at the village gate." },
  });
  service.registerProduction({
    production_id: "prod-1",
    fragment_id: "frag-1",
    manuscript_id: "ms-1",
    manuscript_version: 1,
    branch_id: "br-en",
    title: "山海情·选段",
  });
  service.registerApprover({ approver_id: "elder-ma", kinds: ["identity"] });
  service.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-07T11:30:00.000Z",
    channel_ids: ["ch-live"],
  });
  // 译者提交涉及人物身份的修订 → 授权人复核后生效
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-2",
    changes: [{ line_id: "L2", text: "Ma Defu stood at the entrance of the village." }],
  });
  service.approveRevision("rev-1", { approver_id: "elder-ma", kind: "identity" });
  // 可控时钟推进到开演前两小时内 → 生成发布包并锁定场次
  clock.set("2026-10-07T10:00:00.000Z");
  service.tick();
  const before = service.explainSubtitle("perf-1", "L2");
  // 亲历者撤回授权 → 未来使用被冻结，字幕行在再生成包中被冻结
  service.withdrawLicense("lic-1", { by: "person-ma" });
  service.tick();
  const after = service.explainSubtitle("perf-1", "L2");
  return {
    发布包: service.listPackages("perf-1").map((pkg) => ({
      package_id: pkg.package_id,
      status: pkg.status,
      content_hash: pkg.content_hash.slice(0, 12),
    })),
    撤回前说明: before,
    撤回后说明: after,
  };
}
