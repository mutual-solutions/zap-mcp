# Directory listing texts (not submitted)

Texts to paste into the glama.ai and mcpservers.org submission forms once the npm package and the GitHub repository
are public. Both directories read the README from the repository as the long description.

## Common fields

- Name: Zap! KiCad autorouter (npm package `zap-pcb-mcp`)
- One line: KiCad PCB autorouter for AI agents, with a JSON manufacturability report.
- Description (under 300 characters):
  Route a placed KiCad board (.kicad_pcb) on the hosted Zap! auto-router and get it back with tracks, vias and copper
  pours, plus a JSON report: missing connections, DRC errors, shorts, JLCPCB capability and copper heat. Free trial for
  small boards with no key.
- Install: `npx -y zap-pcb-mcp` (stdio). Key: `ZAP_API_KEY_FILE` or `ZAP_API_KEY`; optional (keyless trial without it).
- Repository: https://github.com/mutual-solutions/zap-mcp
- npm: https://www.npmjs.com/package/zap-pcb-mcp
- Website: https://zap.mutual.solutions
- Docs for agents: https://zap.mutual.solutions/agents.md and https://zap.mutual.solutions/llms.txt
- Licence: MIT
- Contact: hello@mutual.solutions

## glama.ai

- Submission: the "Add Server" button on https://glama.ai/mcp/servers (the form did not load without a browser session and was not read).

- GitHub URL: https://github.com/mutual-solutions/zap-mcp
- Categories (proposed): Developer Tools; Engineering / Hardware if offered
- Tags: kicad, pcb, autorouter, eda, jlcpcb, drc, hardware

## mcpservers.org

Form at https://mcpservers.org/submit (fields read on 2026-10-18; free plan):

- Server Name: Zap! KiCad autorouter
- Category: Development
- Short Description: the description above
- Repository, Website or Documentation: https://github.com/mutual-solutions/zap-mcp
- Official MCP Registry Name (optional): io.github.mutual-solutions/zap-mcp
- This server supports remote connections: leave unticked for this package (the separate OAuth server at
  https://zap.mutual.solutions/mcp is remote; tick only if the listing should cover it)
- Contact Email: hello@mutual.solutions
