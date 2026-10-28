import * as M from "./model.mjs";
import { GitHubClient } from "./github.mjs";
import { sealToken, openVault, passwordProblem, validToken } from "./vault.mjs";

const $ = (sel, root = document) => root.querySelector(sel);
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const REMEMBER_MS = 30 * 24 * 3600 * 1000;
const SAVE_DELAY_MS = 1200;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const state = { site: { ...M.DEFAULT_SITE }, gh: null, vault: undefined, cur: null, day: null, saving: false };

/* ---------- storage helpers (browser storage may be unavailable) ---------- */
const store = {
  get(key, area = localStorage) { try { return JSON.parse(area.getItem(key)); } catch { return null; } },
  set(key, value, area = localStorage) { try { area.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  del(key, area = localStorage) { try { area.removeItem(key); } catch {} },
};
const session = (() => { try { return sessionStorage; } catch { return null; } })();

// Changes not yet committed, per day. Kept in localStorage so a tick made
// offline or before unlocking survives a reload.
const pending = {
  all: () => store.get("tt-pending") || {},
  of: (date) => pending.all()[date] || [],
  push(date, op) { const all = pending.all(); (all[date] ||= []).push(op); store.set("tt-pending", all); },
  drop(date, n) {
    const all = pending.all();
    all[date] = (all[date] || []).slice(n);
    if (!all[date].length) delete all[date];
    store.set("tt-pending", all);
  },
  count: () => Object.values(pending.all()).reduce((a, l) => a + l.length, 0),
};

/* ---------- UI primitives ---------- */
let toastTimer;
function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast " + kind), kind === "error" ? 6000 : 3000);
}
const setSync = (text) => ($("#sync").textContent = text);

function dialog(html, setup) {
  const el = $("#dialog");
  el.innerHTML = html;
  return new Promise((resolve) => {
    let done = false;
    const close = (value) => { if (done) return; done = true; el.close(); resolve(value); };
    el.onclose = () => close(false);
    setup?.(el, close);
    el.showModal();
  });
}

/* ---------- repository access ---------- */
function detectRepo(site) {
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length);
    const name = location.pathname.split("/").filter(Boolean)[0] || host;
    return owner + "/" + name;
  }
  return site.repo;
}

async function fetchStatic(path) {
  const res = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("读取 " + path + " 失败（" + res.status + "）。");
  return res.json();
}

// Unlocked: read straight from the repository, so a tick shows up at once
// instead of after the ~1 minute GitHub Pages rebuild.
async function readData(path) {
  if (state.gh?.unlocked) {
    try { return await state.gh.readJSON(path); } catch (error) {
      if (error.status === 401) lock(true);
      else throw error;
    }
  }
  return fetchStatic(path);
}

async function loadSite() {
  const site = (await fetchStatic(M.SITE_PATH).catch(() => null)) || {};
  state.site = { ...M.DEFAULT_SITE, ...site };
  const mock = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("mock");
  state.gh = new GitHubClient(detectRepo(state.site), state.site.branch || "main", fetch, mock ? location.origin + "/__mock_github" : undefined);
  document.title = state.site.title;
}

/* ---------- unlocking ---------- */
function saveToken(token, remember) {
  const record = { token, at: Date.now() };
  if (session) store.set("tt-token", record, session);
  if (remember) store.set("tt-token", { ...record, until: Date.now() + REMEMBER_MS });
}

function restoreToken() {
  const s = session ? store.get("tt-token", session) : null;
  const l = store.get("tt-token");
  const rec = s || (l && l.until > Date.now() ? l : null);
  if (l && !(l.until > Date.now())) store.del("tt-token");
  if (rec && validToken(rec.token)) state.gh.setToken(rec.token);
  updateLockButton();
}

function lock(expired = false) {
  state.gh?.setToken("");
  if (session) store.del("tt-token", session);
  store.del("tt-token");
  updateLockButton();
  if (expired) toast("授权已失效，请重新输入密码。", "error");
}

function updateLockButton() {
  const btn = $("#lockBtn");
  const on = !!state.gh?.unlocked;
  btn.textContent = on ? "已解锁" : "解锁";
  btn.classList.toggle("on", on);
  btn.title = on ? "点击锁定" : "输入密码后可以勾选";
}

async function loadVault() {
  if (state.vault !== undefined) return state.vault;
  let vault = null;
  try { vault = await state.gh.readJSON(M.VAULT_PATH, undefined, { auth: false }); }
  catch { vault = await fetchStatic(M.VAULT_PATH).catch(() => null); }
  return (state.vault = vault);
}

async function ensureUnlocked() {
  if (state.gh.unlocked) return true;
  const vault = await loadVault();
  if (!vault) {
    if (confirm("还没有设置密码。现在去做第一次设置吗？")) location.hash = "#/setup";
    return false;
  }
  const ok = await dialog(
    `<form method="dialog" id="unlockForm">
      <h2>输入密码</h2>
      <p>解锁后勾选会直接保存到 GitHub，Claude 每天早上 9 点会读到。</p>
      <label class="field"><span>密码</span><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
      <label class="check"><input type="checkbox" name="remember" checked> 在这台设备上记住 30 天</label>
      <p class="error" id="unlockErr"></p>
      <div class="actions"><button type="button" class="btn" data-cancel>取消</button><button class="btn primary" type="submit">解锁</button></div>
    </form>`,
    (el, close) => {
      $("[data-cancel]", el).onclick = () => close(false);
      $("#unlockForm", el).onsubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
        const btn = $("button[type=submit]", form);
        btn.disabled = true;
        btn.textContent = "正在解锁…";
        try {
          const token = await openVault(vault, form.pw.value, state.gh.repo);
          state.gh.setToken(token);
          saveToken(token, form.remember.checked);
          updateLockButton();
          close(true);
        } catch (error) {
          $("#unlockErr", el).textContent = error.message;
          form.pw.select();
        } finally {
          btn.disabled = false;
          btn.textContent = "解锁";
        }
      };
    },
  );
  if (ok) toast("已解锁。");
  return !!ok;
}

/* ---------- day view ---------- */
function acts(it) {
  const links = Array.isArray(it.links) ? it.links.filter((l) => l && M.safeUrl(l.url)) : [];
  let h = "";
  for (const l of links) h += `<a class="go" href="${esc(M.safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label || "打开")} ↗</a>`;
  if (it.local) h += `<button class="go${links.length ? " sub" : ""}" type="button" data-copy="${esc(M.localPath(it.local, state.site.courseDir))}">复制本地路径</button>`;
  else if (!links.length && it.howto) h += `<span class="howto"><b>怎么打开：</b>${esc(it.howto)}</span>`;
  return h ? `<div class="acts">${h}</div>` : "";
}

function shown() {
  return M.applyOps(state.day || M.normalizeDay(null, state.cur), pending.of(state.cur));
}

function renderDay() {
  const day = shown();
  const [y, m, d] = state.cur.split("-").map(Number);
  $("#md").textContent = `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
  $("#wd").textContent = WD[new Date(y, m - 1, d).getDay()];
  const today = M.todayISO();
  $("#rel").hidden = state.cur !== today;
  $("#today").disabled = state.cur === today;

  const s = M.summary(day);
  $("#count").innerHTML = `<b>${s.done}</b>/${s.total} · ${s.minsDone}/${s.mins} 分钟`;
  $("#bar").style.width = s.total ? (100 * s.done) / s.total + "%" : "0";
  $("#meter").classList.toggle("full", s.total > 0 && s.done === s.total);

  $("#note").hidden = !(day.headline || day.progress);
  $("#headline").textContent = day.headline || "";
  $("#prog").textContent = day.progress || "";
  $("#prog").hidden = !day.progress;

  const box = $("#groups");
  if (!day.items.length) {
    box.innerHTML = `<div class="empty"><b>这一天还没有任务</b>Claude 每天早上 9 点会把当天的学习任务写到这里。你也可以在下面先加一条。</div>`;
    return;
  }
  let h = "";
  for (const g of M.groups(day.items)) {
    const gd = g.items.filter((i) => i.done).length;
    h += `<section class="group"><h2>${esc(g.name)}<span>${gd}/${g.items.length}</span></h2><ul class="list">`;
    for (const it of g.items) {
      const id = esc(it.id);
      h += `<li class="item${it.done ? " done" : ""}${it.carried ? " carry" : ""}"><input type="checkbox" id="cb-${id}" data-id="${id}" ${it.done ? "checked" : ""}>`
        + `<label for="cb-${id}"><span class="t">${esc(it.text)}</span>${it.detail ? `<span class="d">${esc(it.detail)}</span>` : ""}</label>`
        + `<span class="side">${it.mins ? `<span class="mins">${Number(it.mins)}′</span>` : ""}${it.source === "me" ? `<button class="x" type="button" data-del="${id}" aria-label="删除这条">×</button>` : ""}</span>`
        + acts(it) + `</li>`;
    }
    h += `</ul></section>`;
  }
  if (s.done === s.total) h += `<p class="done-all">今天的都完成了，休息一下。</p>`;
  box.innerHTML = h;
}

function syncStatus() {
  const n = pending.count();
  if (state.saving) return setSync("正在保存到 GitHub…");
  if (!n) return setSync(state.gh?.unlocked ? "已同步 · 勾选会自动保存" : "只读查看 · 点右上角「解锁」后可以勾选");
  setSync(state.gh?.unlocked ? `有 ${n} 处改动等待保存…` : `有 ${n} 处改动只存在这台设备上，解锁后会自动提交`);
}

async function loadDay(date) {
  if (state.cur !== date) {
    state.cur = date;
    state.day = null;
    store.set("tt-last-day", date);
    renderDay();
  }
  try {
    state.day = M.normalizeDay(await readData(M.dayPath(date)), date);
  } catch (error) {
    toast(error.message, "error");
    state.day = M.normalizeDay(null, date);
  }
  if (state.cur === date) renderDay();
  syncStatus();
}

/* ---------- saving ---------- */
let saveTimer;
function change(op) {
  pending.push(state.cur, op);
  renderDay();
  syncStatus();
  if (!state.gh.unlocked) {
    ensureUnlocked().then((ok) => ok && scheduleSave(0));
    return;
  }
  scheduleSave();
}
function scheduleSave(delay = SAVE_DELAY_MS) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}

// Commits every pending day, one commit per day, each replayed on top of the
// latest version in the repository.
async function flush() {
  if (state.saving || !state.gh.unlocked) return syncStatus();
  state.saving = true;
  syncStatus();
  try {
    for (const [date, ops] of Object.entries(pending.all())) {
      let saved = null;
      await state.gh.commitLatest(async (head) => {
        const latest = M.normalizeDay(await state.gh.readJSON(M.dayPath(date), head), date);
        saved = { ...M.applyOps(latest, ops), updatedAt: new Date().toISOString() };
        return { message: M.commitMessage(date, ops), files: [{ path: M.dayPath(date), text: JSON.stringify(saved, null, 2) + "\n" }] };
      });
      pending.drop(date, ops.length);
      if (date === state.cur) state.day = saved;
    }
  } catch (error) {
    if (error.status === 401) lock(true);
    toast(error.message || "保存失败，改动还在这台设备上，稍后会重试。", "error");
    scheduleSave(15000);
  } finally {
    state.saving = false;
    renderDay();
    syncStatus();
    // Ticks made while this save was running.
    if (pending.count() && state.gh.unlocked) scheduleSave();
  }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}

/* ---------- first-time setup and settings ---------- */
function setupHtml(vault) {
  const [owner, repoName] = state.gh.repo.split("/");
  const tokenUrl = "https://github.com/settings/personal-access-tokens/new?" +
    new URLSearchParams({ name: "学习日课 " + repoName, description: "只用于学习日课勾选，只授权 " + repoName + " 仓库", target_name: owner, expires_in: "365", contents: "write" });
  return `
    <div class="sheet">
      <h1>第一次设置</h1>
      ${vault ? `<p class="banner">这个网站已经设置过密码了。重新设置会让旧密码失效。</p>` : ""}
      <p>只需要做一次。完成后，在任何设备上输入密码就能勾选，勾选会直接存进 GitHub 仓库。</p>
      <ol class="steps">
        <li><h3>在 GitHub 生成一个令牌</h3>
          <p>打开下面的链接，名称和权限已经填好。在「Repository access」里选 <b>Only select repositories</b>，再选 <b>${esc(repoName)}</b>，然后点页面底部的「Generate token」，复制生成的令牌。</p>
          <a class="btn" href="${esc(tokenUrl)}" target="_blank" rel="noopener">打开 GitHub 令牌页面</a></li>
        <li><h3>粘贴令牌，设一个密码</h3>
          <p>令牌会用你的密码加密后保存，网站和仓库里都不会出现原文。</p>
          <form id="setupForm" class="form">
            <label class="field"><span>GitHub 令牌</span><input type="password" name="token" required autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
            <label class="field"><span>设一个密码</span><input type="password" name="pw" required autocomplete="new-password" placeholder="至少 8 位，字母加数字"></label>
            <label class="field"><span>再输一次</span><input type="password" name="pw2" required autocomplete="new-password"></label>
            <p class="error" id="setupErr"></p>
            <div><button class="btn primary">完成设置</button> <a class="btn" href="#/">返回</a></div>
          </form></li>
      </ol>
      <details><summary>这样安全吗？</summary>
        <p class="small">令牌只授权这一个仓库，碰不到你的其他仓库和账号。加密后的令牌保存在公开仓库里，所以密码别太简单，也别和其他账号共用。万一泄露，到 GitHub 删除令牌，再回这里重新设置即可；每次勾选都是一次提交，都能从历史里找回。</p></details>
    </div>`;
}

async function setupView() {
  const vault = await loadVault();
  $("#view").innerHTML = setupHtml(vault);
  $("#setupForm").onsubmit = async (event) => {
    event.preventDefault();
    const f = event.target;
    const err = $("#setupErr");
    const btn = $("button", f);
    err.textContent = "";
    const token = f.token.value.trim();
    if (!validToken(token)) return (err.textContent = "令牌应该以 github_pat_ 开头，请检查是否复制完整。");
    const problem = passwordProblem(f.pw.value);
    if (problem) return (err.textContent = problem);
    if (f.pw.value !== f.pw2.value) return (err.textContent = "两次输入的密码不一样。");
    btn.disabled = true;
    btn.textContent = "正在检查令牌…";
    try {
      state.gh.setToken(token);
      await state.gh.checkAccess();
      btn.textContent = "正在加密保存…";
      const sealed = await sealToken(token, f.pw.value, state.gh.repo);
      await state.gh.commitLatest(async () => ({ message: "设置勾选密码", files: [{ path: M.VAULT_PATH, text: JSON.stringify(sealed, null, 2) + "\n" }] }));
      state.vault = sealed;
      saveToken(token, true);
      updateLockButton();
      toast("设置完成，现在可以勾选了。");
      location.hash = "#/";
      if (pending.count()) scheduleSave(0);
    } catch (error) {
      state.gh.setToken("");
      updateLockButton();
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "完成设置";
    }
  };
}

const DAY_HTML = `
  <header class="head">
    <div class="top">
      <div class="date"><span class="md" id="md">--/--</span><span class="wd" id="wd"></span><span class="rel" id="rel" hidden>今天</span></div>
      <div class="nav">
        <button class="btn" id="prev" type="button" aria-label="前一天">‹</button>
        <button class="btn" id="today" type="button">今天</button>
        <button class="btn" id="next" type="button" aria-label="后一天">›</button>
      </div>
    </div>
    <div class="stat"><div class="meter" id="meter"><i id="bar"></i></div><span class="count" id="count"><b>0</b>/0 · 0/0 分钟</span></div>
  </header>
  <section class="note" id="note" hidden><span class="who">CLAUDE · 今日说明</span><p id="headline"></p><div class="prog" id="prog"></div></section>
  <div id="groups"></div>
  <form id="add" autocomplete="off">
    <input id="addText" type="text" placeholder="自己加一条，比如：整理组会笔记" maxlength="200" aria-label="新任务">
    <select id="addMins" aria-label="预计时间"><option value="15">15 分钟</option><option value="30" selected>30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option><option value="90">90 分钟</option></select>
    <button class="btn primary" type="submit">添加</button>
  </form>`;

function dayView() {
  $("#view").innerHTML = DAY_HTML;
  $("#prev").onclick = () => loadDay(M.shift(state.cur, -1));
  $("#next").onclick = () => loadDay(M.shift(state.cur, 1));
  $("#today").onclick = () => loadDay(M.todayISO());
  $("#groups").addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.matches('input[type="checkbox"]')) change({ type: "toggle", id: cb.dataset.id, done: cb.checked, at: new Date().toISOString() });
  });
  $("#groups").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) {
      const ok = await copyText(c.dataset.copy);
      toast(ok ? "路径已复制：在 Finder 按 ⌘⇧G，粘贴后回车" : "没能自动复制，请手动打开：" + c.dataset.copy);
      return;
    }
    const b = e.target.closest("[data-del]");
    if (b) change({ type: "remove", id: b.dataset.del });
  });
  $("#add").onsubmit = (e) => {
    e.preventDefault();
    const text = $("#addText").value.trim();
    if (!text) return;
    $("#addText").value = "";
    change({ type: "add", item: M.newItem(text, $("#addMins").value) });
  };
  const last = store.get("tt-last-day");
  loadDay(state.cur || (M.validDate(last) ? last : M.todayISO()));
}

function route() {
  if (location.hash === "#/setup") return setupView();
  dayView();
}

/* ---------- boot ---------- */
async function boot() {
  $("#lockBtn").onclick = async () => {
    if (state.gh.unlocked) {
      if (confirm("锁定后需要重新输入密码才能勾选。确定锁定吗？")) { lock(); toast("已锁定。"); syncStatus(); }
    } else if (await ensureUnlocked()) {
      if (state.cur) await loadDay(state.cur);
      if (pending.count()) scheduleSave(0);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.cur && location.hash !== "#/setup") loadDay(state.cur);
  });
  addEventListener("online", () => pending.count() && scheduleSave(0));
  try {
    await loadSite();
    restoreToken();
  } catch (error) {
    toast(error.message, "error");
  }
  addEventListener("hashchange", route);
  route();
  if (pending.count() && state.gh?.unlocked) scheduleSave(0);
}

boot();
