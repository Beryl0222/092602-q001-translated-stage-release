import test from "node:test";
import assert from "node:assert/strict";
import { baseService } from "./helpers.js";

test("重复提交同一修订返回原结果", () => {
  const { service } = baseService();
  const payload = {
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L1", text: "We moved to the town of Minning." }],
  };
  const first = service.submitRevision(payload);
  assert.equal(first.status, "applied");
  const again = service.submitRevision(payload);
  assert.equal(again, first, "应返回首次提交的同一个结果对象");
});

test("敏感修订获批后，重复提交仍返回最初的待复核结果", () => {
  const { service } = baseService();
  service.registerApprover({ approver_id: "historian-1", kinds: ["history"] });
  const payload = {
    revision_id: "rev-h",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L2", text: "It was the spring of 1998." }],
  };
  const first = service.submitRevision(payload);
  assert.equal(first.status, "pending_review");
  service.approveRevision("rev-h", { approver_id: "historian-1", kind: "history" });
  assert.equal(service.getRevision("rev-h").status, "applied");
  assert.deepEqual(service.submitRevision(payload), first);
});

test("同一编号提交不同内容被拒绝", () => {
  const { service } = baseService();
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L1", text: "A" }],
  });
  assert.throws(
    () => service.submitRevision({
      revision_id: "rev-1",
      branch_id: "br-en",
      submitted_by: "tr-1",
      changes: [{ line_id: "L1", text: "B" }],
    }),
    /已被不同内容占用/,
  );
});

test("内容冲突进入合议，裁定胜出后生效", () => {
  const { service } = baseService();
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L1", text: "We relocated to Minning." }],
  });
  const conflict = service.submitRevision({
    revision_id: "rev-2",
    branch_id: "br-en",
    submitted_by: "tr-2",
    changes: [{ line_id: "L1", text: "We moved our home to Minning." }],
  });
  assert.equal(conflict.status, "deliberating");
  assert.ok(conflict.deliberation_id);
  const deliberation = service.resolveDeliberation(conflict.deliberation_id, {
    decided_by: "editor-1",
    winner_revision_id: "rev-2",
  });
  assert.equal(deliberation.status, "resolved");
  assert.equal(service.getRevision("rev-2").status, "applied");
  assert.equal(service.getRevision("rev-1").status, "superseded");
  const branch = service.repository.state.branches.get("br-en");
  assert.equal(branch.head_lines.L1, "We moved our home to Minning.");
});

test("合议可以合并出新译文", () => {
  const { service } = baseService();
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L1", text: "We relocated to Minning." }],
  });
  const conflict = service.submitRevision({
    revision_id: "rev-2",
    branch_id: "br-en",
    submitted_by: "tr-2",
    changes: [{ line_id: "L1", text: "We moved our home to Minning." }],
  });
  service.resolveDeliberation(conflict.deliberation_id, {
    decided_by: "editor-1",
    merged_changes: [{ line_id: "L1", text: "We made our new home in Minning." }],
  });
  const branch = service.repository.state.branches.get("br-en");
  assert.equal(branch.head_lines.L1, "We made our new home in Minning.");
  assert.equal(service.getRevision("rev-1").status, "superseded");
  assert.equal(service.getRevision("rev-2").status, "rejected");
});

test("基于最新头的后续修订不构成冲突", () => {
  const { service } = baseService();
  service.submitRevision({
    revision_id: "rev-1",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L1", text: "We relocated to Minning." }],
  });
  const followUp = service.submitRevision({
    revision_id: "rev-2",
    branch_id: "br-en",
    submitted_by: "tr-2",
    base_revision: "rev-1",
    changes: [{ line_id: "L1", text: "We relocated to the town of Minning." }],
  });
  assert.equal(followUp.status, "applied");
});

test("涉及史实的修订必须经对应授权人复核", () => {
  const { service } = baseService();
  service.registerApprover({ approver_id: "historian-1", kinds: ["history"] });
  service.registerApprover({ approver_id: "elder-1", kinds: ["identity"] });
  const result = service.submitRevision({
    revision_id: "rev-h",
    branch_id: "br-en",
    submitted_by: "tr-1",
    changes: [{ line_id: "L2", text: "It was the spring of 1998." }],
  });
  assert.equal(result.status, "pending_review");
  assert.deepEqual(result.required_approvals, ["history"]);
  assert.throws(
    () => service.approveRevision("rev-h", { approver_id: "tr-9", kind: "history" }),
    /未登记的复核人/,
  );
  assert.throws(
    () => service.approveRevision("rev-h", { approver_id: "elder-1", kind: "history" }),
    /无此授权类别/,
  );
  service.approveRevision("rev-h", { approver_id: "historian-1", kind: "history" });
  const revision = service.getRevision("rev-h");
  assert.equal(revision.status, "applied");
  assert.equal(revision.approvals[0].approver_id, "historian-1");
});

test("涉及人物身份的修订不得标记为兼容修订", () => {
  const { service } = baseService();
  assert.throws(
    () => service.submitRevision({
      revision_id: "rev-x",
      branch_id: "br-en",
      submitted_by: "tr-1",
      change_kind: "compatible",
      changes: [{ line_id: "L3", text: "He stood at the gate." }],
    }),
    /不得标记为兼容修订/,
  );
});

test("已锁定场次只接收兼容修订", () => {
  const { service, clock } = baseService();
  service.schedulePerformance({
    performance_id: "perf-1",
    production_id: "prod-1",
    showtime: "2026-10-01T02:00:00.000Z",
    channel_ids: ["ch-live"],
  });
  clock.set("2026-10-01T01:30:00.000Z");
  service.tick();
  assert.equal(service.getPerformance("perf-1").status, "locked");
  assert.throws(
    () => service.submitRevision({
      revision_id: "rev-c",
      branch_id: "br-en",
      submitted_by: "tr-1",
      changes: [{ line_id: "L1", text: "We relocated to Minning Town." }],
    }),
    /仅接收兼容修订/,
  );
  const ok = service.submitRevision({
    revision_id: "rev-fix",
    branch_id: "br-en",
    submitted_by: "tr-1",
    change_kind: "compatible",
    changes: [{ line_id: "L1", text: "We moved to Minning.." }],
  });
  assert.equal(ok.status, "applied");
  service.tick();
  const ready = service.listPackages("perf-1").find((pkg) => pkg.status === "ready");
  assert.equal(ready.lines.find((line) => line.line_id === "L1").text, "We moved to Minning..");
});
