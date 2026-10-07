/**
 * 追加式事件仓库：
 * - 默认纯进程内（不传 file）；
 * - 传入文件路径后使用 JSONL 持久化，每行一个不可变事件；
 * - 进程崩溃可能留下最后一行半截写入，加载时截断到最后一条完整事件后继续，
 *   未完成的发布任务由服务层按任务状态续跑，已确认事件不丢失。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { replay, applyEvent } from "./domain.js";

export class Repository {
  constructor({ file, clock } = {}) {
    this.file = file ?? null;
    this.clock = clock ?? null;
    this.events = [];
    if (this.file) this.#load();
    this.state = replay(this.events);
  }

  #load() {
    if (!existsSync(this.file)) {
      this.events = [];
      return;
    }
    const raw = readFileSync(this.file, "utf8");
    const lines = raw.split("\n");
    const events = [];
    let validBytes = 0;
    let scannedBytes = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      scannedBytes += line.length + 1;
      if (!line.trim()) {
        validBytes = scannedBytes;
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.seq !== "number" || typeof event.type !== "string") {
          throw new Error("事件结构不完整");
        }
        events.push(event);
        validBytes = scannedBytes;
      } catch (err) {
        // 末行损坏（进程中断）：保留此前完整事件，丢弃半截行；中间行损坏则视为日志破坏。
        if (i < lines.length - 1) throw new Error(`事件日志第 ${i + 1} 行损坏：${err.message}`);
        break;
      }
    }
    if (validBytes < raw.length) writeFileSync(this.file, raw.slice(0, validBytes), "utf8");
    const seqs = new Set();
    for (const event of events) {
      if (seqs.has(event.seq)) throw new Error(`事件序号重复：${event.seq}`);
      seqs.add(event.seq);
    }
    events.sort((a, b) => a.seq - b.seq);
    this.events = events;
  }

  /** 追加一条不可变事件并增量更新投影。 */
  append(type, payload = {}) {
    const seq = this.events.length ? Math.max(...this.events.map((e) => e.seq)) + 1 : 1;
    const event = Object.freeze({
      seq,
      type,
      at: this.clock ? this.clock.now() : new Date().toISOString(),
      ...payload,
    });
    if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    this.events.push(event);
    applyEvent(this.state, event);
    return event;
  }

  allEvents() {
    return [...this.events];
  }
}
