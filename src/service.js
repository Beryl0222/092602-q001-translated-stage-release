/**
 * 国际剧目译演发布应用服务。
 *
 * 所有写操作都向仓库追加不可变事件；读操作基于事件回放投影。
 * 时钟可注入：发布任务因此可以按可控时钟在“开演前”生成，进程中断后继续未完成任务。
 */
import { Repository } from "./repository.js";
import {
  requireText, requireId, contentHash, proposalFingerprint, revisionFingerprint,
  normalizeChangeKinds, reviewStatus, assessRevision, buildReleaseManifest, traceLine,
  effectivePerformances, freezeImpacts,
} from "./domain.js";

export const systemClock = () => ({ now: () => new Date().toISOString() });

/** 可控时钟：测试与发布调度可显式推进时间。 */
export class ControlledClock {
  constructor(initial = "2026-01-01T00:00:00.000Z") {
    this.t = new Date(initial).toISOString();
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t = new Date(new Date(this.t).getTime() + ms).toISOString();
    return this.t;
  }
  set(value) {
    this.t = new Date(value).toISOString();
    return this.t;
  }
}

export class Service {
  constructor(repository, options = {}) {
    this.repository = repository ?? new Repository();
    this.clock = options.clock ?? systemClock();
  }

  get #s() {
    return this.repository.state;
  }

  #append(type, payload) {
    return this.repository.append(type, payload);
  }

  health() {
    return { service: "translated_stage_release", status: "ok", now: this.clock.now() };
  }

  /* --------------------------- 通用记录（向后兼容早期登记） --------------------------- */

  register(payload) {
    const recordId = requireId(payload.record_id, "record_id");
    if (this.#s.records.has(recordId)) throw new Error("记录编号已存在");
    const ownerId = requireText(payload.owner_id, "owner_id");
    const stateName = requireText(payload.state, "state");
    const revision = Number(payload.revision ?? 1);
    if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
    this.#append("record_registered", {
      record_id: recordId, owner_id: ownerId, state: stateName, revision,
    });
    return this.find(recordId);
  }

  find(recordId) {
    return this.#s.records.get(String(recordId)) ?? null;
  }

  /* --------------------------- 故事 / 中文原稿 / 片段 --------------------------- */

  registerStory({ story_id, title }) {
    const storyId = requireId(story_id, "story_id");
    if (this.#s.stories.has(storyId)) throw new Error("故事编号已存在");
    this.#append("story_registered", { story_id: storyId, title: requireText(title, "title") });
    return this.#s.stories.get(storyId);
  }

  registerSource({ source_id, story_id, witness_id, title }) {
    const sourceId = requireId(source_id, "source_id");
    if (this.#s.sources.has(sourceId)) throw new Error("原稿编号已存在");
    const storyId = requireId(story_id, "story_id");
    if (!this.#s.stories.has(storyId)) throw new Error("故事不存在");
    this.#append("source_registered", {
      source_id: sourceId, story_id: storyId,
      witness_id: requireId(witness_id, "witness_id"), title: requireText(title, "title"),
    });
    return this.#s.sources.get(sourceId);
  }

  registerSegment({ segment_id, source_id, ordinal, chinese_text, witness_ids }) {
    const segmentId = requireId(segment_id, "segment_id");
    if (this.#s.segments.has(segmentId)) throw new Error("片段编号已存在");
    const source = this.#s.sources.get(requireId(source_id, "source_id"));
    if (!source) throw new Error("原稿不存在");
    const order = Number(ordinal);
    if (!Number.isInteger(order) || order < 0) throw new Error("ordinal 必须是非负整数");
    const witnesses = [...new Set(
      (Array.isArray(witness_ids) ? witness_ids : []).map((w) => requireId(w, "witness_ids")),
    )];
    if (!witnesses.length) throw new Error("片段至少需要登记一位亲历者");
    this.#append("segment_registered", {
      segment_id: segmentId, source_id: source.source_id, ordinal: order,
      chinese_text: requireText(chinese_text, "chinese_text"), witness_ids: witnesses,
    });
    return this.#s.segments.get(segmentId);
  }

  /* --------------------------- 亲历者许可 --------------------------- */

  grantPermit({ permit_id, story_id, witness_id, segment_ids, reason }) {
    const permitId = requireId(permit_id, "permit_id");
    if (this.#s.permits.has(permitId)) throw new Error("许可编号已存在");
    const storyId = requireId(story_id, "story_id");
    if (!this.#s.stories.has(storyId)) throw new Error("故事不存在");
    const witnessId = requireId(witness_id, "witness_id");
    const scope = [...new Set(
      (Array.isArray(segment_ids) ? segment_ids : []).map((id) => requireId(id, "segment_ids")),
    )];
    for (const segmentId of scope) {
      const segment = this.#s.segments.get(segmentId);
      if (!segment) throw new Error(`片段不存在：${segmentId}`);
      if (!segment.witness_ids.includes(witnessId)) {
        throw new Error(`亲历者 ${witnessId} 不是片段 ${segmentId} 的登记亲历者，不能授予该句许可`);
      }
    }
    this.#append("permit_granted", {
      permit_id: permitId, story_id: storyId, witness_id: witnessId,
      scope: { segment_ids: scope }, reason: reason ?? "",
    });
    return this.#s.permits.get(permitId);
  }

  /** 撤回许可：只冻结未来使用，不改变任何已发生的演出记录。 */
  revokePermit({ permit_id, reason }) {
    const permitId = requireId(permit_id, "permit_id");
    const permit = this.#s.permits.get(permitId);
    if (!permit) throw new Error("许可不存在");
    if (permit.status === "revoked") throw new Error("许可已处于撤回状态");
    this.#append("permit_revoked", { permit_id: permitId, reason: requireText(reason, "reason") });
    return this.#s.permits.get(permitId);
  }

  /* --------------------------- 翻译分支与译稿提交 --------------------------- */

  /**
   * 译者并行提交译稿方案：
   * - 同一片段、同一译者、同样的英文文本与文化说明重复提交 => 幂等返回原结果；
   * - 不同译者（或同译者不同内容）=> 各自独立分支，互不阻塞；
   * - 与同片段另一条待审译稿实质内容冲突 => 进入合议（panel），不自动批准。
   */
  submitProposal(input) {
    const segmentId = requireId(input.segment_id, "segment_id");
    const segment = this.#s.segments.get(segmentId);
    if (!segment) throw new Error("片段不存在");
    const translatorId = requireId(input.translator_id, "translator_id");
    const englishText = requireText(input.english_text, "english_text");
    const culturalNote = String(input.cultural_note ?? "");
    const branch = requireText(input.branch ?? `branch-${translatorId}`, "branch");
    const changeKinds = normalizeChangeKinds(input.change_kinds ?? ["wording"]);
    const basedOnSource = input.based_on_source ?? segment.source_id;
    if (!this.#s.sources.has(basedOnSource)) throw new Error("所依据原稿不存在");

    const fingerprint = proposalFingerprint({
      segment_id: segmentId, translator_id: translatorId,
      english_text: englishText, cultural_note: culturalNote,
    });
    const existingId = this.#s.fingerprints.get(fingerprint);
    if (existingId) {
      const existing = this.#s.proposals.get(existingId);
      return Object.freeze({ duplicate: true, proposal: existing });
    }

    let proposalId = input.proposal_id ? requireId(input.proposal_id, "proposal_id") : null;
    if (proposalId && this.#s.proposals.has(proposalId)) throw new Error("译稿编号已存在");
    proposalId = proposalId ?? `proposal-${segmentId}-${translatorId}-${fingerprint.slice(0, 10)}`;
    if (this.#s.proposals.has(proposalId)) throw new Error("译稿编号已存在");

    const hash = contentHash({ english_text: englishText, cultural_note: culturalNote });
    this.#append("proposal_submitted", {
      proposal_id: proposalId, segment_id: segmentId, translator_id: translatorId,
      branch, english_text: englishText, cultural_note: culturalNote,
      change_kinds: changeKinds, content_hash: hash,
      idempotency_key: input.idempotency_key ?? fingerprint, fingerprint,
      based_on_source: basedOnSource,
    });

    // 内容冲突：同片段存在另一条不同英文文本的在审/已批准译稿 => 进入合议。
    const conflictWith = [...this.#s.proposals.values()].find(
      (p) => p.proposal_id !== proposalId
        && p.segment_id === segmentId
        && p.content_hash !== hash
        && ["in_review", "approved"].includes(p.status),
    );
    let panel = null;
    if (conflictWith) {
      const existingPanel = this.#s.panels.get(conflictWith.proposal_id) ?? this.#s.panels.get(proposalId);
      if (!existingPanel) {
        this.#append("panel_convened", {
          proposal_id: proposalId,
          persons: this.#panelPersons(segmentId, conflictWith, this.#s.proposals.get(proposalId)),
          reason: `与译稿 ${conflictWith.proposal_id} 在同一句上的英文译文内容冲突`,
          conflicting: {
            segment_id: segmentId,
            proposals: [
              { proposal_id: conflictWith.proposal_id, translator_id: conflictWith.translator_id },
              { proposal_id: proposalId, translator_id: translatorId },
            ],
          },
        });
        panel = this.#s.panels.get(proposalId);
      }
    }

    // 无敏感改动且无冲突 => 直接可用（approved）；否则留在 in_review 等待复核/合议。
    const submitted = this.#s.proposals.get(proposalId);
    const status = reviewStatus(this.#s, submitted);
    if (!panel && status.ok) {
      this.#append("proposal_resolved", { proposal_id: proposalId, decision: "approved" });
    }
    return Object.freeze({
      duplicate: false,
      proposal: this.#s.proposals.get(proposalId),
      review: status,
      panel,
    });
  }

  #panelPersons(segmentId, ...proposals) {
    const persons = new Set();
    for (const p of proposals.filter(Boolean)) {
      persons.add(p.translator_id);
    }
    const segment = this.#s.segments.get(segmentId);
    if (segment) {
      for (const witnessId of segment.witness_ids) persons.add(witnessId);
    }
    return [...persons];
  }

  /** 授权人复核：涉及史实 / 身份的改动类别，必须由覆盖该句的亲历者许可本人批准。 */
  recordReview(input) {
    const permitId = requireId(input.permit_id, "permit_id");
    const permit = this.#s.permits.get(permitId);
    if (!permit) throw new Error("许可不存在");
    if (permit.status !== "active") throw new Error("许可已撤回，不能再据此复核");
    const proposalId = requireId(input.proposal_id, "proposal_id");
    const proposal = this.#s.proposals.get(proposalId);
    if (!proposal) throw new Error("译稿不存在");
    const segment = this.#s.segments.get(proposal.segment_id);
    if (!permit.scope.segment_ids.includes(segment.segment_id)) {
      throw new Error("该许可不覆盖这句字幕");
    }
    if (input.reviewer_id !== permit.witness_id) {
      throw new Error("只有亲历者许可本人（授权人）可以复核其许可范围内的改动");
    }
    const kind = String(input.kind);
    if (!["cultural", "historical", "identity"].includes(kind)) throw new Error("未知复核类别");
    if (!proposal.change_kinds.includes(kind)) {
      throw new Error("该译稿未声明此类改动，无需此项复核");
    }
    const decision = input.decision === "rejected" ? "rejected" : "approved";
    const reviewId = input.review_id
      ?? `review-${permitId}-${proposalId}-${kind}`;
    if (this.#s.reviews.has(reviewId)) throw new Error("复核编号已存在");
    this.#append("review_recorded", {
      review_id: reviewId, permit_id: permitId, proposal_id: proposalId,
      kind, reviewer_id: input.reviewer_id, decision, note: input.note ?? "",
    });

    // 复核驳回 => 译稿驳回；全部必需复核通过且无未决合议 => 批准。
    if (decision === "rejected") {
      this.#append("proposal_resolved", {
        proposal_id: proposalId, decision: "rejected",
        persons: [input.reviewer_id],
      });
    } else {
      const status = reviewStatus(this.#s, proposal);
      const openPanel = [...this.#s.panels.values()].find(
        (p) => p.status === "open"
          && p.conflicting.proposals.some((q) => q.proposal_id === proposalId),
      );
      if (status.ok && !openPanel) {
        this.#append("proposal_resolved", { proposal_id: proposalId, decision: "approved" });
      }
    }
    return this.#s.reviews.get(reviewId);
  }

  /** 合议裁决：在冲突译稿中选定一条（或驳回）。可从冲突任一方译稿发起。 */
  decidePanel({ proposal_id, decision, note }) {
    const proposalId = requireId(proposal_id, "proposal_id");
    const panel = this.#s.panels.get(proposalId)
      ?? [...this.#s.panels.values()].find(
        (p) => p.status === "open" && p.conflicting.proposals.some((q) => q.proposal_id === proposalId),
      );
    if (!panel) throw new Error("该译稿没有进行中的合议");
    if (panel.status !== "open") throw new Error("合议已有结论");
    if (!["approved", "rejected"].includes(decision)) throw new Error("合议结论必须是 approved 或 rejected");
    const proposal = this.#s.proposals.get(proposalId);
    const required = reviewStatus(this.#s, proposal);
    if (decision === "approved" && !required.ok) {
      throw new Error("涉史实/身份的译稿合议批准前仍须取得相应授权人复核");
    }
    this.#append("panel_decided", {
      proposal_id: panel.proposal_id, decision, note: note ?? "",
    });
    this.#append("proposal_resolved", { proposal_id: proposalId, decision, persons: panel.persons });
    // 合议中落选的另一条：无论此前在审还是已自动批准，一律标记驳回（提交事件仍保留在日志中）。
    const otherId = panel.conflicting.proposals
      .map((q) => q.proposal_id)
      .find((id) => id !== proposalId && ["in_review", "approved"].includes(this.#s.proposals.get(id)?.status));
    if (decision === "approved" && otherId) {
      this.#append("proposal_resolved", {
        proposal_id: otherId, decision: "rejected", persons: panel.persons,
      });
    }
    return this.#s.panels.get(panel.proposal_id);
  }

  /* --------------------------- 角色与角色版本 --------------------------- */

  defineRole({ role_id, story_id, name, identity_witness_id }) {
    const roleId = requireId(role_id, "role_id");
    if (this.#s.roles.has(roleId)) throw new Error("角色编号已存在");
    const storyId = requireId(story_id, "story_id");
    if (!this.#s.stories.has(storyId)) throw new Error("故事不存在");
    if (identity_witness_id !== undefined && identity_witness_id !== null) {
      requireId(identity_witness_id, "identity_witness_id");
    }
    this.#append("role_defined", {
      role_id: roleId, story_id: storyId, name: requireText(name, "name"),
      identity_witness_id: identity_witness_id ?? null,
    });
    return this.#s.roles.get(roleId);
  }

  /**
   * 登记角色版本：把该角色每句台词绑定到一条已批准译稿。
   * 角色版本是演员表的最小换角单位——换角即换版本。
   */
  registerVersion({ version_id, role_id, label, segment_proposals }) {
    const versionId = requireId(version_id, "version_id");
    if (this.#s.versions.has(versionId)) throw new Error("版本编号已存在");
    const roleId = requireId(role_id, "role_id");
    if (!this.#s.roles.has(roleId)) throw new Error("角色不存在");
    const bindings = {};
    for (const [segmentId, proposalId] of Object.entries(segment_proposals ?? {})) {
      const sid = requireId(segmentId, "segment_id");
      const pid = requireId(proposalId, "proposal_id");
      const proposal = this.#s.proposals.get(pid);
      if (!proposal) throw new Error(`译稿不存在：${pid}`);
      if (proposal.segment_id !== sid) throw new Error(`译稿 ${pid} 不属于片段 ${sid}`);
      if (proposal.status !== "approved") throw new Error(`译稿 ${pid} 尚未批准，不能进入角色版本`);
      bindings[sid] = pid;
    }
    if (!Object.keys(bindings).length) throw new Error("角色版本至少绑定一句译稿");
    this.#append("version_registered", {
      version_id: versionId, role_id: roleId,
      label: requireText(label ?? versionId, "label"), segment_proposals: bindings,
    });
    return this.#s.versions.get(versionId);
  }

  /* --------------------------- 场次编排 --------------------------- */

  schedulePerformance({ performance_id, story_id, curtain_at, venue, channel_ids, cast }) {
    const performanceId = requireId(performance_id, "performance_id");
    if (this.#s.performances.has(performanceId)) throw new Error("场次编号已存在");
    const storyId = requireId(story_id, "story_id");
    if (!this.#s.stories.has(storyId)) throw new Error("故事不存在");
    const curtain = new Date(requireText(curtain_at, "curtain_at")).toISOString();
    if (Number.isNaN(new Date(curtain).getTime())) throw new Error("开演时间格式无效");
    const channelIds = [...new Set(
      (Array.isArray(channel_ids) ? channel_ids : []).map((c) => requireId(c, "channel_ids")),
    )];
    for (const channelId of channelIds) {
      if (!this.#s.channels.has(channelId)) throw new Error(`发布渠道不存在：${channelId}`);
    }
    const castMap = {};
    for (const [roleId, versionId] of Object.entries(cast ?? {})) {
      const rid = requireId(roleId, "cast.role");
      const vid = requireId(versionId, "cast.version");
      const version = this.#s.versions.get(vid);
      if (!version) throw new Error(`角色版本不存在：${vid}`);
      if (version.role_id !== rid) throw new Error(`版本 ${vid} 不属于角色 ${rid}`);
      castMap[rid] = vid;
    }
    this.#append("performance_scheduled", {
      performance_id: performanceId, story_id: storyId, curtain_at: curtain,
      venue: requireText(venue ?? "", "venue"), channel_ids: channelIds, cast: castMap,
    });
    return this.#s.performances.get(performanceId);
  }

  /** 锁定场次：此后只接收兼容（措辞）修订。 */
  lockPerformance(performanceRef) {
    const id = requireId(
      typeof performanceRef === "object" && performanceRef !== null
        ? performanceRef.performance_id
        : performanceRef,
      "performance_id",
    );
    const performance = this.#s.performances.get(id);
    if (!performance) throw new Error("场次不存在");
    if (performance.status === "cancelled") throw new Error("场次已取消");
    if (performance.status === "performed") throw new Error("场次已演出");
    if (performance.status === "locked") return performance;
    this.#append("performance_locked", { performance_id: id });
    return this.#s.performances.get(id);
  }

  /**
   * 锁定场次的兼容修订：
   * - 仅限 wording 措辞，且改的是本场当前版本；
   * - 同样的修订重复提交 => 返回原修订（幂等）；
   * - 修订文本与该场该句已接受的最新修订冲突 => 进入合议。
   */
  requestRevision(input) {
    const performanceId = requireId(input.performance_id, "performance_id");
    const versionId = requireId(input.version_id, "version_id");
    const segmentId = requireId(input.segment_id, "segment_id");
    const kind = String(input.kind ?? "wording");
    const newText = requireText(input.new_text, "new_text");

    const assessment = assessRevision(this.#s, {
      performance_id: performanceId, version_id: versionId, segment_id: segmentId, kind,
    });

    const fingerprint = revisionFingerprint({
      performance_id: performanceId, version_id: versionId, kind, new_text: newText,
    });
    const existingRevisionId = this.#s.revisionFingerprints.get(fingerprint);
    if (existingRevisionId) {
      return Object.freeze({ duplicate: true, revision: this.#s.revisions.get(existingRevisionId) });
    }

    // 与该场该句最新已接受文本不同且此前已有修订 => 内容冲突，进入合议，不直接生效。
    const prior = [...this.#s.revisions.values()]
      .filter((r) => r.performance_id === performanceId && r.version_id === versionId
        && r.segment_id === segmentId && r.status === "applied")
      .at(-1);
    const currentText = prior ? prior.new_text : assessment.proposal.english_text;
    if (prior && newText !== currentText) {
      this.#append("revision_disputed", {
        performance_id: performanceId, version_id: versionId, segment_id: segmentId,
        prior_revision_id: prior.revision_id,
        conflicting: { revision_fingerprint: fingerprint, new_text: newText,
          requester_id: requireId(input.requester_id ?? "stage-manager", "requester_id") },
        reason: "锁定场次改词与已接受修订内容冲突，须合议后才能生效",
      });
      return Object.freeze({
        duplicate: false, revision: null,
        dispute: this.#revisionDispute(performanceId, versionId, segmentId),
      });
    }

    const revisionId = input.revision_id
      ?? `rev-${performanceId}-${versionId}-${segmentId}-${fingerprint.slice(0, 8)}`;
    if (this.#s.revisions.has(revisionId)) throw new Error("修订编号已存在");
    this.#append("revision_requested", {
      revision_id: revisionId, performance_id: performanceId, version_id: versionId,
      segment_id: segmentId, kind, old_text: assessment.old_text, new_text: newText,
      reason: String(input.reason ?? ""),
      requester_id: requireId(input.requester_id ?? "stage-manager", "requester_id"),
      compatible: true, fingerprint,
    });
    return Object.freeze({ duplicate: false, revision: this.#s.revisions.get(revisionId) });
  }

  #revisionDispute(performanceId, versionId, segmentId) {
    return this.#s.disputes.get(`${performanceId}|${versionId}|${segmentId}`) ?? null;
  }

  /** 改词合议裁决：approve 则以争议文本形成新的兼容修订；reject 维持原文本。 */
  resolveRevisionDispute({ performance_id, version_id, segment_id, decision, note, decider_id }) {
    const performanceId = requireId(performance_id, "performance_id");
    const versionId = requireId(version_id, "version_id");
    const segmentId = requireId(segment_id, "segment_id");
    const dispute = this.#s.disputes.get(`${performanceId}|${versionId}|${segmentId}`);
    if (!dispute) throw new Error("该句没有待裁决的改词争议");
    assessRevision(this.#s, { performance_id: performanceId, version_id: versionId, segment_id: segmentId, kind: "wording" });
    if (decision === "approve") {
      const newText = dispute.conflicting.new_text;
      const fingerprint = revisionFingerprint({
        performance_id: performanceId, version_id: versionId, kind: "wording", new_text: newText,
      });
      if (this.#s.revisionFingerprints.has(fingerprint)) {
        return Object.freeze({ duplicate: true, revision: this.#s.revisions.get(this.#s.revisionFingerprints.get(fingerprint)) });
      }
      const revisionId = `rev-${performanceId}-${versionId}-${segmentId}-${fingerprint.slice(0, 8)}`;
      this.#append("revision_resolved", {
        performance_id: performanceId, version_id: versionId, segment_id: segmentId,
        decision: "approved", note: note ?? "", decider_id: String(decider_id ?? "panel"),
      });
      this.#append("revision_requested", {
        revision_id: revisionId, performance_id: performanceId, version_id: versionId,
        segment_id: segmentId, kind: "wording",
        old_text: this.#s.revisions.get(dispute.prior_revision_id)?.new_text ?? "",
        new_text: newText, reason: "改词合议通过",
        requester_id: dispute.conflicting.requester_id, compatible: true, fingerprint,
      });
      return Object.freeze({ duplicate: false, revision: this.#s.revisions.get(revisionId) });
    }
    this.#append("revision_resolved", {
      performance_id: performanceId, version_id: versionId, segment_id: segmentId,
      decision: "rejected", note: note ?? "", decider_id: String(decider_id ?? "panel"),
    });
    return Object.freeze({ duplicate: false, revision: null });
  }

  /** 临时换角：替换该角色场次版本，旧版本在本场冻结（未来使用范围）。 */
  changeCasting({ performance_id, role_id, version_id, reason }) {
    const performanceId = requireId(performance_id, "performance_id");
    const performance = this.#s.performances.get(performanceId);
    if (!performance) throw new Error("场次不存在");
    if (["cancelled", "performed"].includes(performance.status)) {
      throw new Error("已取消或已演出的场次不能换角");
    }
    const roleId = requireId(role_id, "role_id");
    const versionId = requireId(version_id, "version_id");
    const version = this.#s.versions.get(versionId);
    if (!version) throw new Error("角色版本不存在");
    if (version.role_id !== roleId) throw new Error("版本不属于该角色");
    if (performance.cast.get(roleId) === versionId) throw new Error("该角色本场已使用此版本");
    this.#append("casting_changed", {
      performance_id: performanceId, role_id: roleId, version_id: versionId,
      reason: requireText(reason ?? "临时换角", "reason"),
    });
    return this.#s.performances.get(performanceId);
  }

  /** 取消演出：冻结未来全部使用；不抹去任何此前记录。 */
  cancelPerformance({ performance_id, reason }) {
    const id = requireId(performance_id, "performance_id");
    const performance = this.#s.performances.get(id);
    if (!performance) throw new Error("场次不存在");
    if (performance.status === "cancelled") throw new Error("场次已取消");
    if (performance.status === "performed") throw new Error("已实际演出的场次不能取消");
    this.#append("performance_cancelled", { performance_id: id, reason: requireText(reason, "reason") });
    return this.#s.performances.get(id);
  }

  /** 记录“演出已经发生”这一事实：此后永久不可变，取消/撤回/换角都不能抹去。 */
  recordPerformance({ performance_id, release_id }) {
    const id = requireId(performance_id, "performance_id");
    const performance = this.#s.performances.get(id);
    if (!performance) throw new Error("场次不存在");
    if (performance.status === "cancelled") throw new Error("已取消场次不能记为演出");
    if (performance.status === "performed") return performance;
    this.#append("performance_recorded", {
      performance_id: id, release_id: release_id ?? performance.actual_release_id ?? null,
    });
    return this.#s.performances.get(id);
  }

  /* --------------------------- 发布渠道 --------------------------- */

  registerChannel({ channel_id, name, kind, endpoint }) {
    const channelId = requireId(channel_id, "channel_id");
    if (this.#s.channels.has(channelId)) throw new Error("渠道编号已存在");
    this.#append("channel_registered", {
      channel_id: channelId, name: requireText(name, "name"),
      kind: requireText(kind ?? "subtitle", "kind"), endpoint: String(endpoint ?? ""),
    });
    return this.#s.channels.get(channelId);
  }

  /* --------------------------- 发布包任务（可控时钟 / 崩溃续跑） --------------------------- */

  /**
   * 为场次安排一个开演前发布任务。同一时刻点只安排一个任务；
   * 已完成的场次重复安排直接返回原发布结果（幂等）。
   */
  scheduleRelease({ performance_id, lead_ms = 60 * 60 * 1000 }) {
    const performanceId = requireId(performance_id, "performance_id");
    const performance = this.#s.performances.get(performanceId);
    if (!performance) throw new Error("场次不存在");

    const existing = [...this.#s.jobs.values()].find((j) => j.performance_id === performanceId);
    if (existing && existing.status === "completed") {
      return Object.freeze({ job: existing, duplicate: true });
    }
    if (existing) {
      return Object.freeze({ job: existing, duplicate: true });
    }

    if (performance.status === "cancelled") throw new Error("场次已取消，不生成发布包");
    const curtainMs = new Date(performance.curtain_at).getTime();
    const scheduledAt = new Date(curtainMs - lead_ms).toISOString();
    const jobId = `job-${performanceId}`;
    this.#append("release_job_scheduled", {
      job_id: jobId, performance_id: performanceId,
      attempt: 1, scheduled_at: scheduledAt,
    });
    return Object.freeze({ job: this.#s.jobs.get(jobId), duplicate: false });
  }

  /**
   * 按可控时钟处理到期任务：now >= 计划时间 且 状态为 pending/running 的任务继续执行。
   * 进程中断后重新调用即可从日志恢复并续跑；已完成任务不会重复生成，
   * 每个场次的发布包由其内容哈希唯一标识。
   */
  async runDueJobs({ now, signal, crashAfterStart = false } = {}) {
    const at = now ?? this.clock.now();
    const results = [];
    for (const job of [...this.#s.jobs.values()]) {
      if (!["pending", "running"].includes(job.status)) continue;
      if (new Date(at).getTime() < new Date(job.scheduledAt).getTime()) continue;
      const performance = this.#s.performances.get(job.performance_id);
      if (!performance || performance.status === "cancelled") {
        const reason = "场次已取消或不存在，发布任务终止";
        if (job.error !== reason) {
          this.#append("release_generation_failed", {
            job_id: job.job_id, attempts: job.attempts + 1, reason,
          });
        }
        continue;
      }
      if (new Date(at).getTime() >= new Date(performance.curtain_at).getTime()) {
        const reason = "已超过开演时刻，不能再生成开演前发布包";
        if (job.error !== reason) {
          this.#append("release_generation_failed", {
            job_id: job.job_id, attempts: job.attempts + 1, reason,
          });
        }
        continue;
      }

      const attempt = (job.attempts ?? 0) + 1;
      this.#append("release_generation_started", { job_id: job.job_id, attempt });

      // 中断注入：进程在构建发布包前崩溃，任务保持待续跑，重启后从中断处继续。
      if (signal?.aborted || crashAfterStart) {
        this.#append("release_generation_failed", {
          job_id: job.job_id, attempts: attempt, reason: "进程中断，待续跑",
        });
        if (crashAfterStart) throw new Error("模拟进程中断");
        results.push({ job_id: job.job_id, interrupted: true });
        continue;
      }

      const { manifest, packageHash } = buildReleaseManifest(this.#s, performance, at);
      const releaseId = `release-${performance.performance_id}-${packageHash.slice(0, 12)}`;
      this.#append("release_package_built", {
        release_id: releaseId, job_id: job.job_id, performance_id: performance.performance_id,
        package_hash: packageHash, curtain_at: performance.curtain_at, manifest,
      });
      // 向该场各渠道登记投递回执（渠道只是记录目标；投递为确定性回执，便于追溯）。
      for (const channelId of performance.channel_ids) {
        this.#append("release_delivered", {
          channel_id: channelId, release_id: releaseId,
          receipt: contentHash({ channel_id: channelId, package_hash: packageHash }),
        });
      }
      results.push({ job_id: job.job_id, release_id: releaseId, package_hash: packageHash });
    }
    return results;
  }

  getJob(jobId) {
    return this.#s.jobs.get(requireId(jobId, "job_id")) ?? null;
  }

  getRelease(releaseId) {
    return this.#s.releases.get(String(releaseId)) ?? null;
  }

  /* --------------------------- 查询 --------------------------- */

  getStory(id) { return this.#s.stories.get(String(id)) ?? null; }
  getSource(id) { return this.#s.sources.get(String(id)) ?? null; }
  getSegment(id) { return this.#s.segments.get(String(id)) ?? null; }
  getProposal(id) { return this.#s.proposals.get(String(id)) ?? null; }
  getPermit(id) { return this.#s.permits.get(String(id)) ?? null; }
  getRole(id) { return this.#s.roles.get(String(id)) ?? null; }
  getVersion(id) { return this.#s.versions.get(String(id)) ?? null; }
  getPerformance(id) { return this.#s.performances.get(String(id)) ?? null; }
  getChannel(id) { return this.#s.channels.get(String(id)) ?? null; }

  /** 某条译稿的复核门槛现状。 */
  proposalReviewStatus(proposalId) {
    const proposal = this.#s.proposals.get(requireId(proposalId, "proposal_id"));
    if (!proposal) throw new Error("译稿不存在");
    return reviewStatus(this.#s, proposal);
  }

  /** 某条译稿在各场次的生效与冻结情况。 */
  proposalEffect(proposalId) {
    const id = requireId(proposalId, "proposal_id");
    const proposal = this.#s.proposals.get(id);
    if (!proposal) throw new Error("译稿不存在");
    return {
      proposal_id: id,
      status: proposal.status,
      effective_performances: effectivePerformances(this.#s, id),
      freeze_impacts: freezeImpacts(this.#s, id),
    };
  }

  /** 逐句溯源接口。 */
  trace(segmentId, options = {}) {
    return traceLine(this.#s, requireId(segmentId, "segment_id"), options);
  }

  allEvents() {
    return this.repository.allEvents();
  }
}
