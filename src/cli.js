/**
 * 命令行入口：
 *   node src/cli.js health
 *   node src/cli.js validate <scenario.json>   # 跑完整场景（含可控时钟、发布、溯源），打印结果
 *   node src/cli.js run <eventlog.jsonl> [--at ISO]   # 推进时钟并续跑到期发布任务
 *   node src/cli.js trace <eventlog.jsonl> <segment_id> [--performance <id>]
 *   node src/cli.js events <eventlog.jsonl>
 *
 * 场景文件是一个动作数组，每个动作 { "op": "方法名", "args": {...}, "at": "ISO?" }，
 * at 用来显式设置可控时钟；runDueJobs 通过 args.now 指定处理时刻。
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Service, ControlledClock } from "./service.js";
import { Repository } from "./repository.js";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function makeService(file) {
  const clock = new ControlledClock("2026-01-01T00:00:00.000Z");
  const repository = new Repository(file ? { file, clock } : { clock });
  return new Service(repository, { clock });
}

/** 按场景动作数组驱动服务；返回每步结果，便于离线验证与冒烟。 */
export async function runScenario(service, actions) {
  const trace = [];
  for (const [index, action] of actions.entries()) {
    if (action.at) service.clock.set(action.at);
    const op = action.op;
    const method = service[op];
    if (typeof method !== "function") throw new Error(`场景第 ${index + 1} 步引用了未知操作：${op}`);
    const result = await method.call(service, action.args ?? {});
    trace.push({ step: index + 1, op, at: service.clock.now(), result });
  }
  return trace;
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "health") {
    console.log(JSON.stringify(makeService().health(), null, 2));
    return;
  }

  if (command === "validate") {
    const scenarioPath = rest[0];
    if (!scenarioPath) throw new Error("用法：validate <scenario.json>");
    const scenario = await loadJson(scenarioPath);
    const service = makeService(scenario.eventlog ?? null);
    const steps = await runScenario(service, scenario.actions ?? []);
    const summary = {
      scenario: scenario.name ?? scenarioPath,
      steps: steps.length,
      events: service.allEvents().length,
      releases: [...service.allEvents()]
        .filter((e) => e.type === "release_package_built")
        .map((e) => ({ release_id: e.release_id, performance_id: e.performance_id, package_hash: e.package_hash })),
      trace: scenario.trace_segment
        ? service.trace(scenario.trace_segment, scenario.trace_performance ? { performanceId: scenario.trace_performance } : {})
        : null,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "run") {
    const [file, ...flags] = rest;
    const at = flagValue(flags, "--at");
    const service = makeService(file);
    if (at) service.clock.set(new Date(at).toISOString());
    const results = await service.runDueJobs(at ? { now: new Date(at).toISOString() } : {});
    console.log(JSON.stringify({ now: service.clock.now(), processed: results }, null, 2));
    return;
  }

  if (command === "trace") {
    const [file, segmentId, ...flags] = rest;
    const performanceId = flagValue(flags, "--performance");
    const service = makeService(file);
    console.log(JSON.stringify(service.trace(segmentId, performanceId ? { performanceId } : {}), null, 2));
    return;
  }

  if (command === "events") {
    const service = makeService(rest[0]);
    console.log(JSON.stringify(service.allEvents(), null, 2));
    return;
  }

  throw new Error(`未知命令：${command}`);
}

function flagValue(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : null;
}

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  });
}
