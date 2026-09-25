/** 国际剧目译演发布的应用服务入口。 */
import { createRecord } from "./domain.js";
import { Repository } from "./repository.js";

export class Service {
  constructor(repository = new Repository()) { this.repository = repository; }
  health() { return { service: "translated_stage_release", status: "ok" }; }
  register(payload) { return this.repository.add(createRecord(payload)); }
  find(recordId) { return this.repository.get(String(recordId)); }
}
