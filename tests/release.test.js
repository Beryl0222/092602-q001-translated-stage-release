import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service.js";
import { baseService } from "./helpers.js";

test("按可控时钟在开演前生成每个场次唯一的发布包", () => {
  const { service, clock } = baseService();
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  service.schedulePerformance({
    performance_id: "perf-2",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T03:00:00.000Z");
  service.tick(); // 距开演超过提前量，不生成
  assert.equal(service.listPackages("perf-1").length, 0);
  clock.set("2026-10-01T04:00:00.000Z");
  service.tick(); // 进入开演前一小时内
  const pkg1 = service.listPackages("perf-1").find((pkg) => pkg.status === "ready");
  const pkg2 = service.listPackages("perf-2").find((pkg) => pkg.status === "ready");
  assert.ok(pkg1 && pkg2);
  assert.notEqual(pkg1.package_id, pkg2.package_id);
  assert.equal(service.getPerformance("perf-1").status, "locked");
  assert.ok(pkg1.content_hash);
});

test("进程中断后从日志恢复并继续未完成发布任务", () => {
  const journalPath = join(mkdtempSync(join(tmpdir(), "release-")), "journal.jsonl");
  const { service: service1, clock } = baseService({ journalPath });
  service1.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  service1.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T04:00:00.000Z");
  service1.tick();
  assert.equal(service1.listPackages("perf-1").length, 1);
  // 撤回授权产生待办任务，但进程在此“中断”，任务未执行
  service1.withdrawLicense("lic-1");
  assert.ok(service1.listJobs().some((job) => job.status === "pending"));
  // 新进程从同一日志恢复
  const service2 = Service.open({ journalPath, clock, packageLeadMs: 60 * 60 * 1000 });
  assert.equal(service2.getPerformance("perf-1").status, "locked");
  const resumed = service2.resume();
  assert.ok(resumed.processed >= 1);
  assert.ok(service2.listJobs().every((job) => job.status !== "pending"));
  const ready = service2.listPackages("perf-1").find((pkg) => pkg.status === "ready");
  assert.equal(ready.package_id, "pkg-perf-1-2");
  assert.equal(ready.lines.find((line) => line.line_id === "L3").frozen, true);
});

test("字幕行可追溯原稿版本、批准人、生效场次与撤回影响", () => {
  const { service, clock } = baseService();
  service.registerApprover({ approver_id: "elder-ma", kinds: ["identity"] });
  service.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  // 涉及人物身份的修订经授权人复核后生效
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-2",
    changes: [{ line_id: "L3", text: "Ma Defu stood at the entrance of the village." }],
  });
  service.approveRevision("rev-1", { approver_id: "elder-ma", kind: "identity" });
  service.schedulePerformance({
    performance_id: "perf-0",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  service.schedulePerformance({
    performance_id: "perf-2",
    production_id: "prod-1",
    showtime: "2026-10-01T06:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick(); // perf-0 已演出
  clock.set("2026-10-01T04:00:00.000Z");
  service.tick(); // perf-1 生成
  clock.set("2026-10-01T05:00:00.000Z");
  service.tick(); // perf-2 生成，perf-1 已演出
  const explained = service.explainSubtitle("perf-2", "L3");
  assert.equal(explained.text, "Ma Defu stood at the entrance of the village.");
  assert.deepEqual(explained.manuscript, { manuscript_id: "ms-1", version: 1 });
  assert.equal(explained.revision_id, "rev-1");
  assert.equal(explained.submitted_by, "tr-2");
  assert.equal(explained.approvals[0].approver_id, "elder-ma");
  assert.deepEqual(explained.licenses, ["lic-1"]);
  assert.deepEqual(explained.effective_performances.sort(), ["perf-0", "perf-1", "perf-2"]);
  // 撤回授权：未来场次被冻结，已演出的保留
  clock.set("2026-10-01T05:30:00.000Z");
  service.withdrawLicense("lic-1", { by: "person-ma" });
  service.tick();
  const after = service.explainSubtitle("perf-2", "L3");
  assert.equal(after.frozen, true);
  assert.equal(after.freeze_reason, "license_withdrawn");
  assert.equal(after.text, null);
  assert.equal(after.withdrawal_impact.length, 1);
  assert.deepEqual(after.withdrawal_impact[0].frozen_performances, ["perf-2"]);
  assert.deepEqual(after.withdrawal_impact[0].retained_performances.sort(), ["perf-0", "perf-1"]);
  // 撤回不影响历史包的内容
  const perf0Pkg = service.listPackages("perf-0")[0];
  assert.equal(perf0Pkg.lines.find((line) => line.line_id === "L3").text, "Ma Defu stood at the entrance of the village.");
});
