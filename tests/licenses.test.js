import test from "node:test";
import assert from "node:assert/strict";
import { baseService } from "./helpers.js";

test("授权撤回冻结未来场次，已演出记录保留", () => {
  const { service, clock } = baseService();
  service.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  service.schedulePerformance({
    performance_id: "perf-past",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  service.schedulePerformance({
    performance_id: "perf-future",
    production_id: "prod-1",
    showtime: "2026-10-01T06:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick(); // perf-past 已演出
  clock.set("2026-10-01T02:00:00.000Z");
  service.withdrawLicense("lic-1", { by: "person-ma" });
  clock.set("2026-10-01T05:30:00.000Z");
  service.tick(); // perf-future 生成发布包：L3 应被冻结
  const futurePkg = service.listPackages("perf-future").find((pkg) => pkg.status === "ready");
  const frozenLine = futurePkg.lines.find((line) => line.line_id === "L3");
  assert.equal(frozenLine.frozen, true);
  assert.equal(frozenLine.freeze_reason, "license_withdrawn");
  assert.equal(frozenLine.text, null);
  // 未受撤回影响的行保持可用
  assert.equal(futurePkg.lines.find((line) => line.line_id === "L1").frozen, false);
  // 已演出的 perf-past 保留原包原文
  const pastPackages = service.listPackages("perf-past");
  assert.equal(pastPackages.length, 1);
  assert.equal(pastPackages[0].status, "ready");
  assert.equal(pastPackages[0].lines.find((line) => line.line_id === "L3").text, "Ma Defu stood at the village gate.");
});

test("撤回使已生成的未来就绪包失效并重生成", () => {
  const { service, clock } = baseService();
  service.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T04:00:00.000Z");
  service.tick();
  const first = service.listPackages("perf-1").find((pkg) => pkg.status === "ready");
  assert.equal(first.lines.find((line) => line.line_id === "L3").frozen, false);
  service.withdrawLicense("lic-1");
  assert.equal(service.getPackage(first.package_id).status, "stale");
  service.tick();
  const second = service.listPackages("perf-1").find((pkg) => pkg.status === "ready");
  assert.notEqual(second.package_id, first.package_id);
  assert.equal(second.lines.find((line) => line.line_id === "L3").frozen, true);
  assert.equal(service.getPackage(first.package_id).status, "superseded");
});

test("声明需要授权的台词行在没有许可时被冻结", () => {
  const { service, clock } = baseService();
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  const pkg = service.listPackages("perf-1").find((item) => item.status === "ready");
  const line = pkg.lines.find((item) => item.line_id === "L3");
  assert.equal(line.frozen, true);
  assert.equal(line.freeze_reason, "license_missing");
});

test("渠道范围外的许可不覆盖该场次", () => {
  const { service, clock } = baseService();
  service.registerChannel({ channel_id: "ch-stream", kind: "流媒体" });
  service.grantLicense({
    license_id: "lic-1",
    grantor_id: "person-ma",
    subject: { person_refs: ["person-ma"] },
    scope: { channels: ["ch-stream"] },
  });
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  const pkg = service.listPackages("perf-1").find((item) => item.status === "ready");
  assert.equal(pkg.lines.find((line) => line.line_id === "L3").freeze_reason, "license_missing");
});

test("重复撤回许可被拒绝", () => {
  const { service } = baseService();
  service.grantLicense({ license_id: "lic-1", grantor_id: "person-ma", subject: { person_refs: ["person-ma"] } });
  service.withdrawLicense("lic-1");
  assert.throws(() => service.withdrawLicense("lic-1"), /已撤回/);
});
