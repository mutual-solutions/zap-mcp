# zap-pcb-mcp

KiCad PCB autorouter for AI agents: MCP server, HTTP API and CLI, with a JSON manufacturability report (DRC, shorts, JLCPCB capability, copper heat).

`zap-pcb-mcp` is the stdio MCP server for [Zap!](https://zap.mutual.solutions), a hosted auto-router by mutual. You give it a
placed `.kicad_pcb` (with its `.kicad_pro`); it returns the same board with tracks, vias and copper pours added, plus a
report of what is still wrong and where. Node 18 or newer. The board is routed on the Zap! service, not on your machine.

Early access: every routed board must be reviewed by an engineer, and KiCad's DRC run, before fabrication.

## Quick start

### Claude Code

```bash
claude mcp add zap -e ZAP_API_KEY_FILE=$HOME/zap-key.txt -- npx -y zap-pcb-mcp
```

Restart the agent session: the tools appear only after the restart.

### Claude Desktop, Cursor and other MCP clients

```json
{
  "mcpServers": {
    "zap": {
      "command": "npx",
      "args": ["-y", "zap-pcb-mcp"],
      "env": { "ZAP_API_KEY_FILE": "/absolute/path/to/zap-key.txt" }
    }
  }
}
```

Claude Desktop: `claude_desktop_config.json`. Cursor: `~/.cursor/mcp.json` or `.cursor/mcp.json` in the project.

### The API key

Sign in at https://zap.mutual.solutions/auth/login and create an API key on your account page. Save it as `~/zap-key.txt`
and run `chmod 600 ~/zap-key.txt`. The server reads the key from the environment only, in this order:

| variable | meaning |
|---|---|
| `ZAP_API_KEY` | the key itself |
| `ZAP_API_KEY_FILE` | path to a file holding the key (default `~/.config/zap/key`) |
| `ZAP_URL` | service address, default `https://zap.mutual.solutions`; must be https |

The key is never taken from tool arguments and never written to tool output or logs. The server warns when the key
file is readable by other users. Redirects are never followed, so the key is only sent to `ZAP_URL`.

### No key: the free trial

Without a key, the `try_route_board` tool routes one small board with no sign-up: at most 300 pads, 2 or 4 copper
layers, 2 trial jobs per network address per UTC day, stable router only. Every tool that needs a key answers, when
none is set, with how to get one and that the trial exists.

```bash
claude mcp add zap -- npx -y zap-pcb-mcp
```

Then ask your agent to route a board, for example: "Route ~/boards/myboard.kicad_pcb with Zap!".

## Tools

The names, arguments and answers match the single-file Python server
[zap_mcp.py](https://zap.mutual.solutions/downloads/zap_mcp.py), so the guides at
https://zap.mutual.solutions/agents.md apply to both.

| tool | key | what it does |
|---|---|---|
| `check_board` | yes | Pre-flight check (seconds, no routing, no job quota): every problem that would stop the job (blockers) and what would weaken it (warnings), with references, positions and the KiCad fix. |
| `route_board` | yes | Check, submit, wait, then save `BOARD.routed.kicad_pcb`, the full report `BOARD.routed.zap-report.json`, one SVG per copper layer and copies of `BOARD.kicad_pro` / `.kicad_dru`; then delete the server copy. |
| `try_route_board` | no | The same as `route_board` on the free trial (limits above). The trial deletes the job's files on the server right after the routed board is downloaded. |
| `get_report` | yes* | Every missing connection, design-rule error, JLC violation, hot spot and leftover copper, with position (mm), layer, net and what to do in KiCad. |
| `get_job` | yes* | Status and result numbers of a job; `download_to` saves the routed board. |
| `list_jobs` | yes | The key's last 50 jobs. |
| `delete_job` | yes | Cancel a queued or running job, or delete a finished job's files. |
| `send_feedback` | yes | Send the user's opinion to the Zap! team, only after the user approved the exact text (`user_approved: true`). |
| `board_snapshot` | yes | PNG of one square area (at most 40 mm) of a routed board with issues marked, returned as an image. |
| `delete_snapshot` | yes | Delete a picture the user does not want attached. |
| `service_info` | no | Service and router version, jobs waiting, typical routing time. |
| `error_catalog` | no | Every error code with its HTTP status, whether retrying helps and the fix. |

\* For a trial job, `get_job` and `get_report` work without a key in the same server session; after a restart pass the
`try_token` that `try_route_board` returned.

`check_board`, `route_board` and `try_route_board` take every upload option of the API with the same name and default:
`project_path`, `rules_path`, `currents_path` or `currents`, `router` (not on the trial), `keep_existing`,
`strip_existing`, `fab_floor`, `signal_width_mm`, `via_diameter_mm`, `via_drill_mm`, `vias_in_pads`, `ground_pour`,
`size_rails_from_current`, `effort`, `minutes`, `consent_training`. Boards are sent gzip-compressed.

## HTTP API

Base URL `https://zap.mutual.solutions`, header `Authorization: Bearer <key>`. The key goes to curl as a header file,
so it never appears in a command line:

```bash
URL=https://zap.mutual.solutions
zcurl() { curl -s -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$ZAP_API_KEY_FILE")") "$@"; }

zcurl -F board=@myboard.kicad_pcb -F project=@myboard.kicad_pro $URL/v1/check            # check
zcurl -F board=@myboard.kicad_pcb -F project=@myboard.kicad_pro $URL/v1/jobs             # submit: {"id", "status": "queued"}
zcurl $URL/v1/jobs/$ID                                                                   # poll every 5 s until succeeded / failed / cancelled
zcurl -o myboard.routed.kicad_pcb $URL/v1/jobs/$ID/result                                # download (report: $URL/v1/jobs/$ID/report.json)
```

The trial without a key: `curl -s -H 'X-Zap-Try: 1' -F board=@myboard.kicad_pcb -F project=@myboard.kicad_pro
$URL/v1/try/jobs` answers with an `id`, a `token` (shown once) and the job's URLs (`status_url`, `report_json_url`,
`layer_svg_example_url`, `result_url`); send the header `X-Zap-Try-Token: <token>` on each. `POST /v1/check` needs a key;
the trial submission runs the same checks. Fetch `report.json` and the copper pictures it lists in `image.layers[].url`
(`/v1/try/jobs/$ID/report/F_Cu.svg`, `.../B_Cu.svg`) before `result`: the first download of the board deletes the job's
files.

Every endpoint, field and error: [openapi.json](https://zap.mutual.solutions/openapi.json),
[llms.txt](https://zap.mutual.solutions/llms.txt), [error catalog](https://zap.mutual.solutions/v1/errors),
[agent guide](https://zap.mutual.solutions/agents.md).

## CLI

[zap.py](https://zap.mutual.solutions/downloads/zap.py), Python 3.8 or newer, standard library only:
`python3 zap.py run myboard.kicad_pcb` checks, submits, waits and saves the routed board and report, like
`route_board`. `python3 zap.py login` signs in with OAuth instead of a key.

## The report

All numbers count problems or temperatures: **lower is better, 0 is best**.

| field | meaning |
|---|---|
| `unconnected` | connections still missing (0 = fully routed) |
| `critical_unconnected` | of those, on supply, ground, clock, reset, boot or debug nets; must be 0 before ordering boards |
| `drc_errors` | KiCad design-rule errors under the uploaded rules (some come from the placement) |
| `shorts` | copper of two nets touching; Zap! never returns a board with a short it routed, so any here were already in the uploaded board (`shorts_already_in_board`) |
| `jlc_violations` (`jlc_violations_by_type`) | features JLCPCB's standard process cannot make, with positions in `jlc_items` |
| `hottest_rise_c`, `sections_over_limit` | hottest copper in °C above ambient, and copper sections over the limit (`rise_limit_c`, 10 °C) |
| `currents` | whether currents were `estimated` from the board's parts or `stated` by you (`currents` argument) |

A result is ready for human review when the job succeeded, `critical_unconnected` is 0 and `shorts` is 0. It is
clean when `unconnected`, `drc_errors`, `jlc_violations` and `sections_over_limit` are 0 as well. The saved
`BOARD.routed.zap-report.json` lists every finding with `at_mm` (x, y in mm as KiCad shows them), layer, net and
`what_to_do`.

## Limits

- Free trial (no key): at most 300 pads, 2 or 4 copper layers, 2 jobs per network address per UTC day.
- With a key: up to 10,000 pads, 4,000 footprints, 2 to 16 copper layers, 20 MiB per upload (boards are sent
  compressed), 60 minutes per job, 2 jobs at a time and 30 requests a minute per key, daily jobs as issued with the
  key (default 50).
- A board too large for the self-serve service is refused with `board_too_large`; email hello@mutual.solutions to
  arrange a business (B2B) job.
- Early access: every routed board must be reviewed by an engineer, and KiCad's DRC run, before fabrication.

## Benchmark

https://zap.mutual.solutions/compare

## Privacy

What Zap! keeps from board files, why and for how long: https://zap.mutual.solutions/privacy. `route_board` deletes
the server copy after download by default; trial jobs are deleted after the first download of the routed board.

## Contact

hello@mutual.solutions

## Licence

MIT, Copyright (c) 2026 Mutual Solutions, Inc. (see [LICENSE](LICENSE)). The licence covers this package, not the Zap!
service; using the service is governed by https://zap.mutual.solutions/terms.
