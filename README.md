# 国际剧目译演发布

闽宁镇戏剧村落把英文版从一次首演扩展为常态化国际演出。本服务把故事片段、中文原稿、
翻译分支、文化说明、亲历者许可、角色版本、场次编排和发布渠道组织成一条可追溯的
追加式事件链，供字幕、口述史授权、演员排班、舞台改词等不同岗位在同一事实来源上协作。

## 核心规则

- **可追溯关系**：`story → source → segment → proposal → version → performance → release`，
  许可 `permit` 与复核 `review` 挂在具体片段和译稿上，渠道 `channel` 挂在场次上。
- **并行译稿**：多位译者可就同一句并行提交分支；同片段+同译者+相同英文与文化说明的
  重复提交**幂等返回原结果**；不同英文文本的在审/已批准译稿构成**内容冲突，自动进入合议**。
- **授权复核**：改动类别含 `historical`（史实）或 `identity`（人物身份）时，必须由覆盖
  该句、且许可仍有效的**亲历者本人**复核通过；多亲历者片段需每人分别复核。
- **锁定场次**：`locked` 后只接收 `wording` 措辞类兼容修订，且只能改本场当前演员表中的
  版本；同一修订幂等，异文冲突进入改词合议。史实/身份改动必须走新译稿，不能借改词混入。
- **冻结而不抹去**：演出取消、临时换角、许可撤回都只追加冻结事件，影响**未来使用范围**；
  已演出场次（`performed`）与当时生成的发布包永久保留，冻结影响标注为
  `performed_immutable`，不能取消、不能撤回、不能物理删除。
- **发布包**：按**可控时钟**在开演前窗口为每个场次生成唯一发布包（内容哈希标识），
  逐句给出原稿、采用译稿、许可状态、兼容修订与冻结原因；任务中断后重启自动续跑，
  已完成任务与重复安排均幂等。
- **逐句溯源**：`Service.trace(segment_id)` 说明某句字幕采用了哪版原稿、谁在何时依据
  哪份许可批准、在哪些场次生效，以及撤回/换角/取消后受到的影响。

## 目录

- `src/domain.js`：事件回放投影、复核门槛、兼容修订判定、冻结影响计算、发布包组装与溯源（纯函数）。
- `src/repository.js`：追加式仓库；可选 JSONL 文件持久化，崩溃半截尾行加载时安全截断。
- `src/service.js`：应用服务与可控时钟 `ControlledClock`，全部用例的入口。
- `src/cli.js`：场景回放、发布续跑、逐句溯源命令。
- `contracts/record.json`：服务契约与规则清单。
- `data/sample.json`：《干沙滩》完整场景（并行译稿、合议、双类复核、锁定改词、
  幂等提交、换角、撤回、两场发布包）。
- `tests/baseline.test.js`：覆盖全部规则的 28 项测试。

项目只使用 Node.js 内置模块。

## 运行

```bash
npm test           # 全部规则测试
npm run build      # 源码语法检查
npm run check:sample   # 回放完整样例并打印两场发布包概要与 seg-001 逐句溯源
```

命令行：

```bash
node src/cli.js health
node src/cli.js validate data/sample.json
node src/cli.js run <eventlog.jsonl> --at 2026-10-01T18:30:00Z   # 续跑到期发布任务
node src/cli.js trace <eventlog.jsonl> seg-001 --performance perf-20261001
node src/cli.js events <eventlog.jsonl>
```

场景文件是动作数组：`{ "op": "服务方法名", "args": {...}, "at": "ISO8601?" }`，
`at` 显式推进可控时钟。程序化使用：

```js
import { Service, ControlledClock } from "./src/service.js";
import { Repository } from "./src/repository.js";

const clock = new ControlledClock("2026-09-01T00:00:00Z");
const service = new Service(new Repository({ file: "events.jsonl", clock }), { clock });
// ...登记故事/原稿/片段、授予许可、提交译稿、复核、建版本、排期、锁定、发布...
await service.runDueJobs({ now: "2026-10-01T18:30:00Z" });
service.trace("seg-001", { performanceId: "perf-20261001" });
```
