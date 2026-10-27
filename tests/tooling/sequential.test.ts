import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { runSequential } from "../../script/sequential.ts";

describe("ordered registry stages", () => {
  it("waits for each stage before starting the next", async () => {
    const events: string[] = [];
    await runSequential(["cjs", "esm"], async (format) => {
      events.push(`start ${format}`);
      await Promise.resolve();
      events.push(`end ${format}`);
    });
    assert.deepEqual(events, ["start cjs", "end cjs", "start esm", "end esm"]);
  });

  it("does not launch later stages after a failure", async () => {
    const started: string[] = [];
    await assert.rejects(
      runSequential(["cjs", "esm"], async (format) => {
        started.push(format);
        await Promise.resolve();
        throw new Error("consumer failed");
      }),
      /consumer failed/,
    );
    assert.deepEqual(started, ["cjs"]);
  });
});
