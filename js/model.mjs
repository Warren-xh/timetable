// Pure data helpers for the daily checklist. No DOM, no network, so they can
// be unit-tested with `node --test`.

export const SITE_PATH = "data/site.json";
export const VAULT_PATH = "data/vault.json";
export const DAY_DIR = "data/days/";

export const DEFAULT_SITE = {
  title: "学习日课",
  repo: "Warren-xh/timetable",
  branch: "main",
  courseDir: "~/Desktop/2026/斯坦福 agent 课",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (s) => typeof s === "string" && DATE.test(s);

export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayISO = () => ymd(new Date());
export function shift(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
export const dayPath = (iso) => DAY_DIR + iso + ".json";

export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || raw.id == null || !raw.text) return null;
  return { ...raw, id: String(raw.id), text: String(raw.text), done: !!raw.done, mins: Number(raw.mins) || 0 };
}

export function normalizeDay(raw, date) {
  const day = raw && typeof raw === "object" ? { ...raw } : {};
  day.date = date || day.date;
  day.items = Array.isArray(day.items) ? day.items.map(normalizeItem).filter(Boolean) : [];
  return day;
}

// A change the viewer made, replayed on top of the latest copy in the
// repository at save time, so a tick never overwrites what the 9 a.m. task
// wrote in the meantime (and vice versa).
//   { type: "toggle", id, done, at }
//   { type: "add", item }
//   { type: "remove", id }
export function applyOps(day, ops) {
  let items = day.items.map((i) => ({ ...i }));
  for (const op of ops || []) {
    if (op.type === "toggle") {
      items = items.map((i) => (i.id === op.id ? { ...i, done: !!op.done, doneAt: op.done ? op.at || null : null } : i));
    } else if (op.type === "add" && op.item && !items.some((i) => i.id === op.item.id)) {
      items.push({ ...op.item });
    } else if (op.type === "remove") {
      // Only the viewer's own items can be removed from the page.
      items = items.filter((i) => !(i.id === op.id && i.source === "me"));
    }
  }
  return { ...day, items };
}

export function summary(day) {
  const items = day?.items || [];
  const done = items.filter((i) => i.done);
  const sum = (list) => list.reduce((a, i) => a + (Number(i.mins) || 0), 0);
  return { total: items.length, done: done.length, mins: sum(items), minsDone: sum(done) };
}

export function groups(items) {
  const order = [];
  const by = {};
  for (const it of items) {
    const g = it.group || "其他";
    if (!by[g]) { by[g] = []; order.push(g); }
    by[g].push(it);
  }
  return order.map((name) => ({ name, items: by[name] }));
}

export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

// "讲次/L01*/*L01_课件*" → "<courseDir>/讲次": stop at the first wildcard
// segment, since a pasted path in Finder cannot contain globs.
export function localPath(local, courseDir) {
  const kept = [];
  for (const part of String(local || "").split("/").filter(Boolean)) {
    if (/[*?]/.test(part)) break;
    kept.push(part);
  }
  return [courseDir, ...kept].join("/");
}

export function newItem(text, mins, now = Date.now()) {
  return { id: "me-" + now.toString(36), text: String(text).trim().slice(0, 200), group: "自己加的", mins: Number(mins) || 0, done: false, source: "me" };
}

export function commitMessage(date, ops) {
  const n = ops.length;
  const kinds = new Set(ops.map((o) => o.type));
  const what = kinds.size === 1 && kinds.has("toggle") ? "勾选" : "更新";
  return `${what} ${date}（${n} 处）`;
}
