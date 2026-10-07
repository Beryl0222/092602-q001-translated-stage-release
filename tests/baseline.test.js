import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Service, ControlledClock } from "../src/service.js";
import { Repository } from "../src/repository.js";

function tempLog() {
  const dir = mkdtempSync(path.join(tmpdir(), "tsr-"));
  return { file: path.join(dir, "events.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sample = { record_id: "show-2026-001", owner_id: "stage-office", state: "draft", revision: 1 };

/* ============================ 基线（向后兼容） ============================ */

test("健康检查返回服务状态与可控时钟", () => {
  const clock = new ControlledClock("2026-06-01T00:00:00.000Z");
  const service = new Service(new Repository({ clock }), { clock });
  assert.equal(service.health().status, "ok");
  assert.equal(service.health().now, "2026-06-01T00:00:00.000Z");
});

test("登记后可以按编号查询", () => {
  const service = new Service();
  const saved = service.register(sample);
  assert.equal(saved.revision, 1);
  assert.equal(service.find(saved.record_id).owner_id, saved.owner_id);
});

test("重复编号被拒绝", () => {
  const service = new Service();
  service.register(sample);
  assert.throws(() => service.register(sample), /已存在/);
});

/* ============================ 测试夹具 ============================ */

function makeService(initial = "2026-09-01T08:00:00.000Z") {
  const clock = new ControlledClock(initial);
  const service = new Service(new Repository({ clock }), { clock });
  return { clock, service };
}

function seedStory(service, { witnesses = 1 } = {}) {
  service.registerStory({ story_id: "s1", title: "干沙滩" });
  service.registerSource({ source_id: "src1", story_id: "s1", witness_id: "w1", title: "口述原稿" });
  const witnessIds = witnesses === 2 ? ["w1", "w2"] : ["w1"];
  service.registerSegment({
    segment_id: "g1", source_id: "src1", ordinal: 1, chinese_text: "我们走了几天几夜", witness_ids: witnessIds,
  });
  if (witnesses === 2) {
    service.registerSegment({
      segment_id: "g2", source_id: "src1", ordinal: 2, chinese_text: "种蘑菇", witness_ids: ["w2"],
    });
  }
  service.grantPermit({ permit_id: "pm1", story_id: "s1", witness_id: "w1", segment_ids: ["g1"] });
  if (witnesses === 2) {
    service.grantPermit({ permit_id: "pm2", story_id: "s1", witness_id: "w2", segment_ids: ["g1", "g2"] });
  }
}

function approvedWording(service, id = "p1", translator = "t1") {
  const res = service.submitProposal({
    proposal_id: id, segment_id: "g1", translator_id: translator,
    branch: "en/a", english_text: "We walked for days and nights.",
        cultural_note: "", change_kinds: ["wording"],
  });
  return res;
}

/* ============================ 并行译稿 / 幂等 / 冲突合议 ============================ */

test("不同译者可并行提交方案，措辞类改动自动可用", () => {
  const { service } = makeService();
  seedStory(service);
  const a = service.submitProposal({
    proposal_id: "p1", segment_id: "g1", translator_id: "t1", branch: "en/a",
    english_text: "We walked for days and nights.", cultural_note: "", change_kinds: ["wording"],
  });
  const b = service.submitProposal({
    proposal_id: "p2", segment_id: "g1", translator_id: "t2", branch: "en/b",
    english_text: "Day and night we travelled on.", cultural_note: "", change_kinds: ["wording"],
  });
  // 两条不同英文文本 => 触发合议；合议前不自动批准
  assert.equal(a.proposal.status, "approved");
  assert.equal(b.proposal.status, "in_review");
  assert.ok(b.panel, "冲突译稿应进入合议");
});

test("重复提交同一修订（同片段同译者同内容）返回原结果", () => {
  const { service } = makeService();
  seedStory(service);
  const args = {
    segment_id: "g1", translator_id: "t1", branch: "en/a",
    english_text: "We walked for days and nights.", cultural_note: "注", change_kinds: ["wording"],
  };
  const first = service.submitProposal(args);
  const second = service.submitProposal(args);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.proposal.proposal_id, first.proposal.proposal_id);
});

test("内容冲突必须进入合议，合议选定一条并驳回另一条", () => {
  const { service } = makeService();
  seedStory(service);
  approvedWording(service, "p1");
  const b = service.submitProposal({
    proposal_id: "p2", segment_id: "g1", translator_id: "t2", branch: "en/b",
    english_text: "Day and night we travelled on.", cultural_note: "", change_kinds: ["wording"],
  });
  assert.ok(b.panel);
  service.decidePanel({ proposal_id: "p2", decision: "approved", note: "海外观众更易懂" });
  assert.equal(service.getProposal("p2").status, "approved");
  assert.equal(service.getProposal("p1").status, "rejected");
});

/* ============================ 史实 / 身份授权复核 ============================ */

test("涉及史实或人物身份的改动未经授权人复核不能进入角色版本", () => {
  const { service } = makeService();
  seedStory(service);
  const res = service.submitProposal({
    proposal_id: "ph", segment_id: "g1", translator_id: "t1", branch: "en/h",
    english_text: "We were relocated to Ganshatan.", cultural_note: "改动移民身份表述",
    change_kinds: ["historical", "identity"],
  });
  assert.equal(res.proposal.status, "in_review");
  const missing = service.proposalReviewStatus("ph").missing;
  assert.deepEqual(missing.map((m) => m.kind), ["historical", "identity"]);
  service.defineRole({ role_id: "r1", story_id: "s1", name: "老马" });
  assert.throws(
    () => service.registerVersion({
      version_id: "v1", role_id: "r1", label: "x", segment_proposals: { g1: "ph" },
    }),
    /尚未批准/,
  );
});

test("只有覆盖该句的亲历者本人可以复核；两类复核齐备后才批准", () => {
  const { service } = makeService();
  seedStory(service);
  service.submitProposal({
    proposal_id: "ph", segment_id: "g1", translator_id: "t1", branch: "en/h",
    english_text: "We were relocated to Ganshatan.", cultural_note: "",
    change_kinds: ["historical", "identity"],
  });
  assert.throws(
    () => service.recordReview({
      permit_id: "pm1", proposal_id: "ph", kind: "historical", reviewer_id: "someone-else", decision: "approved",
    }),
    /只有亲历者许可本人/,
  );
  service.recordReview({ permit_id: "pm1", proposal_id: "ph", kind: "historical", reviewer_id: "w1", decision: "approved" });
  assert.equal(service.getProposal("ph").status, "in_review", "仅一类复核通过还不能批准");
  service.recordReview({ permit_id: "pm1", proposal_id: "ph", kind: "identity", reviewer_id: "w1", decision: "approved" });
  assert.equal(service.getProposal("ph").status, "approved");
});

test("复核驳回即冻结该译稿", () => {
  const { service } = makeService();
  seedStory(service);
  service.submitProposal({
    proposal_id: "ph", segment_id: "g1", translator_id: "t1", branch: "en/h",
    english_text: "We were relocated.", cultural_note: "", change_kinds: ["historical"],
  });
  service.recordReview({ permit_id: "pm1", proposal_id: "ph", kind: "historical", reviewer_id: "w1", decision: "rejected" });
  assert.equal(service.getProposal("ph").status, "rejected");
});

test("多亲历者片段需要每位授权人分别复核", () => {
  const { service } = makeService();
  seedStory(service, { witnesses: 2 });
  service.submitProposal({
    proposal_id: "ph", segment_id: "g1", translator_id: "t1", branch: "en/h",
    english_text: "We were relocated.", cultural_note: "", change_kinds: ["historical"],
  });
  service.recordReview({ permit_id: "pm1", proposal_id: "ph", kind: "historical", reviewer_id: "w1", decision: "approved" });
  assert.equal(service.proposalReviewStatus("ph").ok, false);
  service.recordReview({ permit_id: "pm2", proposal_id: "ph", kind: "historical", reviewer_id: "w2", decision: "approved" });
  assert.equal(service.proposalReviewStatus("ph").ok, true);
});

/* ============================ 锁定场次与兼容修订 ============================ */

function prepareLockedPerformance(service, { performanceId = "perf1", versionId = "v1", setupShared = true } = {}) {
  if (setupShared) {
    service.defineRole({ role_id: "r1", story_id: "s1", name: "老马" });
    service.registerChannel({ channel_id: "c1", name: "字幕屏", kind: "surtitle", endpoint: "screen" });
    approvedWording(service, "p1");
    service.registerVersion({ version_id: versionId, role_id: "r1", label: "A", segment_proposals: { g1: "p1" } });
  }
  service.schedulePerformance({
    performance_id: performanceId, story_id: "s1", curtain_at: "2026-10-01T19:30:00.000Z",
    venue: "8 号棚", channel_ids: ["c1"], cast: { r1: versionId },
  });
  service.lockPerformance({ performance_id: performanceId });
}

test("锁定场次只接收措辞类兼容修订", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service);
  const res = service.requestRevision({
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We walked days and nights.", requester_id: "sm",
  });
  assert.equal(res.duplicate, false);
  assert.equal(res.revision.status, "applied");
  assert.throws(
    () => service.requestRevision({
      performance_id: "perf1", version_id: "v1", segment_id: "g1",
      kind: "historical", new_text: "Relocated.",
    }),
    /只接收措辞类/,
  );
});

test("同一兼容修订重复提交返回原修订", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service);
  const args = {
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We walked days and nights.", requester_id: "sm",
  };
  const first = service.requestRevision(args);
  const second = service.requestRevision(args);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.revision.revision_id, first.revision.revision_id);
});

test("锁定场次改词内容冲突进入合议，不合议不生效", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service);
  service.requestRevision({
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We walked days and nights.", requester_id: "sm",
  });
  const dispute = service.requestRevision({
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We trekked for ages.", requester_id: "dir",
  });
  assert.ok(dispute.dispute, "异文应进入合议");
  assert.equal(dispute.revision, null);
  // 合议驳回：维持第一版
  const resolved = service.resolveRevisionDispute({
    performance_id: "perf1", version_id: "v1", segment_id: "g1", decision: "reject", decider_id: "panel",
  });
  assert.equal(resolved.revision, null);
});

test("未锁定场次不接受兼容修订", () => {
  const { service } = makeService();
  seedStory(service);
  service.defineRole({ role_id: "r1", story_id: "s1", name: "老马" });
  service.registerChannel({ channel_id: "c1", name: "字幕屏", kind: "surtitle", endpoint: "screen" });
  approvedWording(service, "p1");
  service.registerVersion({ version_id: "v1", role_id: "r1", label: "A", segment_proposals: { g1: "p1" } });
  service.schedulePerformance({
    performance_id: "perf1", story_id: "s1", curtain_at: "2026-10-01T19:30:00.000Z",
    venue: "8 号棚", channel_ids: ["c1"], cast: { r1: "v1" },
  });
  assert.throws(
    () => service.requestRevision({
      performance_id: "perf1", version_id: "v1", segment_id: "g1", kind: "wording", new_text: "X",
    }),
    /只有已锁定场次/,
  );
});

/* ============================ 换角 / 取消 / 撤回的冻结边界 ============================ */

test("临时换角冻结旧版本在未来场次使用，且不能再修订旧版本", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service);
  service.registerVersion({ version_id: "v2", role_id: "r1", label: "B 角", segment_proposals: { g1: "p1" } });
  service.changeCasting({ performance_id: "perf1", role_id: "r1", version_id: "v2", reason: "A 角失声" });
  assert.throws(
    () => service.requestRevision({
      performance_id: "perf1", version_id: "v1", segment_id: "g1", kind: "wording", new_text: "new",
    }),
    /不在本场当前演员表/,
  );
  const effect = service.proposalEffect("p1");
  // v1/v2 使用同一条译稿 => 换角不冻结该译稿本身
  assert.deepEqual(effect.freeze_impacts.filter((i) => i.kind === "casting_changed"), []);
  assert.ok(effect.effective_performances.some((p) => p.performance_id === "perf1"));
});

test("换角到使用不同译稿的版本，旧译稿在该场冻结", () => {
  const { service } = makeService();
  seedStory(service);
  // p1 先成为批准译稿并据此建 v1
  service.submitProposal({
    proposal_id: "p1", segment_id: "g1", translator_id: "t1", branch: "a",
    english_text: "First version.", cultural_note: "", change_kinds: ["wording"],
  });
  service.defineRole({ role_id: "r1", story_id: "s1", name: "老马" });
  service.registerVersion({ version_id: "v1", role_id: "r1", label: "A", segment_proposals: { g1: "p1" } });
  // 之后 p2 经合议胜出：p1 被驳回，但 v1 这一历史版本仍存在
  service.submitProposal({
    proposal_id: "p2", segment_id: "g1", translator_id: "t2", branch: "b",
    english_text: "Second version.", cultural_note: "", change_kinds: ["wording"],
  });
  service.decidePanel({ proposal_id: "p2", decision: "approved" });
  service.registerVersion({ version_id: "v2", role_id: "r1", label: "B", segment_proposals: { g1: "p2" } });
  service.registerChannel({ channel_id: "c1", name: "屏", kind: "surtitle", endpoint: "x" });
  service.schedulePerformance({
    performance_id: "perf1", story_id: "s1", curtain_at: "2026-10-01T19:30:00.000Z",
    venue: "棚", channel_ids: ["c1"], cast: { r1: "v1" },
  });
  service.lockPerformance({ performance_id: "perf1" });
  service.changeCasting({ performance_id: "perf1", role_id: "r1", version_id: "v2", reason: "改用新译文" });
  const oldEffect = service.proposalEffect("p1");
  assert.ok(oldEffect.freeze_impacts.some(
    (i) => i.kind === "casting_changed" && i.performance_id === "perf1" && i.effect === "frozen_future_use",
  ));
  const newEffect = service.proposalEffect("p2");
  assert.ok(newEffect.effective_performances.some((p) => p.performance_id === "perf1"));
});

test("取消演出冻结未来使用，但已演出场次记录保留", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service, { performanceId: "future" });
  service.cancelPerformance({ performance_id: "future", reason: "极端天气" });
  assert.equal(service.getPerformance("future").status, "cancelled");
  assert.throws(() => service.recordPerformance({ performance_id: "future" }), /已取消/);
  // 已取消场次的所有历史事件仍可查
  assert.ok(service.allEvents().some((e) => e.type === "performance_locked"));
});

test("授权撤回冻结未演出场次，但已演出记录不可抹去", async () => {
  const { clock, service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service, { performanceId: "done" });
  service.scheduleRelease({ performance_id: "done", lead_ms: 3600000 });
  await service.runDueJobs({ now: "2026-10-01T18:30:00.000Z" });
  service.recordPerformance({ performance_id: "done" });

  // 未来第二场（角色/渠道/版本已在第一场建好，只排新场次）
  prepareLockedPerformance(service, { performanceId: "upcoming", setupShared: false });
  service.revokePermit({ permit_id: "pm1", reason: "亲历者暂停授权" });

  const effect = service.proposalEffect("p1");
  const doneImpact = effect.freeze_impacts.find((i) => i.performance_id === "done");
  const upcomingImpact = effect.freeze_impacts.find((i) => i.performance_id === "upcoming");
  assert.equal(doneImpact.effect, "performed_immutable");
  assert.equal(upcomingImpact.effect, "frozen_future_use");
  assert.ok(!effect.effective_performances.some((p) => p.performance_id === "upcoming"));
  assert.ok(effect.effective_performances.some((p) => p.performance_id === "done" && p.immutable));
  // 已演出场次不能再取消
  assert.throws(() => service.cancelPerformance({ performance_id: "done", reason: "x" }), /已实际演出/);
});

test("许可撤回后不能再依据其复核新译稿", () => {
  const { service } = makeService();
  seedStory(service);
  service.submitProposal({
    proposal_id: "ph", segment_id: "g1", translator_id: "t1", branch: "h",
    english_text: "Relocated.", cultural_note: "", change_kinds: ["historical"],
  });
  service.revokePermit({ permit_id: "pm1", reason: "撤" });
  assert.throws(
    () => service.recordReview({ permit_id: "pm1", proposal_id: "ph", kind: "historical", reviewer_id: "w1", decision: "approved" }),
    /许可已撤回/,
  );
});

/* ============================ 发布包：可控时钟 / 唯一 / 续跑 ============================ */

async function buildOne(service, clock, performanceId = "perf1") {
  service.scheduleRelease({ performance_id: performanceId, lead_ms: 3600000 });
  // 未到开演前窗口：不生成
  const early = await service.runDueJobs({ now: "2026-10-01T17:00:00.000Z" });
  assert.deepEqual(early, []);
  const results = await service.runDueJobs({ now: "2026-10-01T18:30:00.000Z" });
  return results;
}

test("按可控时钟在开演前生成每个场次唯一的发布包", async () => {
  const { clock, service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service);
  const results = await buildOne(service, clock);
  assert.equal(results.length, 1);
  const release = service.getRelease(results[0].release_id);
  assert.equal(release.performance_id, "perf1");
  assert.equal(release.package_hash, results[0].package_hash);
  const line = release.manifest.lines.find((l) => l.segment_id === "g1");
  assert.equal(line.proposal_id, "p1");
  assert.equal(line.permits[0].permit_id, "pm1");
  assert.equal(line.usable, true);
});

test("同一内容重复执行不会重复生成发布包（幂等）", async () => {
  const { service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service);
  await buildOne(service);
  const again = await service.runDueJobs({ now: "2026-10-01T18:31:00.000Z" });
  assert.deepEqual(again, []);
  // 重复安排也返回同一任务
  const scheduled = service.scheduleRelease({ performance_id: "perf1" });
  assert.equal(scheduled.duplicate, true);
});

test("超过开演时刻不再生成开演前发布包", async () => {
  const { service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service);
  service.scheduleRelease({ performance_id: "perf1" });
  await service.runDueJobs({ now: "2026-10-01T20:00:00.000Z" });
  assert.equal(service.getJob("job-perf1").status, "pending");
  assert.match(service.getJob("job-perf1").error, /已超过开演时刻/);
});

test("进程中断后继续未完成任务", async () => {
  const { file, cleanup } = tempLog();
  try {
    const clock1 = new ControlledClock("2026-09-20T08:00:00.000Z");
    let service = new Service(new Repository({ file, clock: clock1 }), { clock: clock1 });
    seedStory(service);
    prepareLockedPerformance(service);
    service.scheduleRelease({ performance_id: "perf1" });
    await assert.rejects(
      service.runDueJobs({ now: "2026-10-01T18:30:00.000Z", crashAfterStart: true }),
      /模拟进程中断/,
    );
    assert.equal(service.getJob("job-perf1").status, "pending");

    // 新进程：从事件日志恢复，续跑完成
    const clock2 = new ControlledClock("2026-10-01T18:31:00.000Z");
    service = new Service(new Repository({ file, clock: clock2 }), { clock: clock2 });
    assert.equal(service.getJob("job-perf1").status, "pending", "重启后任务应为待续跑");
    const results = await service.runDueJobs({ now: "2026-10-01T18:31:00.000Z" });
    assert.equal(results.length, 1);
    assert.ok(service.getRelease(results[0].release_id));
  } finally {
    cleanup();
  }
});

test("半截写入的事件日志在加载时被截断，已确认事件不丢失", () => {
  const { file, cleanup } = tempLog();
  try {
    const clock = new ControlledClock();
    let service = new Service(new Repository({ file, clock }), { clock });
    seedStory(service);
    const before = readFileSync(file, "utf8").trimEnd().split("\n").length;
    appendFileSync(file, '{"seq":999,"type":"corrupt","at":"2026', "utf8");
    const clock2 = new ControlledClock();
    service = new Service(new Repository({ file, clock: clock2 }), { clock: clock2 });
    assert.equal(service.allEvents().length, before);
    assert.ok(service.getSegment("g1"));
  } finally {
    cleanup();
  }
});

test("兼容修订进入发布包文本", async () => {
  const { service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service);
  service.requestRevision({
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We walked days and nights.", requester_id: "sm",
  });
  const results = await buildOne(service);
  const release = service.getRelease(results[0].release_id);
  const line = release.manifest.lines.find((l) => l.segment_id === "g1");
  assert.equal(line.english_text, "We walked days and nights.");
  assert.ok(line.revision_id);
});

test("许可撤回后生成的发布包把相关字幕标为不可用并给出原因", async () => {
  const { service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service, { performanceId: "later" });
  service.revokePermit({ permit_id: "pm1", reason: "撤" });
  service.scheduleRelease({ performance_id: "later" });
  const results = await service.runDueJobs({ now: "2026-10-01T18:30:00.000Z" });
  const release = service.getRelease(results[0].release_id);
  const line = release.manifest.lines.find((l) => l.segment_id === "g1");
  assert.equal(line.usable, false);
  assert.match(line.freeze_reasons.join("；"), /撤回许可/);
});

/* ============================ 逐句溯源 ============================ */

test("溯源接口说明原稿版本、批准人、生效场次与撤回影响", async () => {
  const { service } = makeService("2026-09-20T08:00:00.000Z");
  seedStory(service);
  prepareLockedPerformance(service);
  await buildOne(service);
  service.recordPerformance({ performance_id: "perf1" });
  service.revokePermit({ permit_id: "pm1", reason: "撤" });

  const trace = service.trace("g1");
  assert.equal(trace.source.source_id, "src1");
  assert.equal(trace.source.chinese_text, "我们走了几天几夜");
  const row = trace.proposals.find((p) => p.proposal_id === "p1");
  assert.equal(row.based_on_source.source_id, "src1");
  assert.equal(row.submitted_by, "t1");
  assert.ok(row.effective_performances.some((p) => p.performance_id === "perf1"));
  const impact = row.freeze_impacts.find((i) => i.performance_id === "perf1");
  assert.equal(impact.effect, "performed_immutable", "已演出场次标注为不可变保留");
});

/* ============================ 不可变历史 ============================ */

test("事件只追加：取消、撤回、换角均产生新事件而不删除旧事件", () => {
  const { service } = makeService();
  seedStory(service);
  prepareLockedPerformance(service);
  service.requestRevision({
    performance_id: "perf1", version_id: "v1", segment_id: "g1",
    kind: "wording", new_text: "We walked days and nights.", requester_id: "sm",
  });
  service.registerVersion({ version_id: "v2", role_id: "r1", label: "B", segment_proposals: { g1: "p1" } });
  const before = service.allEvents().length;
  service.changeCasting({ performance_id: "perf1", role_id: "r1", version_id: "v2", reason: "换角" });
  service.cancelPerformance({ performance_id: "perf1", reason: "停演" });
  service.revokePermit({ permit_id: "pm1", reason: "撤回" });
  const events = service.allEvents();
  assert.ok(events.length > before + 2);
  // 早期事件无一被删除：锁定、修订、换角、取消、撤回全部可追溯
  for (const type of [
    "performance_locked", "revision_requested", "casting_changed",
    "performance_cancelled", "permit_revoked",
  ]) {
    assert.ok(events.some((e) => e.type === type), `应保留 ${type} 事件`);
  }
  // 事件序号严格递增且唯一
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b));
});
