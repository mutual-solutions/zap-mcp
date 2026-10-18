// Smoke test: starts bin/zap-mcp.js over stdio with the MCP SDK client and calls tools.
// node test/smoke.mjs list                      list tools, call service_info, and route_board with no key (error text)
// node test/smoke.mjs trial BOARD.kicad_pcb     keyless trial route of BOARD (uses one trial job)
// node test/smoke.mjs check BOARD.kicad_pcb     keyed check_board (needs ZAP_API_KEY_FILE in the environment)
// Extra tool arguments as JSON in ZAP_TEST_ARGS, e.g. '{"strip_existing": true}'.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode = "list", board] = process.argv.slice(2);
const extra = JSON.parse(process.env.ZAP_TEST_ARGS || "{}");
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
if (process.env.ZAP_URL) env.ZAP_URL = process.env.ZAP_URL;
if (mode === "check") env.ZAP_API_KEY_FILE = process.env.ZAP_API_KEY_FILE;
else env.ZAP_API_KEY_FILE = "/nonexistent/zap-key.txt"; // no key for list and trial

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zap-mcp.js");
const client = new Client({ name: "zap-mcp-smoke", version: "0" });
const t0 = Date.now();
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: "inherit" }));
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const show = (name, r) => {
  console.log(`--- ${name} (isError ${r.isError}, at ${ms()})`);
  for (const c of r.content) console.log(c.type === "text" ? c.text : `[${c.type} ${c.mimeType}]`);
};

if (mode === "list") {
  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}  at ${ms()}`);
  console.log("instructions:", client.getInstructions());
  show("service_info", await client.callTool({ name: "service_info", arguments: {} }));
  show("route_board without a key", await client.callTool({ name: "route_board", arguments: { board_path: "/tmp/x.kicad_pcb" } }));
  show("get_job without a key", await client.callTool({ name: "get_job", arguments: { job_id: "0".repeat(32) } }));
} else if (mode === "trial") {
  const r = await client.callTool({ name: "try_route_board", arguments: { board_path: board, ...extra } }, undefined, { timeout: 4_000_000 });
  show("try_route_board", r);
  console.log("structured keys:", Object.keys(r.structuredContent || {}).join(", "));
} else if (mode === "check") {
  show("check_board", await client.callTool({ name: "check_board", arguments: { board_path: board, ...extra } }, undefined, { timeout: 600_000 }));
}
await client.close();
console.log(`done at ${ms()}`);
