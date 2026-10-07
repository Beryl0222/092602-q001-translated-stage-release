import { createHash } from "node:crypto";

/** 基础领域记录及输入校验。 */
export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: payload.created_at || new Date().toISOString(),
  });
}

/** 校验必填字段是否存在。 */
export function requireFields(payload, fields, label) {
  const missing = fields.filter((name) => !String(payload?.[name] ?? "").trim());
  if (missing.length) throw new Error(`${label}缺少必要字段：${missing.join("、")}`);
}

/** 解析并规范化为 ISO 时间。 */
export function parseTime(value, label) {
  const time = Date.parse(value);
  if (value == null || Number.isNaN(time)) throw new Error(`${label}必须是有效时间`);
  return new Date(time).toISOString();
}

function asStringList(value) {
  return [...new Set((value ?? []).map((item) => String(item).trim()).filter(Boolean))];
}

/** 原稿版本在仓库中的键。 */
export function manuscriptKey(manuscriptId, version) {
  return `${manuscriptId}@v${version}`;
}

/** 故事片段：译演内容的源头。 */
export function createFragment(payload, at) {
  requireFields(payload, ["fragment_id", "title"], "故事片段");
  return {
    fragment_id: String(payload.fragment_id),
    title: String(payload.title),
    summary: String(payload.summary ?? ""),
    registered_at: at,
  };
}

/** 中文原稿：同一 manuscript_id 下按 version 递增，台词行携带敏感标记。 */
export function createManuscript(payload, at) {
  requireFields(payload, ["manuscript_id", "fragment_id", "author_id"], "中文原稿");
  const version = Number(payload.version ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("version 必须是正整数");
  const lines = (payload.lines ?? []).map((line, index) => {
    requireFields(line, ["line_id", "text"], `原稿第 ${index + 1} 行`);
    return {
      line_id: String(line.line_id),
      text: String(line.text),
      involves_history: Boolean(line.involves_history),
      involves_identity: Boolean(line.involves_identity),
      person_refs: asStringList(line.person_refs),
      requires_license: Boolean(line.requires_license),
    };
  });
  if (!lines.length) throw new Error("中文原稿缺少必要字段：lines");
  if (new Set(lines.map((line) => line.line_id)).size !== lines.length) {
    throw new Error("原稿台词行编号重复");
  }
  return {
    manuscript_id: String(payload.manuscript_id),
    fragment_id: String(payload.fragment_id),
    author_id: String(payload.author_id),
    version,
    lines,
    registered_at: at,
  };
}

/** 翻译分支：译者并行提交方案的独立线索，基于某一版原稿。 */
export function createBranch(payload, at) {
  requireFields(payload, ["branch_id", "manuscript_id", "language", "translator_id"], "翻译分支");
  const version = Number(payload.manuscript_version ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("manuscript_version 必须是正整数");
  const base = payload.base_lines ?? {};
  if (typeof base !== "object" || Array.isArray(base) || !Object.keys(base).length) {
    throw new Error("翻译分支缺少基础译文：base_lines");
  }
  const baseLines = {};
  for (const [lineId, text] of Object.entries(base)) baseLines[String(lineId)] = String(text);
  return {
    branch_id: String(payload.branch_id),
    manuscript_id: String(payload.manuscript_id),
    manuscript_version: version,
    language: String(payload.language),
    translator_id: String(payload.translator_id),
    base_lines: baseLines,
    opened_at: at,
    status: "open",
  };
}

/** 剧目：把故事片段、原稿版本与翻译分支绑定为可排演的作品。 */
export function createProduction(payload, at) {
  requireFields(payload, ["production_id", "fragment_id", "manuscript_id", "branch_id"], "剧目");
  const version = Number(payload.manuscript_version ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("manuscript_version 必须是正整数");
  return {
    production_id: String(payload.production_id),
    fragment_id: String(payload.fragment_id),
    manuscript_id: String(payload.manuscript_id),
    manuscript_version: version,
    branch_id: String(payload.branch_id),
    title: String(payload.title ?? ""),
    registered_at: at,
  };
}

/** 发布渠道：现场字幕、流媒体、出版物等。 */
export function createChannel(payload, at) {
  requireFields(payload, ["channel_id", "kind"], "发布渠道");
  return {
    channel_id: String(payload.channel_id),
    kind: String(payload.kind),
    region: String(payload.region ?? ""),
    registered_at: at,
  };
}

/** 文化说明：挂在故事片段上，可指向具体台词行。 */
export function createNote(payload, at) {
  requireFields(payload, ["note_id", "fragment_id", "author_id", "text"], "文化说明");
  return {
    note_id: String(payload.note_id),
    fragment_id: String(payload.fragment_id),
    line_id: payload.line_id ? String(payload.line_id) : null,
    author_id: String(payload.author_id),
    text: String(payload.text),
    created_at: at,
  };
}

/** 复核人类别：史实复核与人物身份授权。 */
export const APPROVAL_KINDS = ["history", "identity"];

/** 授权复核人登记。 */
export function createApprover(payload, at) {
  requireFields(payload, ["approver_id"], "复核人");
  const kinds = asStringList(payload.kinds);
  if (!kinds.length || kinds.some((kind) => !APPROVAL_KINDS.includes(kind))) {
    throw new Error(`复核人类别必须是：${APPROVAL_KINDS.join("、")}`);
  }
  return { approver_id: String(payload.approver_id), kinds, registered_at: at };
}

/** 翻译修订：译者提交的最小变更单元，revision_id 同时是幂等键。 */
export function createRevision(payload, at) {
  requireFields(payload, ["revision_id", "branch_id", "submitted_by"], "修订");
  const changes = (payload.changes ?? []).map((change, index) => {
    requireFields(change, ["line_id", "text"], `修订第 ${index + 1} 处`);
    return { line_id: String(change.line_id), text: String(change.text) };
  });
  if (!changes.length) throw new Error("修订缺少必要字段：changes");
  const changeKind = payload.change_kind ?? "content";
  if (!["content", "compatible"].includes(changeKind)) {
    throw new Error("change_kind 必须是 content 或 compatible");
  }
  return {
    revision_id: String(payload.revision_id),
    branch_id: String(payload.branch_id),
    base_revision: payload.base_revision ? String(payload.base_revision) : null,
    changes,
    change_kind: changeKind,
    submitted_by: String(payload.submitted_by),
    submitted_at: at,
  };
}

/** 亲历者许可：授权对象可以是整个片段或具体人物，渠道范围可限定。 */
export function createLicense(payload, at) {
  requireFields(payload, ["license_id", "grantor_id"], "亲历者许可");
  const subject = payload.subject ?? {};
  const personRefs = asStringList(subject.person_refs);
  if (!subject.fragment_id && !personRefs.length) {
    throw new Error("亲历者许可缺少授权对象：fragment_id 或 person_refs");
  }
  return {
    license_id: String(payload.license_id),
    grantor_id: String(payload.grantor_id),
    subject: {
      fragment_id: subject.fragment_id ? String(subject.fragment_id) : null,
      person_refs: personRefs,
    },
    scope: { channels: asStringList(payload.scope?.channels) },
    valid_from: payload.valid_from ? parseTime(payload.valid_from, "valid_from") : null,
    valid_until: payload.valid_until ? parseTime(payload.valid_until, "valid_until") : null,
    status: "active",
    granted_at: at,
    withdrawn_at: null,
    withdrawn_by: null,
  };
}

/** 角色版本：一次换角产生一个新版本，按生效时间作用于未来场次。 */
export function createRoleVersion(payload, at) {
  requireFields(payload, ["role_version_id", "production_id", "role", "actor_id"], "角色版本");
  return {
    role_version_id: String(payload.role_version_id),
    production_id: String(payload.production_id),
    role: String(payload.role),
    actor_id: String(payload.actor_id),
    effective_at: payload.effective_at ? parseTime(payload.effective_at, "effective_at") : at,
    cast_at: at,
  };
}

/** 场次编排。 */
export function createPerformance(payload, at) {
  requireFields(payload, ["performance_id", "production_id", "showtime"], "场次");
  return {
    performance_id: String(payload.performance_id),
    production_id: String(payload.production_id),
    showtime: parseTime(payload.showtime, "showtime"),
    channel_ids: asStringList(payload.channel_ids),
    status: "scheduled",
    scheduled_at: at,
    locked_at: null,
    cancelled_at: null,
    cancel_reason: null,
    performed_at: null,
  };
}

/** 稳定序列化：键序无关，保证相同内容得到相同哈希。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 内容哈希。 */
export function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** 修订幂等键：同一编号重复提交时比对内容，一致返回原结果，不同则拒绝。 */
export function revisionPayloadHash(revision) {
  return contentHash({
    branch_id: revision.branch_id,
    base_revision: revision.base_revision ?? null,
    change_kind: revision.change_kind ?? "content",
    submitted_by: revision.submitted_by,
    changes: [...revision.changes]
      .map((change) => ({ line_id: change.line_id, text: change.text }))
      .sort((a, b) => (a.line_id < b.line_id ? -1 : a.line_id > b.line_id ? 1 : 0)),
  });
}
