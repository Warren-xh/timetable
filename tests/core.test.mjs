import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as M from "../js/model.mjs";

const day = () => M.normalizeDay({
  headline: "h",
  items: [
    { id: "a", text: "A", mins: 30, group: "CS329Z", source: "claude" },
    { id: "b", text: "B", mins: 15, group: "ISCRAM 投稿", source: "claude", done: true },
    { id: "me-1", text: "mine", mins: 15, group: "自己加的", source: "me" },
  ],
}, "2026-10-28");

test("shift crosses month and year boundaries", () => {
  assert.equal(M.shift("2026-10-31", 1), "2026-11-01");
  assert.equal(M.shift("2027-01-01", -1), "2026-12-31");
});

test("toggle replays onto a newer copy without losing its other changes", () => {
  const ops = [{ type: "toggle", id: "a", done: true, at: "t1" }];
  const newer = day();
  newer.headline = "rewritten by the 9 a.m. task";
  newer.items.push({ id: "c", text: "C", mins: 10, done: false });
  const out = M.applyOps(newer, ops);
  assert.equal(out.headline, "rewritten by the 9 a.m. task");
  assert.equal(out.items.find((i) => i.id === "a").done, true);
  assert.equal(out.items.find((i) => i.id === "a").doneAt, "t1");
  assert.equal(out.items.length, 4);
});

test("untick clears doneAt; unknown ids are ignored", () => {
  const out = M.applyOps(day(), [{ type: "toggle", id: "b", done: false }, { type: "toggle", id: "zz", done: true }]);
  assert.equal(out.items.find((i) => i.id === "b").done, false);
  assert.equal(out.items.find((i) => i.id === "b").doneAt, null);
});

test("only the viewer's own items can be removed; add is idempotent", () => {
  const item = M.newItem("  extra  ", "45", 1);
  let out = M.applyOps(day(), [{ type: "remove", id: "a" }, { type: "remove", id: "me-1" }, { type: "add", item }, { type: "add", item }]);
  assert.deepEqual(out.items.map((i) => i.id), ["a", "b", item.id]);
  assert.equal(out.items[2].text, "extra");
  assert.equal(out.items[2].mins, 45);
});

test("summary counts items and minutes", () => {
  assert.deepEqual(M.summary(day()), { total: 3, done: 1, mins: 60, minsDone: 15 });
});

test("groups keep first-seen order", () => {
  assert.deepEqual(M.groups(day().items).map((g) => g.name), ["CS329Z", "ISCRAM 投稿", "自己加的"]);
});

test("localPath stops at the first wildcard segment", () => {
  assert.equal(M.localPath("讲次/L01*/*L01_课件*", "~/D"), "~/D/讲次");
  assert.equal(M.localPath("代码/assignment1-harness", "~/D"), "~/D/代码/assignment1-harness");
});

test("safeUrl only allows http(s)", () => {
  assert.equal(M.safeUrl("javascript:alert(1)"), null);
  assert.equal(M.safeUrl("https://x.y"), "https://x.y");
});

test("every stored day file is valid and named by its date", async () => {
  const dir = new URL("../data/days/", import.meta.url);
  for (const name of await readdir(dir)) {
    const raw = JSON.parse(await readFile(new URL(name, dir), "utf8"));
    assert.equal(raw.date + ".json", name);
    const d = M.normalizeDay(raw, raw.date);
    assert.equal(d.items.length, raw.items.length, name);
    assert.equal(new Set(d.items.map((i) => i.id)).size, d.items.length, name + " has duplicate ids");
  }
});
