import { describe, expect, test } from "bun:test";

import { MEMBENCH_VERSION } from "../src/index";

describe("clean repository shell", () => {
  test("publishes the intended development version", () => {
    expect(MEMBENCH_VERSION).toBe("0.2.0");
  });
});

