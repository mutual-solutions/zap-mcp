#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mutual Solutions, Inc.
//
// zap-mcp: MCP server (stdio) for Zap!, the hosted KiCad auto-router at https://zap.mutual.solutions.
// Node 18 or newer. The tools, names, arguments and answers follow zap_mcp.py
// (https://zap.mutual.solutions/downloads/zap_mcp.py), plus try_route_board: the keyless trial.
//
// API key: environment variable ZAP_API_KEY, or the file named by ZAP_API_KEY_FILE, or ~/.config/zap/key. It is never
// taken from tool arguments and never written to output or logs.
// ZAP_URL (default https://zap.mutual.solutions) must be https; redirects are never followed, so the key only goes there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const VERSION = createRequire(import.meta.url)("../package.json").version;
const URL_BASE = (process.env.ZAP_URL || "https://zap.mutual.solutions").replace(/\/+$/, "");
const SITE = "https://zap.mutual.solutions";
const CONTACT = "hello@mutual.solutions";
const KEY_WARNING = []; // set once when the key file is readable by other users; shown with every tool result
const TRY_TOKENS = new Map(); // trial job id -> token (the token is given once, only in the answer to the upload)

const REVIEW = "Review the routed board and run KiCad's DRC (Inspect > Design Rules Checker) before ordering boards.";
const FEEDBACK_RULE = ("Whenever the user gives an opinion about Zap! or a routing result (something they liked, a problem, a " +
  "wish), ask once whether they would like to send it to the Zap! team. When you ask, say in one short " +
  "sentence what happens, without overstating or understating it, for example: \"Send this to the Zap! " +
  "team? Only this text (and the picture, if any) is used to improve Zap!, never your board file, and you " +
  "can ask them to delete it.\" Show the exact text you would " +
  "send (their words, or a summary they approve) and the job id. Call send_feedback only if they say " +
  "yes; if they say no, do not ask again in this session. Never include board files or private details " +
  "they did not approve." + " When the feedback is about a spot on the board, offer to attach a picture of just that area (board_snapshot), aimed with the report's issue positions; show the picture to the user before sending and attach it only if they say yes; if they do not want it, delete it (delete_snapshot). Never the whole board.");
const GET_KEY = `To get a key, sign in at ${SITE}/auth/login and create an API key on your account page (save it as ~/zap-key.txt ` +
  "with chmod 600 and set ZAP_API_KEY_FILE to that path in this MCP server's environment). Without a key you can try " +
  "Zap! now: try_route_board routes one small board with no sign-up (at most 300 pads, 2 or 4 copper layers, " +
  `2 trial jobs per network address per UTC day). Questions: ${CONTACT}.`;

class ZapError extends Error {
  constructor(status, body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const where = (b.footprints || []).slice(0, 50).map((f) => {
      const p = f.at_mm || [null, null];
      return `${f.ref} at x ${p[0]}, y ${p[1]} mm`;
    }).join("; ");
    let msg = `${b.message || "HTTP " + status} (${b.error ?? status})${where ? "\nFootprints: " + where : ""}`;
    if (b.error === "unauthorized" || b.error === "no_key") msg += "\n" + GET_KEY;
    super(msg);
    this.status = status;
    this.body = b;
  }
}

const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function loadKey() {
  const k = (process.env.ZAP_API_KEY || "").trim();
  if (k) return k;
  const p = expand(process.env.ZAP_API_KEY_FILE || "~/.config/zap/key");
  try {
    const st = fs.statSync(p);
    if (process.platform !== "win32" && (st.mode & 0o077) && !KEY_WARNING.length) {
      KEY_WARNING.push(`Warning: the Zap! key file ${p} is readable by other users; run: chmod 600 ${p}`);
      process.stderr.write("zap-mcp: " + KEY_WARNING[0] + "\n");
    }
    const key = fs.readFileSync(p, "utf8").trim().split(/\s+/)[0];
    if (key) return key;
  } catch { /* fall through */ }
  throw new ZapError(0, { error: "no_key", message: "No API key: set ZAP_API_KEY_FILE to the key file in the MCP " +
    "server's environment (or ZAP_API_KEY, or save it in ~/.config/zap/key)" });
}

function hasKey() {
  try { loadKey(); return true; } catch { return false; }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** One API request with the documented retry rules: 429 -> wait Retry-After; edge 502/503/504 or a network error
 *  -> retry GETs with backoff (a POST is never repeated automatically: it could create a second job). */
async function call(method, p, { body, ctype, raw = false, auth = true, headers: extra = {} } = {}) {
  if (!URL_BASE.toLowerCase().startsWith("https://"))
    throw new ZapError(0, { error: "bad_url", message: "ZAP_URL must be an https:// address (the key is never sent over plain http)" });
  const headers = { "User-Agent": `zap-mcp/${VERSION} (node)`, ...extra };
  if (auth) headers.Authorization = "Bearer " + loadKey();
  if (ctype) headers["Content-Type"] = ctype;
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try {
      // a pre-flight check may wait 60 s for a slot and run 300 s
      r = await fetch(URL_BASE + p, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(400_000) });
    } catch (e) {
      if (method === "GET" && attempt < 5) { await sleep(3 + 3 * attempt); continue; }
      throw new ZapError(0, { error: "network", message: `Could not reach ${URL_BASE}: ${e.cause?.message || e.message}` });
    }
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (raw) return buf;
      return buf.length ? JSON.parse(buf.toString("utf8")) : {};
    }
    let b = {};
    try { b = JSON.parse(await r.text()); } catch { b = {}; }
    if (r.status >= 300 && r.status < 400 || r.type === "opaqueredirect")
      throw new ZapError(r.status, { error: "redirect", message: `${URL_BASE} answered with a redirect (HTTP ${r.status}), which is not ` +
        "followed so the key stays with Zap!: check ZAP_URL" });
    const after = (d) => Math.min(60, parseInt(r.headers.get("retry-after") || d, 10) || Number(d));
    if (r.status === 429 && b.error === "rate_limited" && attempt < 5) { await sleep(after("5")); continue; }
    if (r.status === 503 && b.error === "check_busy" && attempt < 5) { await sleep(after("30")); continue; }
    if ([502, 503, 504].includes(r.status) && !Object.keys(b).length && method === "GET" && attempt < 5) { await sleep(10 + 10 * attempt); continue; }
    throw new ZapError(r.status, b);
  }
}

function readFile(p, what) {
  const full = expand(p);
  try {
    return [path.basename(full), fs.readFileSync(full)];
  } catch (e) {
    throw new ZapError(0, { error: "local_file", message: `Cannot read the ${what} ${full}: ${e.code === "ENOENT" ? "No such file or directory" : e.message}` });
  }
}

/** Multipart body from tool arguments; .kicad_pro / .kicad_dru next to the board are used when not given. */
function upload(a, { trial = false } = {}) {
  const board = a.board_path || "";
  if (!board.endsWith(".kicad_pcb")) throw new ZapError(0, { error: "local_file", message: "board_path must be a .kicad_pcb file" });
  const base = expand(board).slice(0, -".kicad_pcb".length);
  const [name, data] = readFile(board, "board");
  const form = new FormData();
  const sent = [];
  const file = (field, fname, bytes) => { form.append(field, new Blob([bytes], { type: "application/octet-stream" }), fname.replace(/"/g, "")); sent.push(field); };
  const text = (field, v) => form.append(field, String(v));
  // the board goes gzip-compressed (the service unpacks it; large boards then fit the 20 MiB upload limit)
  file("board", name + ".gz", zlib.gzipSync(data, { level: 6 }));
  const pro = a.project_path || (fs.existsSync(base + ".kicad_pro") ? base + ".kicad_pro" : null);
  const dru = a.rules_path || (fs.existsSync(base + ".kicad_dru") ? base + ".kicad_dru" : null);
  if (pro) file("project", ...readFile(pro, "project"));
  if (dru) file("rules", ...readFile(dru, "rules"));
  if (a.currents_path) file("currents", ...readFile(a.currents_path, "currents file"));
  else if (a.currents) { text("currents", JSON.stringify(a.currents)); sent.push("currents"); }
  if (a.router && !trial) text("router", a.router);
  if (a.consent_training === true) text("consent_training", "true");
  if (a.keep_existing === true) text("keep_existing", "true");
  if (a.strip_existing === true) text("strip_existing", "true");
  for (const k of Object.keys(OPTION_FIELDS)) if (a[k] !== undefined && a[k] !== null) text(k, a[k]);
  if (a.fab_floor) text("fab_floor", a.fab_floor);
  return { form, sent };
}

/** The numbers to show a human, all 'lower is better'. */
function summarize(st) {
  if (!st || typeof st !== "object") return {};
  const m = st.metrics || {}, f = m.fab || {}, th = f.thermal || {};
  const out = { job_id: st.id, status: st.status, router: (st.version || {}).router, report_url: st.report_url,
    fab_floor: st.fab_floor, unconnected: m.unconnected, critical_unconnected: m.critical_unconnected,
    drc_errors: m.drc_errors, server_time_s: m.wall_time_s };
  if (f.computed) {
    Object.assign(out, { shorts: f.shorts, shorts_already_in_board: f.shorts_already_in_board, jlc_violations: f.jlc_violations,
      jlc_violations_by_type: f.jlc_violations_by_type, jlc_items_first_10: (f.jlc_items || []).slice(0, 10),
      jlc_items_truncated: f.jlc_items_truncated });
    if (th.computed)
      Object.assign(out, { hottest_rise_c: th.off_chart ? "off the chart" : th.worst_rise_c, rise_limit_c: th.limit_c,
        sections_over_limit: th.sections_over_limit, nets_over_limit: th.nets_over_limit, currents: th.currents });
  }
  if (m.existing_copper) out.existing_copper = m.existing_copper; // keep_existing jobs: counts, not findings; *_removed must be 0
  if (m.time_budget) out.time_budget = m.time_budget.summary || m.time_budget;
  if (st.status === "failed") out.error = st.error;
  // like json.dumps in zap_mcp.py: absent values are shown as null
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  return out;
}

/** 'Copper pours: yours replaced: +12V on F.Cu; Zap! made: GND on B.Cu' from the report's pours, or null. */
function poursLine(p) {
  if (!p || typeof p !== "object" || !((p.replaced || []).length || (p.made || []).length)) return null;
  const t = (xs) => xs.map((x) => `${x.net || "no net"} on ${(x.layers || []).join(", ") || "?"}`).join("; ") || "none";
  return `Copper pours: yours replaced: ${t(p.replaced || [])}. Zap! made: ${t(p.made || [])}.`;
}

const j = (x) => JSON.stringify(x, null, 1);

async function toolCheckBoard(a) {
  const { form, sent } = upload(a);
  const r = await call("POST", "/v1/check", { body: form });
  let text = r.summary || "";
  for (const kind of ["blockers", "warnings"])
    for (const f of r[kind] || []) text += `\n${kind === "blockers" ? "PROBLEM" : "warning"} ${f.code}: ${f.message}`;
  return [r, text + `\n(files sent: ${sent.join(", ")}; the check used no job quota)`];
}

/** Wait for a job, keyed or trial. Returns [status, timedOut]. */
async function waitJob(jid, statusPath, headers, timeoutS) {
  const t0 = Date.now(), deadline = t0 + timeoutS * 1000;
  for (;;) {
    const st = await call("GET", statusPath, { auth: !headers, headers: headers || {} });
    if (["succeeded", "failed", "cancelled"].includes(st.status)) return [st, false];
    if (Date.now() > deadline) return [st, true];
    await sleep(Date.now() - t0 < 60_000 ? 5 : 10);
  }
}

/** Copper layer names (F.Cu, In1.Cu, ..., B.Cu) from the board's (layers ...) list. */
function copperLayers(board) {
  try {
    const head = fs.readFileSync(board, "utf8").slice(0, 20000);
    const names = [...head.matchAll(/\(\s*\d+\s+"((?:F|B|In\d{1,2})\.Cu)"\s+(?:signal|power|mixed|jumper)/g)].map((m) => m[1]);
    return [...new Set(names)];
  } catch { return []; }
}

/** After success: save the report, the copper pictures, the routed board and copies of the rules. */
async function saveResult(a, st, res, { prefix, headers }) {
  const board = expand(a.board_path);
  const auth = !headers, h = headers || {};
  const out = expand(a.out_path || board.slice(0, -".kicad_pcb".length) + ".routed.kicad_pcb");
  if (path.resolve(out) === path.resolve(board))
    throw new ZapError(0, { error: "local_file", message: "out_path would overwrite the input board" });
  const obase = out.endsWith(".kicad_pcb") ? out.slice(0, -".kicad_pcb".length) : out;
  // the full report (every finding with its position and what to do) and the copper pictures; for a trial job these
  // must come first, because the first download of the board deletes everything on the server
  const rpath = obase + ".zap-report.json";
  let rep;
  try { rep = await call("GET", `${prefix}/${st.id}/report.json`, { auth, headers: h }); }
  catch (e) { if (!(e instanceof ZapError)) throw e; rep = st; } // an older server without reports: keep the job status
  fs.writeFileSync(rpath, JSON.stringify(rep, null, 1));
  res.report_file = rpath;
  let layers = (rep.image || {}).layers || [];
  for (const lay of layers) { // one picture per copper layer
    const p = `${obase}.${lay.name.replace(/\./g, "_")}.svg`;
    let url = lay.url;
    if (headers && url.startsWith("/v1/jobs/")) url = url.replace("/v1/jobs/", "/v1/try/jobs/");
    try {
      fs.writeFileSync(p, await call("GET", url, { raw: true, auth, headers: h }));
      (res.copper_pictures ||= []).push(p);
    } catch (e) {
      if (!(e instanceof ZapError)) throw e;
      (res.copper_pictures_missing ||= []).push(`${lay.name}: ${e.message}`);
    }
  }
  fs.writeFileSync(out, await call("GET", `${prefix}/${st.id}/result`, { raw: true, auth, headers: h }));
  res.routed_file = out;
  // KiCad opens a board with the project of the same name: give the routed board the input's rules too
  const ibase = board.slice(0, -".kicad_pcb".length);
  for (const ext of [".kicad_pro", ".kicad_dru"]) {
    if (fs.existsSync(ibase + ext) && !fs.existsSync(obase + ext)) {
      fs.copyFileSync(ibase + ext, obase + ext);
      (res.copied_rules ||= []).push(obase + ext);
    }
  }
  // problems to fix per kind (lower is better); the heat list's length is not a problem count
  const names = { hot_spots: "copper_sections_over_10c" };
  res.findings = {};
  for (const s of rep.sections || []) res.findings[names[s.kind] || s.kind] = s.problems ?? s.total;
  if ((rep.summary || {}).heat) res.heat = rep.summary.heat;
  if (poursLine(rep.pours)) res.pours = poursLine(rep.pours);
}

async function toolRouteBoard(a) {
  if (a.check ?? true) {
    const [r, text] = await toolCheckBoard(a);
    if (!r.ok) return [{ submitted: false, check: r }, "Not submitted: the pre-flight check found problems.\n" + text];
  }
  const { form } = upload(a);
  const job = await call("POST", "/v1/jobs", { body: form });
  const jid = job.id;
  if (!(a.wait ?? true)) return [{ job_id: jid, status: "queued" }, `Submitted job ${jid}; poll it with get_job.`];
  const [st, late] = await waitJob(jid, "/v1/jobs/" + jid, null, Number(a.timeout_s ?? 3900));
  if (late) return [{ job_id: jid, status: st.status }, `Job ${jid} is still ${st.status}; poll it with get_job.${st.queue_note ? " " + st.queue_note : ""}`];
  const res = summarize(st);
  if (st.status === "succeeded") {
    await saveResult(a, st, res, { prefix: "/v1/jobs" });
    if (a.delete_after_download ?? true) {
      await call("DELETE", "/v1/jobs/" + jid);
      res.server_files_deleted = true;
    }
  }
  return [res, j(res) + (st.status === "succeeded" ? "\n" + REVIEW : "")];
}

async function toolTryRouteBoard(a) {
  const v = await call("GET", "/v1/version", { auth: false });
  const ti = v.try_it || {};
  if (ti.turnstile_sitekey)
    throw new ZapError(0, { error: "tryit_human_check_required", message: `The free trial now asks for a human check, which ` +
      `only works in a browser: open ${SITE}/app to try a board there. ` + GET_KEY });
  const { form, sent } = upload(a, { trial: true });
  const job = await call("POST", "/v1/try/jobs", { body: form, auth: false, headers: { "X-Zap-Try": "1" } });
  const jid = job.id;
  TRY_TOKENS.set(jid, job.token);
  const h = { "X-Zap-Try": "1", "X-Zap-Try-Token": job.token };
  const note = `Trial job ${jid} (no key; files sent: ${sent.join(", ")}). The trial token lets get_job and get_report ` +
    "read this job; it is given only once, so keep it (try_token) if this MCP server may restart.";
  if (!(a.wait ?? true)) return [{ job_id: jid, status: "queued", try_token: job.token, trial: true },
    note + " Poll it with get_job; download it with get_job download_to (the first download deletes the job's files on the server)."];
  const [st, late] = await waitJob(jid, "/v1/try/jobs/" + jid, h, Number(a.timeout_s ?? 3900));
  if (late) return [{ job_id: jid, status: st.status, try_token: job.token, trial: true },
    `${note} It is still ${st.status}; poll it with get_job.${st.queue_note ? " " + st.queue_note : ""}`];
  const res = Object.assign(summarize(st), { trial: true });
  if (st.status === "succeeded") {
    await saveResult(a, st, res, { prefix: "/v1/try/jobs", headers: h });
    res.server_files_deleted = true; // the trial deletes the board, report and pictures after the first download
    TRY_TOKENS.delete(jid);
  }
  const limits = `Trial limits: at most ${ti.max_pads ?? 300} pads, ${(ti.copper_layers || [2, 4]).join(" or ")} copper layers, ` +
    `${ti.jobs_per_day ?? 2} jobs per network address per UTC day. For larger boards, more jobs, check_board, report pages ` +
    `and feedback, sign in at ${SITE}/auth/login and create an API key on your account page. Questions: ${CONTACT}.`;
  return [res, j(res) + (st.status === "succeeded" ? "\n" + REVIEW : "") + "\n" + limits];
}

function tryHeaders(a) {
  const tok = a.try_token || TRY_TOKENS.get(a.job_id);
  return tok ? { "X-Zap-Try": "1", "X-Zap-Try-Token": tok } : null;
}

async function toolGetJob(a) {
  const h = tryHeaders(a);
  const prefix = h ? "/v1/try/jobs/" : "/v1/jobs/";
  const st = await call("GET", prefix + a.job_id, { auth: !h, headers: h || {} });
  const res = { ...summarize(st), raw: st };
  if (a.download_to && st.status === "succeeded") {
    const data = await call("GET", `${prefix}${a.job_id}/result`, { raw: true, auth: !h, headers: h || {} });
    fs.writeFileSync(expand(a.download_to), data);
    res.routed_file = expand(a.download_to);
    if (h) TRY_TOKENS.delete(a.job_id);
  }
  return [res, j(summarize(st))];
}

async function toolServiceInfo() {
  const v = await call("GET", "/v1/version", { auth: false });
  const st = await call("GET", "/v1/status", { auth: false });
  return [{ version: v, status: st }, `Zap! ${v.service}, router ${v.router}; ${st.jobs_waiting} jobs waiting, median routing time ${st.typical_run_s} s over all of the last 24 h's jobs (small boards take about a minute, large ones with the minutes option up to an hour; a job's own status gives estimated_run_s for its size).`];
}

async function toolErrorCatalog() {
  const r = await call("GET", "/v1/errors", { auth: false });
  return [r, `${(r.errors || []).length} error codes, each with its HTTP status, whether retrying helps and what to change.`];
}

async function toolListJobs() {
  const r = await call("GET", "/v1/jobs");
  return [r, (r.jobs || []).map((x) => `${x.id}  ${String(x.status).padEnd(9)}  ${x.created_at}`).join("\n") || "No jobs yet."];
}

async function toolGetReport(a) {
  const h = tryHeaders(a);
  const rep = await call("GET", `${h ? "/v1/try/jobs" : "/v1/jobs"}/${a.job_id}/report.json`, { auth: !h, headers: h || {} });
  if (rep.error) return [rep, `Job ${rep.id} failed: ${rep.error.message} What to do: ${rep.error.what_to_do}`];
  const lines = [`Report of job ${rep.id} (positions in mm as KiCad shows them; fewer findings is better):`];
  const heat = (rep.summary || {}).heat;
  if (heat) lines.push("Heat: " + heat);
  const po = poursLine(rep.pours);
  if (po) lines.push(po);
  for (const s of rep.sections || []) {
    if (s.kind === "hot_spots") lines.push(`Hottest copper sections (most within the limit): ${s.total} listed`);
    else lines.push(`${s.title}: ${s.total}`);
    const seen = new Set();
    for (const x of (s.items || []).slice(0, 5)) {
      const p = x.at_mm || [null, null];
      lines.push(`  at x ${p[0]}, y ${p[1]}${x.layer ? " on " + x.layer : ""}${x.net ? ", net " + x.net : ""}`);
      if (!seen.has(x.what_to_do)) { seen.add(x.what_to_do); lines.push("    what to do: " + x.what_to_do); }
    }
  }
  return [rep, lines.join("\n") + (rep.report_url || !h ? `\nWeb page with the copper picture (needs the key): ${rep.report_url}` : "")];
}

const FEEDBACK_KINDS = ["praise", "problem", "idea", "other"];

async function toolSendFeedback(a) {
  if (a.user_approved !== true)
    throw new ZapError(0, { error: "feedback_needs_user_approval", message: "Not sent: show your user the exact text, ask whether to send it to the Zap! " +
      "team, and call send_feedback with user_approved true only if they say yes." });
  const body = { message: a.message, user_approved: true };
  for (const k of ["job_id", "kind", "contact_ok", "snapshot_ids"]) if (a[k] !== undefined && a[k] !== null) body[k] = a[k];
  const r = await call("POST", "/v1/feedback", { body: JSON.stringify(body), ctype: "application/json" });
  return [r, `Sent to the Zap! team as feedback ${r.id} at ${r.received_at}. Tell the user it was sent.`];
}

async function toolBoardSnapshot(a) {
  const body = {};
  for (const k of ["x_mm", "y_mm", "size_mm", "layers", "show_issues"]) if (a[k] !== undefined && a[k] !== null) body[k] = a[k];
  const r = await call("POST", `/v1/jobs/${a.job_id}/snapshot`, { body: JSON.stringify(body), ctype: "application/json" });
  const png = await call("GET", r.png_url, { raw: true });
  const p = path.resolve(expand(a.save_to || `zap-snapshot-${r.snapshot_id}.png`));
  fs.writeFileSync(p, png);
  r.saved_to = p;
  const reg = r.region || {}, im = r.issues_marked || {};
  const text = `Picture ${r.snapshot_id} saved to ${p}: x ${reg.x_mm}, y ${reg.y_mm} mm, ${reg.size_mm} mm square, layers ` +
    `${(reg.layers || []).join(", ")}; ${(r.nets_in_region || []).length} nets in the area; marked ${im.unconnected} missing ` +
    `connections and ${im.drc} design-rule errors. Show it to the user. Attach it (snapshot_ids) to send_feedback only ` +
    `if they say yes; otherwise it is deleted at ${r.expires_at}.`;
  return [r, text, png];
}

async function toolDeleteSnapshot(a) {
  const r = await call("DELETE", `/v1/snapshots/${a.snapshot_id}.png`);
  return [r, `Deleted picture ${a.snapshot_id} on the Zap! server.`];
}

async function toolDeleteJob(a) {
  const r = await call("DELETE", "/v1/jobs/" + a.job_id);
  return [r, (r.status === "cancelled" ? "Cancelled job %s." : "Deleted the files of job %s.").replace("%s", a.job_id)];
}

const OPTION_FIELDS = {
  signal_width_mm: { type: "number", description: "Signal track width in mm (default: the board's net class, else 0.2)." },
  via_diameter_mm: { type: "number", description: "Via diameter in mm; send with via_drill_mm (default: net class, else 0.6)." },
  via_drill_mm: { type: "number", description: "Via drill in mm; send with via_diameter_mm (default: net class, else 0.3)." },
  vias_in_pads: { type: "string", enum: ["forbid", "allow"], description: "Vias inside SMD pads (default forbid; allow needs the board made with filled and capped vias, an extra fab option)." },
  ground_pour: { type: "string", enum: ["on", "off"], description: "Ground copper pours (default on)." },
  size_rails_from_current: { type: "string", enum: ["on", "off"], description: "Supply track width from current where room allows (default on; off: the net-class width, which may overheat)." },
  effort: { type: "string", enum: ["quick", "normal", "thorough"], description: "Routing effort (default normal). thorough: about twice the routing work and keeps the best intermediate result; slower on large boards, usually fewer unrouted connections. quick: about one eighth of the work, faster, more unrouted connections." },
  minutes: { type: "integer", minimum: 1, maximum: 60, description: "Let Zap! keep trying for up to this many minutes (1 to 60) and return the best result; default is one round of a few minutes. Only when the human wants the best result and can wait; a job over 10 minutes may queue behind another one." },
};
const FILES = {
  board_path: { type: "string", description: "Path to the placed .kicad_pcb (outline on Edge.Cuts; no tracks or vias unless keep_existing or strip_existing is true)." },
  project_path: { type: "string", description: "Optional .kicad_pro with the design rules; default: the .kicad_pro next to the board if present." },
  rules_path: { type: "string", description: "Optional .kicad_dru; default: the .kicad_dru next to the board if present." },
  currents_path: { type: "string", description: "Optional JSON file of known currents: {\"nets\": {\"<net>\": {\"amps\": A}}, \"ambient_c\": C}. State supply nets, not ground." },
  router: { type: "string", enum: ["stable", "next"], description: "Router to use; default stable." },
  currents: { type: "object", description: "Known currents inline instead of currents_path: {\"nets\": {\"<net>\": {\"amps\": A}}, \"ambient_c\": C}." },
  consent_training: { type: "boolean", description: "Records that the human is open to this board being used to improve Zap! (default false; only a preference: nothing is used without a separate written agreement)." },
  keep_existing: { type: "boolean", description: "true for a partly routed board: keep its tracks, vias and zones exactly and route only the missing connections (default false)." },
  strip_existing: { type: "boolean", description: "true to discard the board's existing tracks and vias and route everything (default false: a board with tracks or vias is refused with input_has_copper). The fix for that answer when the human has no KiCad at hand; not with keep_existing." },
  ...OPTION_FIELDS,
  fab_floor: { type: "string", enum: ["jlc", "board"],
    description: "jlc (default): never go below JLC's capability; nets that need finer copper are left unrouted and listed with the reason. board: follow the board's own minimums, for fabs finer than JLC; JLC findings are still reported." },
};
const WAIT_ARGS = {
  out_path: { type: "string", description: "Where to save the routed board; default BOARD.routed.kicad_pcb next to the input (never overwrites the input)." },
  wait: { type: "boolean", description: "Wait for the result (default true); false returns the job id at once." },
  timeout_s: { type: "number", description: "Stop waiting after this many seconds (default 3900); the job keeps running." },
};
const { router: _router, ...TRY_FILES } = FILES;
const TRY_TOKEN_ARG = { try_token: { type: "string", description: "Only for a trial job (try_route_board) after this MCP server restarted: the try_token it returned. Not needed otherwise." } };

const TOOLS = [
  { name: "check_board", fn: toolCheckBoard,
    description: "Pre-flight check of a KiCad board with Zap! (seconds, no routing, uses no job quota): lists every problem that would stop the job (blockers) and what would weaken it (warnings), with references, positions and the KiCad fix. Run this first when an API key is set; it needs one. Without a key, use try_route_board, which runs the same checks when it submits.",
    inputSchema: { type: "object", properties: FILES, required: ["board_path"] } },
  { name: "route_board", fn: toolRouteBoard,
    description: "Route a placed KiCad board with Zap!: pre-flight check, submit (uses one of the key's daily jobs), wait (seconds for small boards, up to 60 minutes), download BOARD.routed.kicad_pcb next to the input (with copies of BOARD.kicad_pro/.kicad_dru so KiCad uses the same rules), delete the server copy. Returns the numbers to show the human; all are lower-is-better. The result needs a human review and KiCad DRC before fabrication.",
    inputSchema: { type: "object", properties: { ...FILES, out_path: WAIT_ARGS.out_path,
      check: { type: "boolean", description: "Run the pre-flight check first and do not submit on blockers (default true)." },
      wait: WAIT_ARGS.wait, timeout_s: WAIT_ARGS.timeout_s,
      delete_after_download: { type: "boolean", description: "Delete the server copy after saving it (default true)." } },
    required: ["board_path"] } },
  { name: "try_route_board", fn: toolTryRouteBoard,
    description: "Route one small placed KiCad board with Zap! without an API key or sign-up (the free trial): at most 300 pads, 2 or 4 copper layers, 2 trial jobs per network address per UTC day, stable router only. Use it when no Zap! API key is configured. Submits (the submission runs the same board checks as check_board and answers with the problem if the board cannot be routed), waits, saves the full report BOARD.routed.zap-report.json and one picture per copper layer, then BOARD.routed.kicad_pcb next to the input with copies of BOARD.kicad_pro/.kicad_dru. The server deletes the trial job's files right after that download. Returns the numbers to show the human; all are lower-is-better. The result needs a human review and KiCad DRC before fabrication.",
    inputSchema: { type: "object", properties: { ...TRY_FILES, ...WAIT_ARGS }, required: ["board_path"] } },
  { name: "get_report", fn: toolGetReport,
    description: "The result report of a finished Zap! job: every missing connection, design-rule error, JLC violation, hot spot and leftover copper, each with its position (mm, as KiCad shows them), layer, net and what to do in KiCad. Use it to tell the human exactly what to fix.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, ...TRY_TOKEN_ARG }, required: ["job_id"] } },
  { name: "get_job", fn: toolGetJob,
    description: "Status and result numbers of a Zap! job; with download_to, also saves the routed board when it has succeeded.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, download_to: { type: "string" }, ...TRY_TOKEN_ARG }, required: ["job_id"] } },
  { name: "service_info", fn: toolServiceInfo, description: "Zap! service status without a key: version, router build, whether routing options are on, jobs waiting and the typical wait and routing time.",
    inputSchema: { type: "object", properties: {} } },
  { name: "error_catalog", fn: toolErrorCatalog, description: "Every Zap! error code with its HTTP status, whether retrying helps, and the change that fixes it.",
    inputSchema: { type: "object", properties: {} } },
  { name: "list_jobs", fn: toolListJobs, description: "This key's last 50 Zap! jobs (id, status, created time).",
    inputSchema: { type: "object", properties: {} } },
  { name: "send_feedback", fn: toolSendFeedback,
    description: "Send the user's opinion about Zap! or a routing result to the Zap! team. Only call this after the " +
      "user saw the exact text (and the job id) and said yes; if they said no, do not ask again in this " +
      "session. The text is the user's words, or a summary they approved. Never send board files, file " +
      "contents or anything the user did not approve. " + FEEDBACK_RULE,
    inputSchema: { type: "object", additionalProperties: false, required: ["message", "user_approved"], properties: {
      message: { type: "string", minLength: 1, maxLength: 4000, description: "Exactly the text the user approved: their words, or a summary they agreed to (1 to 4,000 characters)." },
      user_approved: { type: "boolean", enum: [true], description: "true only after the user saw this exact text and said yes to sending it. Without it nothing is sent." },
      job_id: { type: "string", description: "Optional: the job the opinion is about (one of this key's jobs), shown to the user with the text." },
      kind: { type: "string", enum: FEEDBACK_KINDS, description: "Optional: praise, problem, idea or other." },
      contact_ok: { type: "boolean", description: "Optional: true if the user agreed that the Zap! team may reply to the account's email address (default false)." },
      snapshot_ids: { type: "array", maxItems: 3, items: { type: "string" }, description: "Optional: pictures from board_snapshot (same job) that the user saw and agreed to attach." } } } },
  { name: "board_snapshot", fn: toolBoardSnapshot,
    description: "A picture (PNG) of one small square area, at most 40 mm, of a finished job's routed board, with the " +
      "report's missing connections and design-rule errors marked: saved next to you and returned as an " +
      "image. Use it when the user's feedback is about a spot on the board: aim it with the report's at_mm " +
      "positions (get_report). Show the picture to the user before sending; attach it to send_feedback " +
      "(snapshot_ids) only if they say yes. Never the whole board. A picture not attached is deleted after " +
      "24 hours.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id", "x_mm", "y_mm"], properties: {
      job_id: { type: "string" },
      x_mm: { type: "number", description: "Centre of the area, x in mm as KiCad shows positions (for example a report item's at_mm)." },
      y_mm: { type: "number", description: "Centre of the area, y in mm." },
      size_mm: { type: "number", minimum: 1, maximum: 40, description: "Side of the square, mm (default 20)." },
      layers: { type: "array", items: { type: "string" }, description: "Copper layers to draw, e.g. [\"F.Cu\"] (default all)." },
      show_issues: { type: "boolean", description: "Mark the report's issues in the area (default true)." },
      save_to: { type: "string", description: "Where to save the PNG (default zap-snapshot-<id>.png in the current folder)." } } } },
  { name: "delete_snapshot", fn: toolDeleteSnapshot,
    description: "Delete a board picture the user does not want to attach, on the Zap! server, at once (otherwise it " +
      "is deleted 24 hours after it was made). Pictures already attached to feedback are not deleted here.",
    inputSchema: { type: "object", properties: { snapshot_id: { type: "string" } }, required: ["snapshot_id"] } },
  { name: "delete_job", fn: toolDeleteJob, description: "Cancel a queued or running Zap! job (it stops at once, nothing is kept), or delete a finished job's files on the server (otherwise they are deleted after 7 days).",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
];

const KEYED = new Set(["check_board", "route_board", "list_jobs", "send_feedback", "board_snapshot", "delete_snapshot", "delete_job"]);

const server = new Server({ name: "zap", version: VERSION }, {
  capabilities: { tools: {} },
  instructions: "Zap! routes placed KiCad boards. With a Zap! API key: check_board first, then route_board. " +
    "Without a key: use try_route_board, which routes one small board (at most 300 pads, 2 or 4 copper layers) with no " +
    "sign-up and runs the same checks as check_board when it submits (check_board itself needs a key). " +
    "Report the numbers it returns to the human (lower is better) and end with: " + REVIEW + " " +
    FEEDBACK_RULE + " " + URL_BASE + "/agents.md",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ fn, ...t }) => t),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = TOOLS.find((x) => x.name === req.params.name);
  if (!t) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${req.params.name}`);
  const warn = () => (KEY_WARNING.length ? KEY_WARNING[0] + "\n" : "");
  try {
    if (KEYED.has(t.name) && !hasKey()) loadKey(); // throws the no_key error with how to get a key and the trial
    const out = await t.fn(req.params.arguments || {});
    const [data, text, png] = out;
    const content = [{ type: "text", text: warn() + text }];
    if (png) content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    return { content, structuredContent: data, isError: false };
  } catch (e) {
    if (e instanceof ZapError)
      return { content: [{ type: "text", text: warn() + e.message }], structuredContent: { error: e.body }, isError: true };
    return { content: [{ type: "text", text: `zap-mcp error: ${e.message}` }], isError: true }; // report, never crash the server
  }
});

await server.connect(new StdioServerTransport());
