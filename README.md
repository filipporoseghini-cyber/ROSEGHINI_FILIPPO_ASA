# Autonomous Software Agents — ASA 2025-2026

**Author:** Filippo Roseghini — ID 267934  
**Course:** Autonomous Software Agents, University of Trento  
**Report:** [`report/report_ASA.pdf`](report/report_ASA.pdf)

---

## Overview

This project implements two independent agents for the [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js) game, a multi-agent grid environment where agents collect and deliver parcels to maximise score.

- **`agente3`** — classical BDI agent with A\* navigation and optional PDDL planning
- **`agente_llm`** — LLM-based agent with a Plan-and-Execute architecture

Both agents can run simultaneously on the same server and coordinate with each other via a private `[COORD]` messaging protocol.

---

## Architecture

### agente3 — BDI Agent

Follows a classic sense–deliberate–act loop:

```
onSensing → optionsGeneration() → IntentionRevisionReplace → Plan.execute()
```

- **A\* pathfinder** with conveyor and crate support, congestion penalties, and dynamic re-routing
- **Three optional PDDL planners** (all fall back to A\* if the solver is unreachable):
  - `pddlPlanner.js` — low-level navigation (replaces A\*)
  - `pddlDelivery.js` — task-level means-end reasoning (which parcels, in what order)
  - `pddlCrates.js` — Sokoban-style crate pushing on dedicated maps
- **BDI commitment semantics** via `IntentionRevisionReplace`: a running plan is never interrupted unless a strictly better option arises

### agente_llm — LLM Plan-and-Execute Agent

```
LLM-Memory → LLM-Planner → PLAN(a1..aN) → Executor (0 LLM calls) → Replan?
```

- **LLM-Planner** produces a full action sequence in one call (navigate, pick, drop), dramatically reducing LLM calls compared to a ReAct loop
- **Hybrid startup**: a deterministic A\*-based plan runs immediately while the LLM plan is computed in background; the LLM plan replaces it once ready
- **LLM-Replanner** is invoked only on failure (blocked path, missing parcel, …), capped at 3 replans per mission
- Supports natural-language missions sent via server chat (e.g. `"collect all red parcels first"`)

---

## Repository Structure

```
.
├── agente3/
│   ├── agent.js           # BDI main loop, intentions, plans
│   ├── beliefs.js         # Belief base (map, parcels, agents)
│   ├── planner.js         # A* pathfinder
│   ├── pddlPlanner.js     # PDDL navigation planner
│   ├── pddlDelivery.js    # PDDL task-level planner
│   ├── pddlCrates.js      # PDDL crate-pushing planner
│   └── .env.example       # Configuration template
├── agente_llm/
│   ├── agent_llm.js       # LLM Plan-and-Execute main loop
│   ├── beliefs.js         # Shared belief base
│   ├── planner.js         # A* pathfinder (shared logic)
│   └── .env.example       # Configuration template
├── report/
│   ├── report_ASA.pdf     # Compiled report
│   ├── report.tex         # LaTeX source
│   ├── setup.png          # Scenario screenshot
│   └── crates_maze.png    # Crates map screenshot
└── README.md
```

---

## Prerequisites

- **Node.js** ≥ 18 (ES modules required)
- A running **Deliveroo.js** game server — either:
  - The UniTN online server at `https://deliveroojs.bears.disi.unitn.it` (requires GlobalProtect VPN)
  - A local server: clone [unitn-ASA/Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js), then `npm install && npm run build && npm start`
- For `agente_llm` only: access to a LiteLLM-compatible endpoint (UniTN VPN, LM Studio, Ollama, or OpenAI)

---

## Setup

```bash
# 1. Clone the repository
git clone https://github.com/filipporoseghini-cyber/ROSEGHINI_FILIPPO_ASA.git
cd ROSEGHINI_FILIPPO_ASA

# 2. Install dependencies for each agent
cd agente3 && npm install && cd ..
cd agente_llm && npm install && cd ..

# 3. Configure environment variables
cp agente3/.env.example agente3/.env
cp agente_llm/.env.example agente_llm/.env
# Edit both .env files with your HOST, TOKEN, and (for agente_llm) LLM credentials
```

> **Note on `.env` files:** the actual `.env` files with server tokens and API keys are included in this repository (in each agent's folder) as well as in the source code ZIP submitted via the course platform.

---

## Running the Agents

Each agent needs its **own JWT token** — they appear as two separate players on the server. Generate a second token by opening the game client with a different player name.

```bash
# Start the BDI agent
node agente3/agent.js

# Start the LLM agent (separate terminal)
node agente_llm/agent_llm.js
```

When both are running on the same server they will handshake automatically and switch to private targeted messaging for coordination.

---

## Configuration

### agente3 `.env`

| Variable | Description | Default |
|---|---|---|
| `HOST` | Game server URL | `http://localhost:8080` |
| `TOKEN` | JWT token for this agent | — |
| `SENSING_RADIUS` | Perception radius (tiles) | `5` |
| `USE_PDDL_PLANNER` | Use PDDL for navigation instead of A\* | `false` |
| `USE_PDDL_DELIVERY` | Use PDDL for task-level planning | `false` |

### agente_llm `.env`

| Variable | Description | Default |
|---|---|---|
| `HOST` | Game server URL | `http://localhost:8080` |
| `TOKEN` | JWT token for this agent (different from agente3) | — |
| `SENSING_RADIUS` | Perception radius (tiles) | `5` |
| `LITELLM_BASE_URL` | LiteLLM-compatible endpoint | UniTN endpoint |
| `LITELLM_API_KEY` | API key for the LLM endpoint | — |
| `LOCAL_MODEL` | Model ID to use | `llama-3.3-70b-lmstudio` |
| `LLM_LAZY` | Skip LLM when no special mission is active | `true` |

---

## Development Note

Parts of this project — including code comments, the LaTeX report, and portions of the agent logic — were developed with the assistance of [Claude](https://claude.ai) (Anthropic's LLM). All design decisions, testing, and final integration were done by the author.

---

## Inter-Agent Coordination

After an initial broadcast handshake, the two agents communicate exclusively via `emitSay` (private, peer-to-peer) to avoid polluting the public server chat. Messages follow a `[COORD] <type>: <payload>` format and carry position, carrying state, and current intention — allowing each agent to avoid duplicating the other's work.
