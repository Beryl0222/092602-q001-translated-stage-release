/** 进程内仓库：事件溯源 + 可选 JSONL 日志持久化。
 *  所有领域变化先落成事件再应用，事件只增不改，
 *  因此已发生的演出与发布记录不会被抹去，进程中断后可重放恢复。 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { manuscriptKey } from "./domain.js";

function emptyState() {
  return {
    records: new Map(),
    fragments: new Map(),
    manuscripts: new Map(),
    branches: new Map(),
    productions: new Map(),
    channels: new Map(),
    notes: new Map(),
    approvers: new Map(),
    revisions: new Map(),
    deliberations: new Map(),
    licenses: new Map(),
    roles: new Map(),
    performances: new Map(),
    packages: new Map(),
    jobs: new Map(),
  };
}

export class Repository {
  #events = [];
  #seq = 0;
  #journalPath = null;

  constructor({ journalPath = null } = {}) {
    this.state = emptyState();
    this.#journalPath = journalPath;
    if (journalPath && existsSync(journalPath)) {
      for (const line of readFileSync(journalPath, "utf8").split("\n")) {
        if (line.trim()) this.#replay(JSON.parse(line));
      }
    }
  }

  /** 既有基础能力：登记不可重复记录。 */
  add(record) {
    if (this.state.records.has(record.record_id)) throw new Error("记录编号已存在");
    this.state.records.set(record.record_id, record);
    return record;
  }

  get(recordId) {
    return this.state.records.get(recordId) ?? null;
  }

  get events() {
    return this.#events.slice();
  }

  /** 追加一个领域事件：应用进状态、记入日志。 */
  dispatch(type, data) {
    const event = { seq: this.#seq + 1, type, data: structuredClone(data) };
    this.#apply(event);
    this.#events.push(event);
    this.#seq = event.seq;
    if (this.#journalPath) {
      mkdirSync(dirname(this.#journalPath), { recursive: true });
      appendFileSync(this.#journalPath, `${JSON.stringify(event)}\n`);
    }
    return event;
  }

  #replay(event) {
    this.#apply(event);
    this.#events.push(event);
    this.#seq = Math.max(this.#seq, Number(event.seq) || 0);
  }

  #apply(event) {
    const s = this.state;
    const d = event.data;
    switch (event.type) {
      case "FragmentRegistered": s.fragments.set(d.fragment_id, d); break;
      case "ManuscriptRegistered": s.manuscripts.set(manuscriptKey(d.manuscript_id, d.version), d); break;
      case "BranchOpened":
        s.branches.set(d.branch_id, {
          ...d,
          head_lines: { ...d.base_lines },
          line_heads: {},
          line_sources: {},
        });
        break;
      case "ProductionRegistered": s.productions.set(d.production_id, d); break;
      case "ChannelRegistered": s.channels.set(d.channel_id, d); break;
      case "NoteAdded": s.notes.set(d.note_id, d); break;
      case "ApproverRegistered": s.approvers.set(d.approver_id, d); break;
      case "RevisionSubmitted": s.revisions.set(d.revision_id, d); break;
      case "RevisionStatusChanged": {
        const revision = s.revisions.get(d.revision_id);
        if (revision) revision.status = d.status;
        break;
      }
      case "ApprovalRecorded": {
        const revision = s.revisions.get(d.revision_id);
        if (revision) revision.approvals.push(d.approval);
        break;
      }
      case "RevisionApplied": {
        const revision = s.revisions.get(d.revision_id);
        if (!revision) break;
        revision.status = "applied";
        revision.applied_at = d.at;
        const branch = s.branches.get(revision.branch_id);
        if (branch) {
          for (const update of d.line_updates) {
            branch.head_lines[update.line_id] = update.text;
            branch.line_heads[update.line_id] = revision.revision_id;
            branch.line_sources[update.line_id] = { revision_id: revision.revision_id, at: d.at };
          }
        }
        break;
      }
      case "DeliberationOpened": s.deliberations.set(d.deliberation_id, d); break;
      case "DeliberationResolved": {
        const deliberation = s.deliberations.get(d.deliberation_id);
        if (deliberation) {
          deliberation.status = "resolved";
          deliberation.resolution = d.resolution;
          deliberation.resolved_at = d.at;
        }
        break;
      }
      case "LicenseGranted": s.licenses.set(d.license_id, d); break;
      case "LicenseWithdrawn": {
        const license = s.licenses.get(d.license_id);
        if (license) {
          license.status = "withdrawn";
          license.withdrawn_at = d.at;
          license.withdrawn_by = d.by;
        }
        break;
      }
      case "RoleCast": s.roles.set(d.role_version_id, d); break;
      case "PerformanceScheduled": s.performances.set(d.performance_id, d); break;
      case "PerformanceLocked": {
        const performance = s.performances.get(d.performance_id);
        if (performance) {
          performance.status = "locked";
          performance.locked_at = d.at;
        }
        break;
      }
      case "PerformanceCancelled": {
        const performance = s.performances.get(d.performance_id);
        if (performance) {
          performance.status = "cancelled";
          performance.cancelled_at = d.at;
          performance.cancel_reason = d.reason ?? null;
        }
        break;
      }
      case "PerformancePerformed": {
        const performance = s.performances.get(d.performance_id);
        if (performance) {
          performance.status = "performed";
          performance.performed_at = d.at;
        }
        break;
      }
      case "PackageGenerated": s.packages.set(d.package_id, d); break;
      case "PackageStatusChanged": {
        const pkg = s.packages.get(d.package_id);
        if (pkg) {
          pkg.status = d.status;
          pkg.status_reason = d.reason ?? null;
        }
        break;
      }
      case "JobEnqueued": s.jobs.set(d.job_id, d); break;
      case "JobStatusChanged": {
        const job = s.jobs.get(d.job_id);
        if (job) {
          job.status = d.status;
          job.error = d.error ?? null;
          job.finished_at = d.at ?? null;
        }
        break;
      }
      default: break;
    }
  }
}
