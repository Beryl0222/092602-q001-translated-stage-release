import test from "node:test";
import assert from "node:assert/strict";
import { baseService } from "./helpers.js";

test("演出取消冻结未来使用，记录与作废包保留", () => {
  const { service, clock } = baseService();
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T02:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick();
  const pkg = service.listPackages("perf-1").find((item) => item.status === "ready");
  assert.ok(pkg);
  service.cancelPerformance("perf-1", { reason: "剧场停演" });
  assert.equal(service.getPerformance("perf-1").status, "cancelled");
  assert.equal(service.getPackage(pkg.package_id).status, "void");
  assert.equal(service.getPackage(pkg.package_id).status_reason, "performance_cancelled");
  assert.throws(() => service.cancelPerformance("perf-1"), /已取消/);
  // 已取消场次的待办任务不会再生效
  assert.ok(service.listJobs().every((job) => job.status !== "pending"));
});

test("已发生的演出不可取消", () => {
  const { service, clock } = baseService();
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick();
  assert.equal(service.getPerformance("perf-1").status, "performed");
  assert.throws(() => service.cancelPerformance("perf-1"), /不可抹去/);
});

test("换角冻结旧演员的未来使用，已演出场次保持原演员表", () => {
  const { service, clock } = baseService();
  service.castRole({
    role_version_id: "role-1",
    production_id: "prod-1",
    role: "林书记",
    actor_id: "actor-a",
  });
  service.schedulePerformance({
    performance_id: "perf-old",
    production_id: "prod-1",
    showtime: "2026-10-01T01:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  service.schedulePerformance({
    performance_id: "perf-new",
    production_id: "prod-1",
    showtime: "2026-10-01T05:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T00:30:00.000Z");
  service.tick();
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick(); // perf-old 已演出
  clock.set("2026-10-01T04:00:00.000Z");
  service.tick(); // perf-new 生成发布包，演员仍是 actor-a
  const beforeRecast = service.listPackages("perf-new").find((pkg) => pkg.status === "ready");
  assert.equal(beforeRecast.casting["林书记"], "actor-a");
  // 换角：自 perf-new 起由 actor-b 出演
  service.castRole({
    role_version_id: "role-2",
    production_id: "prod-1",
    role: "林书记",
    actor_id: "actor-b",
    effective_from_performance: "perf-new",
  });
  assert.equal(service.getPackage(beforeRecast.package_id).status, "stale");
  service.tick();
  const afterRecast = service.listPackages("perf-new").find((pkg) => pkg.status === "ready");
  assert.equal(afterRecast.casting["林书记"], "actor-b");
  assert.equal(service.getPackage(beforeRecast.package_id).status, "superseded");
  // 已演出的 perf-old 保留原包与原演员表
  const oldPackages = service.listPackages("perf-old");
  assert.equal(oldPackages.length, 1);
  assert.equal(oldPackages[0].status, "ready");
  assert.equal(oldPackages[0].casting["林书记"], "actor-a");
});
