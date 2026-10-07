/** 国际剧目译演发布的应用服务入口。
 *  覆盖：登记、并行修订（幂等/冲突合议）、敏感复核、场次锁定、
 *  取消/换角/撤回冻结、可控时钟生成发布包、断点续跑与字幕追溯。 */
import {
  createRecord,
  createFragment,
  createManuscript,
  createBranch,
  createProduction,
  createChannel,
  createNote,
  createApprover,
  createRevision,
  createLicense,
  createRoleVersion,
  createPerformance,
  manuscriptKey,
  contentHash,
  revisionPayloadHash,
} from "./domain.js";
import { Repository } from "./repository.js";
import { SystemClock } from "./clock.js";

const DEFAULT_PACKAGE_LEAD_MS = 2 * 60 * 60 * 1000;

export class Service {
  constructor({
    repository = new Repository(),
    clock = new SystemClock(),
    packageLeadMs = DEFAULT_PACKAGE_LEAD_MS,
  } = {}) {
    this.repository = repository;
    this.clock = clock;
    this.packageLeadMs = packageLeadMs;
  }

  /** 从持久化日志打开服务（进程重启后调用 resume 续跑未完成任务）。 */
  static open(options = {}) {
    const repository = options.repository ?? new Repository({ journalPath: options.journalPath ?? null });
    return new Service({ ...options, repository });
  }

  #nowIso() {
    return this.clock.now().toISOString();
  }

  #state() {
    return this.repository.state;
  }

  // ---- 既有基础能力 ----

  health() {
    return { service: "translated_stage_release", status: "ok" };
  }

  register(payload) {
    return this.repository.add(createRecord(payload));
  }

  find(recordId) {
    return this.repository.get(String(recordId));
  }

  // ---- 登记：片段 / 原稿 / 分支 / 剧目 / 渠道 / 说明 / 复核人 ----

  registerFragment(payload) {
    const fragment = createFragment(payload, this.#nowIso());
    this.#mustAbsent(this.#state().fragments, fragment.fragment_id, "故事片段");
    this.repository.dispatch("FragmentRegistered", fragment);
    return fragment;
  }

  registerManuscript(payload) {
    const manuscript = createManuscript(payload, this.#nowIso());
    this.#mustFragment(manuscript.fragment_id);
    this.#mustAbsent(this.#state().manuscripts, manuscriptKey(manuscript.manuscript_id, manuscript.version), "原稿版本");
    this.repository.dispatch("ManuscriptRegistered", manuscript);
    return manuscript;
  }

  openBranch(payload) {
    const branch = createBranch(payload, this.#nowIso());
    this.#mustAbsent(this.#state().branches, branch.branch_id, "翻译分支");
    const manuscript = this.#state().manuscripts.get(manuscriptKey(branch.manuscript_id, branch.manuscript_version));
    if (!manuscript) throw new Error(`原稿版本不存在：${branch.manuscript_id} v${branch.manuscript_version}`);
    const missing = manuscript.lines.filter((line) => !(line.line_id in branch.base_lines)).map((line) => line.line_id);
    if (missing.length) throw new Error(`翻译分支缺少基础译文：${missing.join("、")}`);
    this.repository.dispatch("BranchOpened", branch);
    return this.#state().branches.get(branch.branch_id);
  }

  registerProduction(payload) {
    const production = createProduction(payload, this.#nowIso());
    this.#mustAbsent(this.#state().productions, production.production_id, "剧目");
    this.#mustFragment(production.fragment_id);
    if (!this.#state().manuscripts.has(manuscriptKey(production.manuscript_id, production.manuscript_version))) {
      throw new Error(`原稿版本不存在：${production.manuscript_id} v${production.manuscript_version}`);
    }
    const branch = this.#mustBranch(production.branch_id);
    if (branch.manuscript_id !== production.manuscript_id || branch.manuscript_version !== production.manuscript_version) {
      throw new Error("翻译分支与剧目原稿版本不匹配");
    }
    this.repository.dispatch("ProductionRegistered", production);
    return production;
  }

  registerChannel(payload) {
    const channel = createChannel(payload, this.#nowIso());
    this.#mustAbsent(this.#state().channels, channel.channel_id, "发布渠道");
    this.repository.dispatch("ChannelRegistered", channel);
    return channel;
  }

  addCulturalNote(payload) {
    const note = createNote(payload, this.#nowIso());
    this.#mustAbsent(this.#state().notes, note.note_id, "文化说明");
    this.#mustFragment(note.fragment_id);
    this.repository.dispatch("NoteAdded", note);
    return note;
  }

  registerApprover(payload) {
    const approver = createApprover(payload, this.#nowIso());
    this.#mustAbsent(this.#state().approvers, approver.approver_id, "复核人");
    this.repository.dispatch("ApproverRegistered", approver);
    return approver;
  }

  schedulePerformance(payload) {
    const performance = createPerformance(payload, this.#nowIso());
    this.#mustAbsent(this.#state().performances, performance.performance_id, "场次");
    if (!this.#state().productions.has(performance.production_id)) {
      throw new Error(`剧目不存在：${performance.production_id}`);
    }
    for (const channelId of performance.channel_ids) {
      if (!this.#state().channels.has(channelId)) throw new Error(`发布渠道不存在：${channelId}`);
    }
    this.repository.dispatch("PerformanceScheduled", performance);
    return performance;
  }

  // ---- 修订：幂等提交、冲突合议、敏感复核 ----

  submitRevision(payload) {
    const at = this.#nowIso();
    const draft = createRevision(payload, at);
    const hash = revisionPayloadHash(draft);
    const existing = this.#state().revisions.get(draft.revision_id);
    if (existing) {
      if (existing.payload_hash === hash) return existing.result; // 重复提交同一修订：返回原结果
      throw new Error("修订编号已被不同内容占用");
    }
    const branch = this.#mustBranch(draft.branch_id);
    const manuscript = this.#state().manuscripts.get(manuscriptKey(branch.manuscript_id, branch.manuscript_version));
    const lineMap = new Map(manuscript.lines.map((line) => [line.line_id, line]));
    for (const change of draft.changes) {
      if (!lineMap.has(change.line_id)) throw new Error(`修订包含未知台词行：${change.line_id}`);
    }
    const touchesHistory = draft.changes.some((change) => lineMap.get(change.line_id).involves_history);
    const touchesIdentity = draft.changes.some((change) => lineMap.get(change.line_id).involves_identity);
    if ((touchesHistory || touchesIdentity) && draft.change_kind === "compatible") {
      throw new Error("涉及史实或人物身份的修订不得标记为兼容修订");
    }
    this.#assertLockCompatible(draft);
    const required = [];
    if (touchesHistory) required.push("history");
    if (touchesIdentity) required.push("identity");
    // 内容冲突：同一台词行已被他人用不同内容推进
    const conflicts = draft.changes
      .filter((change) => {
        const head = branch.line_heads[change.line_id] ?? null;
        return head !== null && head !== draft.base_revision && branch.head_lines[change.line_id] !== change.text;
      })
      .map((change) => ({ line_id: change.line_id, head_revision: branch.line_heads[change.line_id] }));
    const revision = {
      ...draft,
      payload_hash: hash,
      required_approvals: required,
      approvals: [],
      status: "received",
      result: null,
    };
    if (conflicts.length) {
      const deliberationId = `dlg-${draft.revision_id}`;
      revision.status = "deliberating";
      revision.result = Object.freeze({
        revision_id: revision.revision_id,
        status: "deliberating",
        deliberation_id: deliberationId,
        conflicts,
      });
      this.repository.dispatch("RevisionSubmitted", revision);
      this.repository.dispatch("DeliberationOpened", {
        deliberation_id: deliberationId,
        branch_id: draft.branch_id,
        opened_at: at,
        opened_by: draft.submitted_by,
        revision_ids: [...new Set([draft.revision_id, ...conflicts.map((c) => c.head_revision)])],
        lines: conflicts,
        status: "open",
      });
      return this.#state().revisions.get(revision.revision_id).result;
    }
    if (required.length) {
      revision.status = "pending_review";
      revision.result = Object.freeze({
        revision_id: revision.revision_id,
        status: "pending_review",
        required_approvals: [...required],
      });
      this.repository.dispatch("RevisionSubmitted", revision);
      return this.#state().revisions.get(revision.revision_id).result;
    }
    revision.status = "applied";
    revision.result = Object.freeze({ revision_id: revision.revision_id, status: "applied" });
    this.repository.dispatch("RevisionSubmitted", revision);
    this.#applyRevision(revision, at);
    return this.#state().revisions.get(revision.revision_id).result;
  }

  /** 授权人复核：所需类别全部批准后修订生效。 */
  approveRevision(revisionId, payload = {}) {
    const at = this.#nowIso();
    const revision = this.#mustRevision(revisionId);
    if (revision.status !== "pending_review") throw new Error("修订不在待复核状态");
    const kind = String(payload.kind ?? "");
    const approver = this.#state().approvers.get(String(payload.approver_id ?? ""));
    if (!approver) throw new Error("未登记的复核人");
    if (!revision.required_approvals.includes(kind)) throw new Error(`该修订不需要 ${kind} 类复核`);
    if (!approver.kinds.includes(kind)) throw new Error("复核人无此授权类别");
    if (revision.approvals.some((approval) => approval.kind === kind)) throw new Error("该类别已完成复核");
    this.repository.dispatch("ApprovalRecorded", {
      revision_id: revision.revision_id,
      approval: { approver_id: approver.approver_id, kind, at },
    });
    const satisfied = revision.required_approvals.every((need) => revision.approvals.some((approval) => approval.kind === need));
    if (satisfied) {
      this.#assertLockCompatible(revision);
      this.#applyRevision(revision, at);
    }
    return this.#state().revisions.get(revision.revision_id);
  }

  /** 合议裁定：选择涉案修订胜出，或以合并译文结案。 */
  resolveDeliberation(deliberationId, resolution = {}) {
    const at = this.#nowIso();
    const deliberation = this.#state().deliberations.get(String(deliberationId));
    if (!deliberation) throw new Error(`合议不存在：${deliberationId}`);
    if (deliberation.status !== "open") throw new Error("合议已结案");
    if (!String(resolution.decided_by ?? "").trim()) throw new Error("合议缺少决定人");
    let winnerId;
    if (resolution.merged_changes) {
      const mergedId = resolution.merged_revision_id ?? `rev-${deliberation.deliberation_id}-merged`;
      this.#mustAbsent(this.#state().revisions, mergedId, "修订");
      const branch = this.#mustBranch(deliberation.branch_id);
      const manuscript = this.#state().manuscripts.get(manuscriptKey(branch.manuscript_id, branch.manuscript_version));
      const lineMap = new Map(manuscript.lines.map((line) => [line.line_id, line]));
      const merged = createRevision({
        revision_id: mergedId,
        branch_id: deliberation.branch_id,
        submitted_by: resolution.decided_by,
        changes: resolution.merged_changes,
      }, at);
      for (const change of merged.changes) {
        if (!lineMap.has(change.line_id)) throw new Error(`合议合并包含未知台词行：${change.line_id}`);
      }
      const required = [];
      if (merged.changes.some((change) => lineMap.get(change.line_id).involves_history)) required.push("history");
      if (merged.changes.some((change) => lineMap.get(change.line_id).involves_identity)) required.push("identity");
      const revision = {
        ...merged,
        payload_hash: revisionPayloadHash(merged),
        required_approvals: required,
        approvals: [],
        status: required.length ? "pending_review" : "applied",
        result: Object.freeze({
          revision_id: mergedId,
          status: required.length ? "pending_review" : "applied",
          deliberation_id: deliberation.deliberation_id,
        }),
      };
      this.repository.dispatch("RevisionSubmitted", revision);
      if (!required.length) {
        this.#assertLockCompatible(revision);
        this.#applyRevision(revision, at);
      }
      winnerId = mergedId;
    } else {
      const winner = this.#state().revisions.get(String(resolution.winner_revision_id ?? ""));
      if (!winner || !deliberation.revision_ids.includes(winner.revision_id)) {
        throw new Error("合议结果必须选择涉案修订");
      }
      if (winner.required_approvals.length) {
        this.repository.dispatch("RevisionStatusChanged", { revision_id: winner.revision_id, status: "pending_review" });
      } else {
        this.#assertLockCompatible(winner);
        this.#applyRevision(winner, at);
      }
      winnerId = winner.revision_id;
    }
    for (const revisionId of deliberation.revision_ids) {
      if (revisionId === winnerId) continue;
      const other = this.#state().revisions.get(revisionId);
      if (!other) continue;
      if (other.status === "applied") {
        this.repository.dispatch("RevisionStatusChanged", { revision_id: revisionId, status: "superseded" });
      } else if (["deliberating", "pending_review"].includes(other.status)) {
        this.repository.dispatch("RevisionStatusChanged", { revision_id: revisionId, status: "rejected" });
      }
    }
    this.repository.dispatch("DeliberationResolved", {
      deliberation_id: deliberation.deliberation_id,
      at,
      resolution: {
        decided_by: resolution.decided_by,
        winner_revision_id: winnerId,
        merged: Boolean(resolution.merged_changes),
      },
    });
    return this.#state().deliberations.get(deliberation.deliberation_id);
  }

  // ---- 许可：授予与撤回 ----

  grantLicense(payload) {
    const license = createLicense(payload, this.#nowIso());
    this.#mustAbsent(this.#state().licenses, license.license_id, "亲历者许可");
    if (license.subject.fragment_id) this.#mustFragment(license.subject.fragment_id);
    this.repository.dispatch("LicenseGranted", license);
    return license;
  }

  /** 撤回许可：精确冻结撤回时点之后的未来使用，已发生的演出记录保留。 */
  withdrawLicense(licenseId, payload = {}) {
    const at = this.#nowIso();
    const license = this.#state().licenses.get(String(licenseId));
    if (!license) throw new Error(`亲历者许可不存在：${licenseId}`);
    if (license.status !== "active") throw new Error("许可已撤回");
    this.repository.dispatch("LicenseWithdrawn", {
      license_id: license.license_id,
      at,
      by: payload.by ?? license.grantor_id,
    });
    for (const pkg of [...this.#state().packages.values()]) {
      if (pkg.status !== "ready") continue;
      const performance = this.#state().performances.get(pkg.performance_id);
      if (!performance || performance.status === "performed" || performance.status === "cancelled") continue;
      if (Date.parse(performance.showtime) <= Date.parse(at)) continue;
      if (!pkg.lines.some((line) => line.licenses.includes(license.license_id))) continue;
      this.repository.dispatch("PackageStatusChanged", {
        package_id: pkg.package_id,
        status: "stale",
        reason: "license_withdrawn",
      });
      this.#enqueuePackageJob(performance.performance_id);
    }
    return this.#state().licenses.get(license.license_id);
  }

  // ---- 角色与场次 ----

  /** 换角：登记新角色版本，冻结旧演员在生效点之后的使用。 */
  castRole(payload) {
    const at = this.#nowIso();
    const role = createRoleVersion(payload, at);
    this.#mustAbsent(this.#state().roles, role.role_version_id, "角色版本");
    if (!this.#state().productions.has(role.production_id)) {
      throw new Error(`剧目不存在：${role.production_id}`);
    }
    if (payload.effective_from_performance) {
      const performance = this.#state().performances.get(String(payload.effective_from_performance));
      if (!performance) throw new Error(`场次不存在：${payload.effective_from_performance}`);
      role.effective_at = performance.showtime;
    }
    this.repository.dispatch("RoleCast", role);
    for (const pkg of [...this.#state().packages.values()]) {
      if (pkg.status !== "ready") continue;
      const performance = this.#state().performances.get(pkg.performance_id);
      if (!performance || performance.production_id !== role.production_id) continue;
      if (performance.status === "performed" || performance.status === "cancelled") continue;
      if (Date.parse(performance.showtime) < Date.parse(role.effective_at)) continue;
      if (pkg.casting[role.role] === role.actor_id) continue;
      this.repository.dispatch("PackageStatusChanged", {
        package_id: pkg.package_id,
        status: "stale",
        reason: "recast",
      });
      this.#enqueuePackageJob(performance.performance_id);
    }
    return role;
  }

  lockPerformance(performanceId) {
    const performance = this.#mustPerformance(performanceId);
    if (performance.status !== "scheduled") throw new Error("仅排期中的场次可以锁定");
    this.repository.dispatch("PerformanceLocked", { performance_id: performance.performance_id, at: this.#nowIso() });
    return this.#state().performances.get(performance.performance_id);
  }

  /** 取消场次：发布包作废、待办任务取消，记录全部保留。 */
  cancelPerformance(performanceId, payload = {}) {
    const at = this.#nowIso();
    const performance = this.#mustPerformance(performanceId);
    if (performance.status === "performed") throw new Error("演出已发生，记录不可抹去");
    if (performance.status === "cancelled") throw new Error("场次已取消");
    this.repository.dispatch("PerformanceCancelled", {
      performance_id: performance.performance_id,
      at,
      reason: payload.reason ?? null,
    });
    for (const pkg of [...this.#state().packages.values()]) {
      if (pkg.performance_id === performance.performance_id && ["ready", "stale"].includes(pkg.status)) {
        this.repository.dispatch("PackageStatusChanged", {
          package_id: pkg.package_id,
          status: "void",
          reason: "performance_cancelled",
        });
      }
    }
    for (const job of [...this.#state().jobs.values()]) {
      if (job.performance_id === performance.performance_id && job.status === "pending") {
        this.repository.dispatch("JobStatusChanged", { job_id: job.job_id, status: "cancelled", at });
      }
    }
    return this.#state().performances.get(performance.performance_id);
  }

  completePerformance(performanceId) {
    const performance = this.#mustPerformance(performanceId);
    if (performance.status === "performed") throw new Error("演出已标记完成");
    if (performance.status === "cancelled") throw new Error("场次已取消");
    this.repository.dispatch("PerformancePerformed", {
      performance_id: performance.performance_id,
      at: this.#nowIso(),
    });
    return this.#state().performances.get(performance.performance_id);
  }

  // ---- 发布包：可控时钟驱动、可中断续跑 ----

  /** 时钟推进：到点场次入队生成发布包，开演场次标记已演出，随后执行待办任务。 */
  tick() {
    const nowMs = this.clock.now().getTime();
    const at = this.#nowIso();
    for (const performance of [...this.#state().performances.values()]) {
      const showMs = Date.parse(performance.showtime);
      if (performance.status === "scheduled" && showMs - this.packageLeadMs <= nowMs) {
        this.#enqueuePackageJob(performance.performance_id);
      }
      if (performance.status === "locked" && showMs <= nowMs) {
        this.repository.dispatch("PerformancePerformed", { performance_id: performance.performance_id, at });
      }
    }
    return this.processJobs();
  }

  /** 执行所有待办任务。 */
  processJobs() {
    const results = [];
    for (const job of [...this.#state().jobs.values()]) {
      if (job.status !== "pending") continue;
      try {
        const pkg = this.#generatePackage(job.performance_id);
        this.repository.dispatch("JobStatusChanged", { job_id: job.job_id, status: "done", at: this.#nowIso() });
        results.push({ job_id: job.job_id, package_id: pkg.package_id, performance_id: pkg.performance_id });
      } catch (error) {
        this.repository.dispatch("JobStatusChanged", {
          job_id: job.job_id,
          status: "failed",
          error: error.message,
          at: this.#nowIso(),
        });
        results.push({ job_id: job.job_id, error: error.message });
      }
    }
    return results;
  }

  /** 进程中断后继续：失败任务重新排队，到点场次补齐，未完成任务跑完。 */
  resume() {
    let requeued = 0;
    for (const job of [...this.#state().jobs.values()]) {
      if (job.status === "failed") {
        this.repository.dispatch("JobStatusChanged", { job_id: job.job_id, status: "pending", at: this.#nowIso() });
        requeued += 1;
      }
    }
    const results = this.tick();
    return { requeued, processed: results.filter((result) => !result.error).length, results };
  }

  // ---- 追溯接口 ----

  /** 说明某句字幕：采用了哪版原稿、谁批准、在哪些场次生效、撤回后受到什么影响。 */
  explainSubtitle(performanceId, lineId) {
    const performance = this.#mustPerformance(performanceId);
    const pkg = this.#latestPackage(performance.performance_id);
    if (!pkg) throw new Error("该场次尚未生成发布包");
    const entry = pkg.lines.find((line) => line.line_id === String(lineId));
    if (!entry) throw new Error(`发布包中不存在字幕行：${lineId}`);
    const production = this.#state().productions.get(performance.production_id);
    const revision = entry.revision_id ? this.#state().revisions.get(entry.revision_id) : null;
    const manuscript = this.#state().manuscripts.get(manuscriptKey(entry.manuscript_id, entry.manuscript_version));
    const lineDef = manuscript?.lines.find((line) => line.line_id === entry.line_id) ?? null;
    const effective = [];
    for (const other of this.#state().performances.values()) {
      const otherPkg = this.#latestReadyPackage(other.performance_id);
      if (!otherPkg) continue;
      const otherEntry = otherPkg.lines.find((line) => line.line_id === entry.line_id);
      if (otherEntry && otherEntry.text === entry.text
        && otherEntry.revision_id === entry.revision_id && otherEntry.frozen === entry.frozen) {
        effective.push(other.performance_id);
      }
    }
    const withdrawalImpact = [];
    if (lineDef) {
      for (const license of this.#state().licenses.values()) {
        if (license.status !== "withdrawn") continue;
        const hit = license.subject.fragment_id === production.fragment_id
          || license.subject.person_refs.some((ref) => lineDef.person_refs.includes(ref));
        if (!hit) continue;
        const frozenPerformances = [];
        const retainedPerformances = [];
        for (const other of this.#state().performances.values()) {
          if (other.production_id !== production.production_id) continue;
          if (!this.#latestPackage(other.performance_id)) continue;
          if (Date.parse(other.showtime) > Date.parse(license.withdrawn_at)) {
            if (other.status !== "cancelled") frozenPerformances.push(other.performance_id);
          } else {
            retainedPerformances.push(other.performance_id);
          }
        }
        withdrawalImpact.push({
          license_id: license.license_id,
          grantor_id: license.grantor_id,
          withdrawn_at: license.withdrawn_at,
          frozen_performances: frozenPerformances,
          retained_performances: retainedPerformances,
        });
      }
    }
    return {
      performance_id: performance.performance_id,
      package_id: pkg.package_id,
      line_id: entry.line_id,
      text: entry.text,
      frozen: entry.frozen,
      freeze_reason: entry.freeze_reason,
      manuscript: { manuscript_id: entry.manuscript_id, version: entry.manuscript_version },
      branch_id: production.branch_id,
      revision_id: entry.revision_id,
      submitted_by: revision?.submitted_by ?? null,
      approvals: entry.approvals.map((approval) => ({ ...approval })),
      licenses: [...entry.licenses],
      effective_performances: effective,
      withdrawal_impact: withdrawalImpact,
    };
  }

  // ---- 查询 ----

  getPerformance(performanceId) {
    return this.#state().performances.get(String(performanceId)) ?? null;
  }

  getPackage(packageId) {
    return this.#state().packages.get(String(packageId)) ?? null;
  }

  getRevision(revisionId) {
    return this.#state().revisions.get(String(revisionId)) ?? null;
  }

  getDeliberation(deliberationId) {
    return this.#state().deliberations.get(String(deliberationId)) ?? null;
  }

  getLicense(licenseId) {
    return this.#state().licenses.get(String(licenseId)) ?? null;
  }

  listPackages(performanceId) {
    return [...this.#state().packages.values()].filter((pkg) => pkg.performance_id === String(performanceId));
  }

  listJobs() {
    return [...this.#state().jobs.values()];
  }

  // ---- 内部 ----

  #mustAbsent(map, id, label) {
    if (map.has(id)) throw new Error(`${label}已存在：${id}`);
  }

  #mustFragment(fragmentId) {
    const fragment = this.#state().fragments.get(String(fragmentId));
    if (!fragment) throw new Error(`故事片段不存在：${fragmentId}`);
    return fragment;
  }

  #mustBranch(branchId) {
    const branch = this.#state().branches.get(String(branchId));
    if (!branch) throw new Error(`翻译分支不存在：${branchId}`);
    return branch;
  }

  #mustRevision(revisionId) {
    const revision = this.#state().revisions.get(String(revisionId));
    if (!revision) throw new Error(`修订不存在：${revisionId}`);
    return revision;
  }

  #mustPerformance(performanceId) {
    const performance = this.#state().performances.get(String(performanceId));
    if (!performance) throw new Error(`场次不存在：${performanceId}`);
    return performance;
  }

  /** 已锁定场次只接收兼容修订。 */
  #assertLockCompatible(revision) {
    const locked = [...this.#state().performances.values()].filter((performance) => {
      if (performance.status !== "locked") return false;
      const production = this.#state().productions.get(performance.production_id);
      return production?.branch_id === revision.branch_id;
    });
    if (locked.length && revision.change_kind !== "compatible") {
      throw new Error(`场次已锁定，仅接收兼容修订：${locked.map((p) => p.performance_id).join("、")}`);
    }
  }

  #applyRevision(revision, at) {
    this.repository.dispatch("RevisionApplied", {
      revision_id: revision.revision_id,
      at,
      line_updates: revision.changes.map((change) => ({ line_id: change.line_id, text: change.text })),
    });
    this.#refreshPackagesForBranch(revision.branch_id, "revision_applied");
  }

  /** 分支内容变化后，未演出场次的就绪包失效并重排生成。 */
  #refreshPackagesForBranch(branchId, reason) {
    for (const pkg of [...this.#state().packages.values()]) {
      if (pkg.status !== "ready") continue;
      const performance = this.#state().performances.get(pkg.performance_id);
      if (!performance || performance.status === "performed" || performance.status === "cancelled") continue;
      const production = this.#state().productions.get(performance.production_id);
      if (production?.branch_id !== branchId) continue;
      this.repository.dispatch("PackageStatusChanged", { package_id: pkg.package_id, status: "stale", reason });
      this.#enqueuePackageJob(performance.performance_id);
    }
  }

  #enqueuePackageJob(performanceId) {
    const existing = [...this.#state().jobs.values()].find(
      (job) => job.type === "package" && job.performance_id === performanceId && job.status === "pending",
    );
    if (existing) return existing;
    const count = [...this.#state().jobs.values()].filter(
      (job) => job.type === "package" && job.performance_id === performanceId,
    ).length;
    const job = {
      job_id: `job-package-${performanceId}-${count + 1}`,
      type: "package",
      performance_id: performanceId,
      status: "pending",
      enqueued_at: this.#nowIso(),
    };
    this.repository.dispatch("JobEnqueued", job);
    return job;
  }

  /** 生成某场次唯一的发布包：解析译文、许可、演员表，生成即锁定。 */
  #generatePackage(performanceId) {
    const at = this.#nowIso();
    const performance = this.#state().performances.get(performanceId);
    if (!performance) throw new Error(`场次不存在：${performanceId}`);
    if (performance.status === "cancelled") throw new Error("场次已取消，无法生成发布包");
    if (performance.status === "performed") throw new Error("演出已发生，无法重新生成发布包");
    const production = this.#state().productions.get(performance.production_id);
    const branch = this.#state().branches.get(production.branch_id);
    const manuscript = this.#state().manuscripts.get(manuscriptKey(branch.manuscript_id, branch.manuscript_version));
    const lines = manuscript.lines.map((line) => this.#buildPackageLine(line, production, branch, performance));
    const casting = this.#resolveCasting(production.production_id, performance.showtime);
    const seq = [...this.#state().packages.values()].filter((pkg) => pkg.performance_id === performanceId).length + 1;
    const pkg = {
      package_id: `pkg-${performanceId}-${seq}`,
      performance_id: performanceId,
      generated_at: at,
      channel_ids: [...performance.channel_ids],
      casting,
      lines,
      content_hash: contentHash({ lines, casting }),
      status: "ready",
    };
    for (const old of [...this.#state().packages.values()]) {
      if (old.performance_id === performanceId && ["ready", "stale"].includes(old.status)) {
        this.repository.dispatch("PackageStatusChanged", {
          package_id: old.package_id,
          status: "superseded",
          reason: "regenerated",
        });
      }
    }
    this.repository.dispatch("PackageGenerated", pkg);
    if (performance.status === "scheduled") {
      this.repository.dispatch("PerformanceLocked", { performance_id: performanceId, at });
    }
    return pkg;
  }

  #buildPackageLine(line, production, branch, performance) {
    const licenseView = this.#lineLicenses(line, production.fragment_id, performance);
    const source = branch.line_sources[line.line_id] ?? null;
    const revision = source ? this.#state().revisions.get(source.revision_id) : null;
    return {
      line_id: line.line_id,
      text: licenseView.frozen ? null : branch.head_lines[line.line_id],
      frozen: licenseView.frozen,
      freeze_reason: licenseView.reason,
      manuscript_id: branch.manuscript_id,
      manuscript_version: branch.manuscript_version,
      revision_id: source?.revision_id ?? null,
      approvals: revision ? revision.approvals.map((approval) => ({ ...approval })) : [],
      licenses: licenseView.license_ids,
    };
  }

  /** 许可判定：撤回即冻结；声明需要授权而没有有效许可也冻结。 */
  #lineLicenses(line, fragmentId, performance) {
    const covering = [...this.#state().licenses.values()].filter((license) => {
      const subjectHit = license.subject.fragment_id === fragmentId
        || license.subject.person_refs.some((ref) => line.person_refs.includes(ref));
      if (!subjectHit) return false;
      if (!license.scope.channels.length) return true;
      return license.scope.channels.some((channel) => performance.channel_ids.includes(channel));
    });
    const showMs = Date.parse(performance.showtime);
    const withdrawn = covering.filter(
      (license) => license.status === "withdrawn" && Date.parse(license.withdrawn_at) <= showMs,
    );
    if (withdrawn.length) {
      return { frozen: true, reason: "license_withdrawn", license_ids: covering.map((license) => license.license_id) };
    }
    const active = covering.filter((license) => license.status === "active"
      && (!license.valid_from || Date.parse(license.valid_from) <= showMs)
      && (!license.valid_until || showMs <= Date.parse(license.valid_until)));
    if (line.requires_license && !active.length) {
      return { frozen: true, reason: "license_missing", license_ids: covering.map((license) => license.license_id) };
    }
    return { frozen: false, reason: null, license_ids: active.map((license) => license.license_id) };
  }

  /** 演员表：每个角色取生效时间不晚于开演时间的最新版本。 */
  #resolveCasting(productionId, showtime) {
    const showMs = Date.parse(showtime);
    const casting = {};
    const versions = [...this.#state().roles.values()]
      .filter((role) => role.production_id === productionId && Date.parse(role.effective_at) <= showMs)
      .sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at));
    for (const version of versions) casting[version.role] = version.actor_id;
    return casting;
  }

  #packagesFor(performanceId) {
    return [...this.#state().packages.values()].filter((pkg) => pkg.performance_id === performanceId);
  }

  #latestPackage(performanceId) {
    const all = this.#packagesFor(performanceId);
    return all.filter((pkg) => pkg.status === "ready").at(-1) ?? all.at(-1) ?? null;
  }

  #latestReadyPackage(performanceId) {
    return this.#packagesFor(performanceId).filter((pkg) => pkg.status === "ready").at(-1) ?? null;
  }
}
