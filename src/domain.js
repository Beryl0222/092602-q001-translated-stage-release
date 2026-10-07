/**
 * 国际剧目译演发布 —— 领域核心。
 *
 * 设计要点：
 * - 全部状态变更都是不可变事件（append-only），任何已经发生的事实（演出记录、
 *   当时批准、当时发布包）都不会被覆盖或删除；取消、换角、撤回只写入新的冻结事件，
 *   影响“未来使用范围”。
 * - 事件回放得到当前投影（projection），所有规则（复核门槛、兼容性、冻结影响）
 *   都在投影上做纯函数判定，便于测试与重建。
 */
import crypto from "node:crypto";

export const PERFORMANCE_STATES = ["scheduled", "locked", "performed", "cancelled"];
export const REVIEW_KINDS = ["cultural", "historical", "identity"];
export const REVISION_KINDS = ["wording", "cultural", "historical", "identity"];

/* ------------------------------- 基础工具 ------------------------------- */

export function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

export function requireId(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@~-]*$/.test(text)) {
    throw new Error(`${label}只能包含字母、数字与 . _ : @ ~ -，且以字母或数字开头`);
  }
  return text;
}

/** 稳定哈希：相同语义内容（键排序后序列化）永远得到同一结果，用于幂等与内容冲突识别。 */
export function contentHash(value) {
  if (typeof value === "string") return crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return crypto
    .createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** 译稿语义指纹：同一片段、同一提交者，对“英文文本+文化说明”的相同重复提交。 */
export function proposalFingerprint(input) {
  return contentHash({
    segment_id: String(input.segment_id),
    translator_id: String(input.translator_id),
    english_text: String(input.english_text ?? ""),
            cultural_note: String(input.cultural_note ?? ""),
  });
}

/** 兼容修订指纹：同一锁定场次、同一角色版本、同一类修订、同样的新文本。 */
export function revisionFingerprint(input) {
  return contentHash({
    performance_id: String(input.performance_id),
    version_id: input.version_id ? String(input.version_id) : "",
    kind: String(input.kind),
    new_text: String(input.new_text ?? ""),
  });
}

/* ------------------------------- 事件回放投影 ------------------------------- */

/**
 * 从事件流重建当前状态。事件不允许物理删除：撤回类事件只改变投影中的可用性。
 */
export function replay(events) {
  const state = {
    stories: new Map(),
    sources: new Map(),
    segments: new Map(),
    proposals: new Map(),
    reviews: new Map(), // review_id -> 复核记录
    permits: new Map(), // permit_id -> 亲历者许可
    roles: new Map(),
    versions: new Map(),
    performances: new Map(),
    channels: new Map(),
    releases: new Map(), // release_id -> 发布包（含明细）
    jobs: new Map(), // job_id -> 发布任务（含 pending/package 状态）
    revisions: new Map(), // revision_id -> 兼容修订
    panels: new Map(), // proposal_id -> 合议记录
    disputes: new Map(), // `${performance_id}|${version_id}|${segment_id}` -> 最新改词争议
    records: new Map(), // 通用领域记录（向后兼容早期 record_id 登记）
    deliveries: new Map(), // `${channel_id}|${release_id}` -> 投递回执
    reviewByKey: new Map(), // `${permit_id}|${proposal_id}|${kind}` -> review
    versionByRole: new Map(), // role_id -> 当前版本
    fingerprints: new Map(), // proposal 指纹 -> proposal_id（同片段同译者重复提交判定）
    revisionFingerprints: new Map(), // 修订指纹 -> revision_id
    eventSeq: 0,
  };

  for (const event of events) apply(state, event);
  return state;
}

function put(map, id, value) {
  map.set(id, Object.freeze({ ...value }));
}

/** 增量应用事件到投影（事件本身不可变，投影只随追加更新）。 */
export function applyEvent(state, event) {
  state.eventSeq = event.seq;
  apply(state, event);
}

function apply(state, event) {
  switch (event.type) {
    case "story_registered":
      put(state.stories, event.story_id, { story_id: event.story_id, title: event.title, registered_at: event.at });
      break;

    case "source_registered":
      put(state.sources, event.source_id, {
        source_id: event.source_id, story_id: event.story_id, witness_id: event.witness_id,
        title: event.title, registered_at: event.at,
      });
      break;

    case "segment_registered":
      put(state.segments, event.segment_id, {
        segment_id: event.segment_id, source_id: event.source_id, ordinal: event.ordinal,
        chinese_text: event.chinese_text, witness_ids: [...event.witness_ids],
        registered_at: event.at,
      });
      break;

    case "permit_granted":
      put(state.permits, event.permit_id, {
        permit_id: event.permit_id, story_id: event.story_id, witness_id: event.witness_id,
        scope: { segment_ids: [...(event.scope?.segment_ids ?? [])] },
        granted_at: event.at, status: "active",
        history: [{ status: "active", at: event.at, reason: event.reason ?? "" }],
      });
      break;

    case "permit_revoked": {
      const permit = state.permits.get(event.permit_id);
      if (permit) {
        put(state.permits, event.permit_id, {
          ...permit, status: "revoked",
          history: [...permit.history, { status: "revoked", at: event.at, reason: event.reason }],
        });
      }
      break;
    }

    case "proposal_submitted":
      put(state.proposals, event.proposal_id, {
        proposal_id: event.proposal_id, segment_id: event.segment_id,
        translator_id: event.translator_id, branch: event.branch,
        english_text: event.english_text, cultural_note: event.cultural_note,
        change_kinds: [...event.change_kinds], content_hash: event.content_hash,
        idempotency_key: event.idempotency_key, status: "in_review",
        based_on_source: event.based_on_source,
        submitted_at: event.at, supersession: event.supersession ?? null,
      });
      state.fingerprints.set(event.fingerprint, event.proposal_id);
      break;

    case "review_recorded": {
      const key = reviewKey(event.permit_id, event.proposal_id, event.kind);
      const review = {
        review_id: event.review_id, permit_id: event.permit_id, proposal_id: event.proposal_id,
        kind: event.kind, reviewer_id: event.reviewer_id, decision: event.decision,
        note: event.note ?? "", recorded_at: event.at,
      };
      put(state.reviews, event.review_id, review);
      state.reviewByKey.set(key, review);
      break;
    }

    case "proposal_resolved": {
      const proposal = state.proposals.get(event.proposal_id);
      if (proposal) {
        put(state.proposals, event.proposal_id, {
          ...proposal, status: event.decision, resolved_at: event.at,
          panel: event.persons ?? proposal.panel ?? null,
        });
      }
      break;
    }

    case "role_defined":
      put(state.roles, event.role_id, {
        role_id: event.role_id, story_id: event.story_id, name: event.name,
        identity_witness_id: event.identity_witness_id ?? null, defined_at: event.at,
      });
      break;

    case "version_registered": {
      put(state.versions, event.version_id, {
        version_id: event.version_id, role_id: event.role_id, label: event.label,
        segment_proposals: Object.freeze({ ...event.segment_proposals }),
        created_at: event.at, status: "active",
      });
      state.versionByRole.set(event.role_id, event.version_id);
      break;
    }

    case "casting_changed": {
      const performance = state.performances.get(event.performance_id);
      if (performance) {
        const cast = new Map(Array.from(performance.cast, ([role, version]) => [role, version]));
        const previousVersionId = cast.get(event.role_id) ?? null;
        cast.set(event.role_id, event.version_id);
        const castHistory = [
          ...performance.castHistory,
          { at: event.at, role_id: event.role_id, version_id: event.version_id, reason: event.reason },
        ];
        // 被换下的旧版本在该场冻结（若与新版本不同）；这是冻结判定依据，而非当前演员表。
        const frozenVersions = [...performance.frozenVersions];
        if (previousVersionId && previousVersionId !== event.version_id) {
          frozenVersions.push({
            role_id: event.role_id, version_id: previousVersionId, at: event.at, reason: event.reason,
          });
        }
        put(state.performances, event.performance_id, {
          ...performance,
          cast: Object.freeze(new Map(cast)),
          castHistory, frozenVersions,
          frozen_at: event.at,
        });
      }
      break;
    }

    case "performance_scheduled":
      put(state.performances, event.performance_id, {
        performance_id: event.performance_id, story_id: event.story_id, curtain_at: event.curtain_at,
        venue: event.venue, channel_ids: [...event.channel_ids],
        status: "scheduled",
        cast: Object.freeze(new Map(Object.entries(event.cast ?? {}))),
        castHistory: event.cast
          ? Object.entries(event.cast).map(([role_id, version_id]) => ({
              at: event.at, role_id, version_id, reason: "initial",
            }))
          : [],
        frozenVersions: [],
        revisions: [], locked_at: null, performed_at: null, cancelled_at: null,
        scheduled_at: event.at,
      });
      break;

    case "performance_locked": {
      const performance = state.performances.get(event.performance_id);
      if (performance) {
        put(state.performances, event.performance_id, { ...performance, status: "locked", locked_at: event.at });
      }
      break;
    }

    case "revision_requested": {
      const performance = state.performances.get(event.performance_id);
      if (performance) {
        put(state.revisions, event.revision_id, {
          revision_id: event.revision_id, performance_id: event.performance_id,
          version_id: event.version_id, segment_id: event.segment_id,
          kind: event.kind, old_text: event.old_text, new_text: event.new_text,
          reason: event.reason, requester_id: event.requester_id,
          compatible: event.compatible, status: "applied", requested_at: event.at,
        });
        state.revisionFingerprints.set(event.fingerprint, event.revision_id);
        put(state.performances, event.performance_id, {
          ...performance,
          revisions: [...performance.revisions, event.revision_id],
        });
      }
      break;
    }

    case "revision_disputed":
      state.disputes.set(
        `${event.performance_id}|${event.version_id}|${event.segment_id}`,
        Object.freeze({
          performance_id: event.performance_id, version_id: event.version_id,
          segment_id: event.segment_id, prior_revision_id: event.prior_revision_id,
          conflicting: { ...event.conflicting }, reason: event.reason, at: event.at,
        }),
      );
      break;

    case "performance_cancelled": {
      const performance = state.performances.get(event.performance_id);
      if (performance) {
        put(state.performances, event.performance_id, {
          ...performance, status: "cancelled", cancelled_at: event.at,
          cancel_reason: event.reason,
        });
      }
      break;
    }

    case "performance_recorded": {
      const performance = state.performances.get(event.performance_id);
      if (performance) {
        put(state.performances, event.performance_id, {
          ...performance, status: "performed", performed_at: event.at,
          actual_release_id: event.release_id ?? performance.actual_release_id ?? null,
        });
      }
      break;
    }

    case "channel_registered":
      put(state.channels, event.channel_id, {
        channel_id: event.channel_id, name: event.name, kind: event.kind,
        endpoint: event.endpoint, registered_at: event.at,
      });
      break;

    case "release_job_scheduled":
      put(state.jobs, event.job_id, {
        job_id: event.job_id, performance_id: event.performance_id,
        status: "pending", attempts: event.attempt, createdAt: event.at,
        scheduledAt: event.scheduled_at, startedAt: null, finishedAt: null,
        error: null, release_id: null, package_hash: null,
      });
      break;

    case "release_generation_started": {
      const job = state.jobs.get(event.job_id);
      if (job) {
        put(state.jobs, event.job_id, { ...job, status: "running", startedAt: event.at, attempts: event.attempt });
      }
      break;
    }

    case "release_package_built": {
      const job = state.jobs.get(event.job_id);
      const release = {
        release_id: event.release_id, job_id: event.job_id, performance_id: event.performance_id,
        package_hash: event.package_hash, built_at: event.at, curtain_at: event.curtain_at,
        manifest: event.manifest,
      };
      put(state.releases, event.release_id, release);
      if (job) {
        put(state.jobs, event.job_id, {
          ...job, status: "completed", finishedAt: event.at,
          release_id: event.release_id, package_hash: event.package_hash, error: null,
        });
      }
      break;
    }

    case "panel_convened":
      put(state.panels, event.proposal_id, {
        proposal_id: event.proposal_id, convened_at: event.at,
        persons: [...event.persons], reason: event.reason,
        conflicting: Object.freeze({ ...event.conflicting }),
        status: "open", decision: null, decided_at: null,
      });
      break;

    case "panel_decided": {
      const panel = state.panels.get(event.proposal_id);
      if (panel) {
        put(state.panels, event.proposal_id, {
          ...panel, status: "decided", decision: event.decision,
          decided_at: event.at, note: event.note ?? "",
        });
      }
      break;
    }

    case "record_registered":
      put(state.records, event.record_id, {
        record_id: event.record_id, owner_id: event.owner_id, state: event.state,
        revision: event.revision, created_at: event.at,
      });
      break;

    case "release_delivered": {
      state.deliveries.set(`${event.channel_id}|${event.release_id}`, {
        channel_id: event.channel_id, release_id: event.release_id,
        delivered_at: event.at, receipt: event.receipt,
      });
      break;
    }

    case "release_generation_failed": {
      const job = state.jobs.get(event.job_id);
      if (job) {
        put(state.jobs, event.job_id, {
          ...job, status: "pending", error: event.reason,
          attempts: event.attempts, lastTriedAt: event.at,
        });
      }
      break;
    }

    default:
      break; // 未知事件类型向前兼容：忽略但保留在日志中
  }
}

export function reviewKey(permitId, proposalId, kind) {
  return `${permitId}|${proposalId}|${kind}`;
}

/* ------------------------------- 规则查询（纯函数） ------------------------------- */

/** 译稿相对其涉及片段所声明的改动类别（去重、保序）。 */
export function normalizeChangeKinds(kinds) {
  const result = [];
  for (const raw of Array.isArray(kinds) ? kinds : []) {
    const kind = String(raw);
    if (!REVISION_KINDS.includes(kind)) throw new Error(`未知改动类别：${kind}`);
    if (!result.includes(kind)) result.push(kind);
  }
  return result;
}

/** 敏感改动：涉及史实或人物身份，必须经相应授权人复核。 */
export function sensitiveKinds(changeKinds) {
  return changeKinds.filter((kind) => kind === "historical" || kind === "identity");
}

/**
 * 某条译稿当前是否满足复核门槛：
 * 每个敏感类别都需要覆盖该片段的、仍然有效的亲历者许可对应的授权人复核通过。
 * 返回 { ok, missing }，missing 给出尚缺的复核（kind、permit_id、witness_id）。
 */
export function reviewStatus(state, proposal) {
  const segment = state.segments.get(proposal.segment_id);
  const missing = [];
  const approvals = [];
  for (const kind of sensitiveKinds(proposal.change_kinds)) {
    for (const permit of coveringPermits(state, segment)) {
      const review = state.reviewByKey.get(reviewKey(permit.permit_id, proposal.proposal_id, kind));
      if (review && review.decision === "approved") {
        approvals.push({ kind, permit_id: permit.permit_id, witness_id: permit.witness_id, review_id: review.review_id });
      } else {
        missing.push({ kind, permit_id: permit.permit_id, witness_id: permit.witness_id });
      }
    }
  }
  return { ok: missing.length === 0, missing, approvals };
}

/** 覆盖某片段的亲历者许可：片段登记的亲历者每人一份有效许可。 */
export function coveringPermits(state, segment) {
  if (!segment) return [];
  const permits = [];
  for (const witnessId of segment.witness_ids) {
    const permit = [...state.permits.values()].find(
      (p) => p.witness_id === witnessId && p.scope.segment_ids.includes(segment.segment_id) && p.status === "active",
    );
    if (permit) permits.push(permit);
  }
  return permits;
}

/**
 * 锁定场次的兼容修订判定：
 * - 仅允许 wording（舞台改词）类修订；
 * - 只能改当前该角色场次实际使用的译稿；
 * - 不能落到已冻结（换角后旧版本停用、许可撤回）的译稿上；
 * - 取消或已实际演出后的场次不再接收修订。
 */
export function assessRevision(state, input) {
  const performance = state.performances.get(input.performance_id);
  if (!performance) throw new Error("场次不存在");
  if (performance.status === "cancelled") throw new Error("演出已取消，不能再修订字幕");
  if (performance.status === "performed") throw new Error("演出已实际发生，锁定内容不得再改");
  if (performance.status !== "locked") throw new Error("只有已锁定场次才能提交兼容修订");
  if (input.kind !== "wording") {
    throw new Error("锁定场次只接收措辞类（wording）兼容修订，史实或身份改动须走新译稿复核");
  }
  const version = state.versions.get(input.version_id);
  if (!version) throw new Error("角色版本不存在");
  const castVersionId = performance.cast.get(version.role_id);
  if (castVersionId !== version.version_id) {
    throw new Error("该角色版本不在本场当前演员表中（可能已换角），只能修订当前上演版本");
  }
  if (performance.frozenVersions.some((f) => f.version_id === version.version_id)) {
    throw new Error("该角色版本已被换角冻结，只能修订当前上演版本");
  }
  const proposalId = version.segment_proposals[input.segment_id];
  if (!proposalId) throw new Error("该角色版本在这一句上没有可修订的译稿");
  const proposal = state.proposals.get(proposalId);
  if (!proposal || proposal.status !== "approved") throw new Error("只能修订已批准译稿");
  const freezes = freezeImpacts(state, proposal.proposal_id);
  const here = freezes.find((f) => f.performance_id === performance.performance_id);
  if (here) throw new Error(`译稿在本场次已冻结：${here.reason}`);
  return { version, proposal, old_text: proposal.english_text };
}

/**
 * 计算某条译稿受到的全部冻结影响（换角 / 许可撤回 / 场次取消）。
 * 已实际演出的记录保留为 performed_immutable，不被冻结也不会被抹去。
 */
export function freezeImpacts(state, proposalId) {
  const proposal = state.proposals.get(proposalId);
  if (!proposal) return [];
  const segment = state.segments.get(proposal.segment_id);
  const impacts = [];

  // 1) 亲历者许可撤回：冻结所有尚未演出的未来场次。
  if (segment) {
    for (const witnessId of segment.witness_ids) {
      const permit = [...state.permits.values()].find((p) => p.witness_id === witnessId);
      if (permit && permit.status === "revoked") {
        const revokedAt = permit.history[permit.history.length - 1]?.at;
        for (const performance of state.performances.values()) {
          if (usesProposal(state, performance, proposalId)) {
            if (performance.status === "performed") {
              impacts.push({
                performance_id: performance.performance_id, kind: "permit_revoked",
                reason: `亲历者 ${witnessId} 撤回许可，但该场已演出，记录保留`, at: revokedAt,
                effect: "performed_immutable",
              });
            } else if (performance.status !== "cancelled") {
              impacts.push({
                performance_id: performance.performance_id, kind: "permit_revoked",
                reason: `亲历者 ${witnessId} 撤回许可，停用于未演出场次`, at: revokedAt,
                effect: "frozen_future_use",
              });
            }
          }
        }
      }
    }
  }

  // 2) 换角：被换下的旧角色版本在其换角且尚未演出的场次停用；
  //    若新演员表的新版本仍使用同一条译稿，该译稿在本场继续生效，不因换角冻结。
  for (const performance of state.performances.values()) {
    for (const frozen of performance.frozenVersions) {
      const oldVersion = state.versions.get(frozen.version_id);
      if (!oldVersion || oldVersion.segment_proposals[proposal.segment_id] !== proposalId) continue;
      const currentVersionId = performance.cast.get(frozen.role_id);
      const currentVersion = state.versions.get(currentVersionId);
      if (currentVersion && currentVersion.segment_proposals[proposal.segment_id] === proposalId) continue;
      if (performance.status === "performed") {
        impacts.push({
          performance_id: performance.performance_id, kind: "casting_changed",
          reason: `角色 ${frozen.role_id} 换角前使用旧版本，但该场已演出，记录保留`,
          at: frozen.at, effect: "performed_immutable",
        });
      } else if (performance.status !== "cancelled") {
        impacts.push({
          performance_id: performance.performance_id, kind: "casting_changed",
          reason: `角色 ${frozen.role_id} 已换角，旧版本在该场停用`,
          at: frozen.at, effect: "frozen_future_use",
        });
      }
    }
  }

  // 3) 场次取消：整场冻结未来使用，演出事实层面另行保留取消记录。
  for (const performance of state.performances.values()) {
    if (performance.status === "cancelled" && usesProposal(state, performance, proposalId)) {
      impacts.push({
        performance_id: performance.performance_id, kind: "performance_cancelled",
        reason: "场次已取消，字幕不再对外使用", at: performance.cancelled_at,
        effect: "frozen_future_use",
      });
    }
  }

  return impacts;
}

function usesProposal(state, performance, proposalId) {
  for (const versionId of new Set(performance.cast.values())) {
    const version = state.versions.get(versionId);
    if (version && Object.values(version.segment_proposals).includes(proposalId)) return true;
  }
  return false;
}

/** 某条译稿在当前仍可生效的场次（未取消、未演出、未被冻结）。 */
export function effectivePerformances(state, proposalId) {
  const frozen = new Set(
    freezeImpacts(state, proposalId)
      .filter((i) => i.effect === "frozen_future_use")
      .map((i) => i.performance_id),
  );
  const result = [];
  for (const performance of state.performances.values()) {
    if (frozen.has(performance.performance_id)) continue;
    if (!usesProposal(state, performance, proposalId)) continue;
    if (performance.status === "cancelled") continue;
    result.push({
      performance_id: performance.performance_id,
      status: performance.status,
      curtain_at: performance.curtain_at,
      immutable: performance.status === "performed",
    });
  }
  return result;
}

/* ------------------------------- 发布包组装（纯函数） ------------------------------- */

/** 场次发布包：开演前按当时冻结的演员表、兼容修订与许可状态逐句生成。 */
export function buildReleaseManifest(state, performance, builtAt) {
  const lines = [];
  for (const [roleId, versionId] of performance.cast.entries()) {
    const version = state.versions.get(versionId);
    if (!version) continue;
    for (const [segmentId, proposalId] of Object.entries(version.segment_proposals)) {
      const segment = state.segments.get(segmentId);
      const proposal = state.proposals.get(proposalId);
      if (!segment || !proposal) continue;
      const freezes = freezeImpacts(state, proposalId).filter(
        (f) => f.performance_id === performance.performance_id && f.effect === "frozen_future_use",
      );
      const statusReasons = proposal.status === "approved" ? [] : [`译稿当前状态为 ${proposal.status}`];
      // 以该场次已接受的措辞修订覆盖演出文本。
      const revision = [...performance.revisions]
        .map((id) => state.revisions.get(id))
        .filter(Boolean)
        .filter((r) => r.version_id === versionId && r.segment_id === segmentId)
        .at(-1);
      lines.push({
        role_id: roleId,
        version_id: versionId,
        segment_id: segmentId,
        source_id: segment.source_id,
        proposal_id: proposalId,
        chinese_text: segment.chinese_text,
        english_text: revision ? revision.new_text : proposal.english_text,
        revision_id: revision ? revision.revision_id : null,
        permits: segment.witness_ids.map((witnessId) => {
          const permit = [...state.permits.values()].find(
            (p) => p.witness_id === witnessId && p.scope.segment_ids.includes(segmentId),
          );
          return {
            permit_id: permit?.permit_id ?? null,
            witness_id: witnessId,
            status: permit?.status ?? "missing",
          };
        }),
        usable: freezes.length === 0 && statusReasons.length === 0,
        freeze_reasons: [...freezes.map((f) => f.reason), ...statusReasons],
      });
    }
  }
  const manifest = {
    performance_id: performance.performance_id,
    story_id: performance.story_id,
    curtain_at: performance.curtain_at,
    venue: performance.venue,
    channels: [...performance.channel_ids],
    cast: Object.fromEntries(performance.cast.entries()),
    built_at: builtAt,
    lines,
  };
  return { manifest, packageHash: contentHash(manifest) };
}

/** 逐句溯源：这句字幕采用了哪版原稿、谁批准、在哪些场次生效、撤回后受到什么影响。 */
export function traceLine(state, segmentId, options = {}) {
  const segment = state.segments.get(segmentId);
  if (!segment) throw new Error("片段不存在");
  const source = state.sources.get(segment.source_id);

  const rows = [];
  for (const proposal of state.proposals.values()) {
    if (proposal.segment_id !== segmentId) continue;
    if (options.performanceId) {
      const performance = state.performances.get(options.performanceId);
      if (!performance) throw new Error("场次不存在");
      const used = [...performance.cast.values()].some((versionId) => {
        const version = state.versions.get(versionId);
        return version && version.segment_proposals[segmentId] === proposal.proposal_id;
      });
      if (!used) continue;
    }
    const reviewsForProposal = [...state.reviews.values()].filter(
      (r) => r.proposal_id === proposal.proposal_id,
    );
    rows.push({
      proposal_id: proposal.proposal_id,
      branch: proposal.branch,
      status: proposal.status,
      based_on_source: {
        source_id: source.source_id,
        witness_id: source.witness_id,
        chinese_text: segment.chinese_text,
        ordinal: segment.ordinal,
      },
      submitted_by: proposal.translator_id,
      submitted_at: proposal.submitted_at,
      approvals: reviewsForProposal
        .filter((r) => r.decision === "approved")
        .map((r) => ({
          kind: r.kind, permit_id: r.permit_id,
          reviewer_id: r.reviewer_id, reviewed_at: r.recorded_at,
        })),
      effective_performances: effectivePerformances(state, proposal.proposal_id),
      freeze_impacts: freezeImpacts(state, proposal.proposal_id),
    });
  }

  return {
    segment_id: segmentId,
    source: {
      source_id: source.source_id, story_id: source.story_id,
      witness_id: source.witness_id, chinese_text: segment.chinese_text,
    },
    proposals: rows,
  };
}
