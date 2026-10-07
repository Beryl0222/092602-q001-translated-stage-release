/** 可控时钟：发布包生成、锁定与冻结判断都以它为准，测试可手动推进。 */
export class SystemClock {
  now() {
    return new Date();
  }
}

export class ManualClock {
  #current;

  constructor(start = "2026-01-01T00:00:00.000Z") {
    this.#current = new Date(start);
    if (Number.isNaN(this.#current.getTime())) throw new Error("时钟起点必须是有效时间");
  }

  now() {
    return new Date(this.#current);
  }

  set(isoTime) {
    const next = new Date(isoTime);
    if (Number.isNaN(next.getTime())) throw new Error("时钟时间必须是有效时间");
    this.#current = next;
  }

  advance(ms) {
    this.#current = new Date(this.#current.getTime() + Number(ms));
  }
}
