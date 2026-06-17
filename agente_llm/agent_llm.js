/* ============================================================================
   FILE: agent_llm.js
   ARCHITETTURA: LLM-based Agent, schema PLAN-AND-EXECUTE (cfr. slide 13).

   Idea chiave: l'LLM è LENTO (3-8s a chiamata), quindi NON lo usiamo per
   decidere ogni micro-passo. Lo usiamo solo per la PIANIFICAZIONE strategica
   (quali pacchi raccogliere e in che ordine). L'ESECUZIONE (navigazione,
   pickup, delivery) è fatta da codice deterministico A*, velocissimo.

     COMPONENTE A — LLM-Memory       [buildLLMMemory]
       Aggrega contesto dinamico: obiettivo + osservazione ambiente aggiornata
       + memoria storica cross-obiettivo. Costruita una volta per (ri)piano.

     COMPONENTE B — LLM-Planner      [llmPlan]  → UNA sola chiamata LLM
       Riceve obiettivo + memoria e produce un PIANO = sequenza ordinata di
       azioni-tool a1, a2, ..., aN (esattamente la "PLAN (a1..aN)" della slide 12).
       Decide l'intero "giro" in un colpo solo, così tende naturalmente a
       raccogliere PIÙ pacchi per viaggio. Interpreta anche obiettivi in
       linguaggio naturale traducendoli nella sequenza di tool adeguata.

     EXECUTOR                        [inline in runAgentTurn]  → ZERO chiamate LLM
       Scorre le azioni a1..aN e le dispaccia ai tool del catalogo (navigate_to
       via A*, pick_up, put_down, ...). Dopo ogni azione valuta l'esito. È la
       parte veloce: tutta la navigazione avviene senza interpellare l'LLM.
       navigate_to raccoglie anche i pacchi calpestati lungo il tragitto
       (pickup opportunistico) e re-instrada attorno agli agenti che bloccano.

     COMPONENTE C — LLM-Replanner    [llmPlan(memory, replanNote)]
       Interpellato SOLO quando un'azione fallisce o il mondo/obiettivo cambia
       (percorso bloccato, pacco sparito, ...). Una chiamata LLM aggiuntiva che
       riadatta il piano allo stato corrente. Cap: max 3 ripianificazioni.

   AVVIO IBRIDO (obiettivi autonomi): per non lasciare l'agente fermo 3-8s ad
   aspettare l'LLM, parte SUBITO con un piano deterministico (top pacchi per
   utilità) mentre l'LLM-Planner gira in background; appena il piano LLM è pronto
   lo adotta. L'LLM-Planner resta sempre nel loop → compliance slide 12-13.
   (Gli obiettivi in linguaggio naturale attendono invece l'LLM: un piano
   deterministico non saprebbe interpretarli.)

   FLUSSO per obiettivo (= ciclo della slide 12):
     LLM-Memory → LLM-Planner → PLAN(a1..aN) → Exec (0 call) → Replan?
                     ↑___________________ LLM-Replanner (1 call) se "YES" _____|
   Costo tipico: 1 chiamata LLM per giro completo (vs 8-10 del vecchio ReAct),
   con attesa percepita ~0 grazie all'avvio ibrido.
============================================================================ */

import 'dotenv/config';
import OpenAI from 'openai';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { Beliefs } from './beliefs.js';
import { Planner } from './planner.js';

// ==========================================
// 1. Configurazione LiteLLM
// ==========================================
const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey  = process.env.LITELLM_API_KEY;
const MODEL   = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";
const client  = new OpenAI({ baseURL, apiKey });

// ==========================================
// 2. DeliverooJS connection and agent state
// ==========================================
const socket    = DjsConnect(process.env.HOST || "localhost:8080", process.env.TOKEN);
const me        = { id: null, name: null, x: null, y: null, score: 0 };
const myBeliefs = new Beliefs();

// Last coordination message from the BDI partner. Updated by the 'msg' listener
// and injected into LLM-Memory on every planning cycle.
let lastBdiUpdate = "No updates from BDI partner yet.";

// Sender ID of the current request/mission, set at turn start. Used by
// reply_to_sender. null for autonomous (self-generated) objectives.
let activeSenderId = null;

// (Challenge 2 - Level 2) STRUCTURED PERSISTENT MISSION CONSTRAINTS.
// Unlike currentStrategy (a text directive for the LLM), these are read by code
// and enforced mechanically by navigate_to / put_down, so missions like "do not
// cross tile X" or "deliver stacks of exactly N" are guaranteed, not just described.
// Set by avoid_tiles / set_delivery_batch etc.; persist until clear_mission_rules.
const missionConstraints = {
    forbiddenTiles: new Set(),         // "x,y" keys — never walk on these
    deliverBatchSize: null,            // if set N: deliver only when carrying ≥ N parcels
    bonusDeliveryTiles: new Set(),     // preferred delivery targets (e.g. "5x pts")
    zeroValueDeliveryTiles: new Set(), // delivery targets to avoid (e.g. "0 pts")
    maxParcelReward: null,             // if set N: never pick up parcels with reward > N
    relayMode: false,                  // if true: drop parcels here, tell BDI to fetch/deliver
};

// (Challenge 2 - Level 3) LLM is the ORCHESTRATOR: reads NL coordination missions
// and commands the BDI partner via game-chat [COORD].
let llmPartnerPos = null;     // last known partner position (from [COORD] pos)
let llmPartnerId = null;      // BDI partner id (for closest-commits tie-breaking)
let partnerArrived = false;   // partner reached the rendezvous ([COORD] arrived)
let waitingForGo = false;     // waiting for the mission-agent's go signal (red light)
let goSignalReceived = false; // mission-agent sent the go signal

// Parcels the BDI is currently heading for (announced via [BDI] going_for ID).
// Excluded from LLM planning to avoid conflicts. 15 s TTL.
const bdiGoingFor = new Map(); // parcelId → expireAt timestamp
const BDI_CLAIM_TTL_MS = 15000;

// Parcels just dropped for a handoff — ignored for 10 s to give the BDI time
// to claim them and prevent an infinite drop-pickup loop.
const handoffBlacklist = new Map();

let sensingRadius = parseInt(process.env.SENSING_RADIUS ?? '5');

socket.onConnect(() => console.log("[LLM AGENT] Connected to DeliverooJS."));

socket.onConfig((config) => {
    const obs = config?.GAME?.player?.observation_distance;
    if (obs !== undefined) sensingRadius = obs;
});

socket.onYou((data) => {
    me.id    = data.id;
    me.name  = data.name;
    me.x     = data.x;
    me.y     = data.y;
    me.score = data.score;
});

socket.onMap((width, height, tiles) => {
    if (!tiles || typeof tiles[Symbol.iterator] !== 'function') return;
    myBeliefs.updateMap(tiles);
});

socket.onSensing((sensings) => {
    // Guard: onYou has not fired yet — coordinates are null, distances would be NaN.
    if (me.x === null || me.y === null) return;
    myBeliefs.updateSensing(sensings, { x: me.x, y: me.y }, sensingRadius);
});

// ==========================================
// 3. Persistent action history (part of LLM-Memory)
//    Keeps the last 8 outcomes across different objectives.
//    Injected into the system prompt every cycle to prevent repeated mistakes.
// ==========================================
const agentMemory = [];

function addMemory(objectiveSummary, outcome) {
    agentMemory.push(`- "${objectiveSummary}" → ${outcome}`);
    if (agentMemory.length > 8) agentMemory.shift();
}

function getMemoryBlock() {
    if (agentMemory.length === 0) return "";
    return "\n\nMy recent action history (use this to avoid repeating failed actions):\n" + agentMemory.join('\n');
}

// ==========================================
// 4. Tools available to the LLM
// ==========================================

function distance(p1, p2) {
    return Math.abs(Math.round(p1.x) - Math.round(p2.x)) + Math.abs(Math.round(p1.y) - Math.round(p2.y));
}

// Step duration estimate (ms). Used to project decay during travel to a parcel.
const MOVE_DURATION_MS = 500;

/** Estimates a parcel's reward when we arrive, accounting for elapsed decay
 *  since lastSeen and travel decay over distSteps steps. */
function estimateRewardAtArrival(parcel, distSteps) {
    const rate    = myBeliefs.getDecayRatePerMs();
    const elapsed = Date.now() - (parcel.lastSeen ?? Date.now());
    const travel  = distSteps * MOVE_DURATION_MS;
    return Math.max(0, parcel.reward - (elapsed + travel) * rate);
}

/** Parcel utility = estimated_reward_at_arrival² / distance.
 *  Same formula as the BDI agent for cross-agent comparability. */
function parcelUtility(parcel, dist) {
    const rew = estimateRewardAtArrival(parcel, dist);
    return rew > 0 ? (rew * rew) / Math.max(1, dist) : 0;
}

/* (L2) Returns the best delivery zone respecting active mission constraints:
   excludes zero-value tiles, prefers bonus tiles (even if farther), otherwise
   falls back to nearest by Manhattan. Single point of choice — used by both
   fallbackPlan() and the put_down() hint, so fixing it here covers both paths. */
function bestDeliveryZone() {
    const isZero  = z => missionConstraints.zeroValueDeliveryTiles.has(`${Math.round(z.x)},${Math.round(z.y)}`);
    const isBonus = z => missionConstraints.bonusDeliveryTiles.has(`${Math.round(z.x)},${Math.round(z.y)}`);

    const zones = myBeliefs.deliveryZones.filter(z => !isZero(z));
    if (zones.length === 0) return null;

    const nearest = pool => pool.reduce((best, z) => {
        const d  = Math.abs(z.x - me.x) + Math.abs(z.y - me.y);
        const bd = Math.abs(best.x - me.x) + Math.abs(best.y - me.y);
        return d < bd ? z : best;
    });

    const bonusZones = zones.filter(isBonus);
    return bonusZones.length > 0 ? nearest(bonusZones) : nearest(zones);
}

/* safeEvalArithmetic — evaluates an arithmetic expression (+ - * / parentheses)
   WITHOUT eval/Function, using a recursive-descent parser. Used for Challenge 2
   missions ("Calculate 5*5") and coordinates expressed as expressions
   ("x=4*2 y=(1+3)*3"). Throws on malformed input or disallowed characters. */
function safeEvalArithmetic(expr) {
    const s = String(expr).replace(/\s+/g, '');
    if (s === '' || !/^[0-9+\-*/().]+$/.test(s)) throw new Error(`invalid expression: ${expr}`);
    let i = 0;
    const peek = () => s[i];
    const parseExpr = () => {
        let v = parseTerm();
        while (peek() === '+' || peek() === '-') {
            const op = s[i++];
            v = op === '+' ? v + parseTerm() : v - parseTerm();
        }
        return v;
    };
    const parseTerm = () => {
        let v = parseFactor();
        while (peek() === '*' || peek() === '/') {
            const op = s[i++];
            v = op === '*' ? v * parseFactor() : v / parseFactor();
        }
        return v;
    };
    const parseFactor = () => {
        if (peek() === '+') { i++; return parseFactor(); }
        if (peek() === '-') { i++; return -parseFactor(); }
        if (peek() === '(') {
            i++;
            const v = parseExpr();
            if (peek() !== ')') throw new Error('unbalanced parentheses');
            i++;
            return v;
        }
        const start = i;
        while (i < s.length && /[0-9.]/.test(s[i])) i++;
        if (i === start) throw new Error(`number expected: ${expr}`);
        const n = Number(s.slice(start, i));
        if (Number.isNaN(n)) throw new Error(`invalid number: ${expr}`);
        return n;
    };
    const result = parseExpr();
    if (i !== s.length) throw new Error(`unexpected token: ${expr}`);
    if (!Number.isFinite(result)) throw new Error('non-finite result');
    return result;
}

/* Splits "x,y" on the top-level comma only (depth 0), so "(1+3)*3,4*2"
   → ["(1+3)*3", "4*2"] without breaking inner expressions. */
function splitTopComma(str) {
    let depth = 0, parts = [], cur = '';
    for (const ch of String(str)) {
        if (ch === '(') { depth++; cur += ch; }
        else if (ch === ')') { depth--; cur += ch; }
        else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
        else cur += ch;
    }
    parts.push(cur);
    return parts;
}

/* Removes ONE wrapping parenthesis pair from the whole string ("(4,7)" → "4,7")
   while leaving inner parens intact ("(1+3)*3,4" is unchanged). */
function stripWrappingParens(str) {
    let s = String(str).trim();
    while (s.startsWith('(') && s.endsWith(')')) {
        let depth = 0, wraps = true;
        for (let k = 0; k < s.length; k++) {
            if (s[k] === '(') depth++;
            else if (s[k] === ')') { depth--; if (depth === 0 && k < s.length - 1) { wraps = false; break; } }
        }
        if (wraps) s = s.slice(1, -1).trim(); else break;
    }
    return s;
}

/* getMapExtremes — grid bounds and extreme walkable tiles (leftmost/rightmost/
   topmost/bottommost). Used for "drop a package in the leftmost tile" missions.
   Computed once (map is static). */
let _mapExtremes = null;
function getMapExtremes() {
    if (_mapExtremes) return _mapExtremes;
    if (!myBeliefs.map || myBeliefs.map.size === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let left = null, right = null, top = null, bottom = null;
    for (const tile of myBeliefs.map.values()) {
        if (String(tile.type) === '0') continue;       // non percorribile
        const x = Math.round(tile.x), y = Math.round(tile.y);
        if (x < minX) { minX = x; left = { x, y }; }
        if (x > maxX) { maxX = x; right = { x, y }; }
        if (y < minY) { minY = y; bottom = { x, y }; }
        if (y > maxY) { maxY = y; top = { x, y }; }
    }
    if (minX === Infinity) return null;
    _mapExtremes = { minX, maxX, minY, maxY, left, right, top, bottom };
    return _mapExtremes;
}

/* Parses a free-form tile list ("3,4;5,6" or "3,4 5,6") into normalised integer
   "x,y" keys. Used by the L2 mission-constraint tools. */
function parseTileList(spec) {
    const out = [];
    for (const part of String(spec).split(/[;\n]+/)) {
        const m = part.match(/-?\d+\s*,\s*-?\d+/);
        if (!m) continue;
        const [x, y] = m[0].split(',').map(s => Math.round(Number(s.trim())));
        if (Number.isInteger(x) && Number.isInteger(y)) out.push(`${x},${y}`);
    }
    return out;
}

/* Text summary of active L2 mission constraints, injected into LLM-Memory
   so Planner and Replanner know which rules are in force. */
function missionRulesText() {
    const parts = [];
    if (missionConstraints.forbiddenTiles.size > 0)
        parts.push(`NEVER walk on tiles: ${[...missionConstraints.forbiddenTiles].join(' ')} (penalised)`);
    if (missionConstraints.deliverBatchSize)
        parts.push(`Deliver ONLY in stacks of exactly ${missionConstraints.deliverBatchSize} parcels`);
    if (missionConstraints.bonusDeliveryTiles.size > 0)
        parts.push(`PREFER delivering at bonus tiles: ${[...missionConstraints.bonusDeliveryTiles].join(' ')}`);
    if (missionConstraints.zeroValueDeliveryTiles.size > 0)
        parts.push(`NEVER deliver at zero-value tiles: ${[...missionConstraints.zeroValueDeliveryTiles].join(' ')}`);
    if (missionConstraints.maxParcelReward)
        parts.push(`NEVER pick up parcels with reward > ${missionConstraints.maxParcelReward}`);
    return parts.length ? `Active mission rules (enforced):\n  - ${parts.join('\n  - ')}\n` : '';
}

/* (L3) Walkable tile within 'dist' of (cx,cy) that is closest to us (rendezvous target). */
function coordTargetTile(cx, cy, dist) {
    if (distance(me, { x: cx, y: cy }) <= dist) return { x: Math.round(me.x), y: Math.round(me.y) };
    let best = null, bestD = Infinity;
    for (const tile of myBeliefs.map.values()) {
        if (String(tile.type) === '0') continue;
        const tx = Math.round(tile.x), ty = Math.round(tile.y);
        if (Math.abs(tx - cx) + Math.abs(ty - cy) > dist) continue;
        const d = distance(me, { x: tx, y: ty });
        if (d < bestD) { bestD = d; best = { x: tx, y: ty }; }
    }
    return best || { x: cx, y: cy };
}

/* (L3) Nearest walkable tile on an odd-numbered row (red-light/green-light mission). */
function nearestOddRowTile() {
    let best = null, bestD = Infinity;
    for (const tile of myBeliefs.map.values()) {
        if (String(tile.type) === '0') continue;
        const ty = Math.round(tile.y);
        if (ty % 2 === 0) continue;
        const tx = Math.round(tile.x);
        const d = distance(me, { x: tx, y: ty });
        if (d < bestD) { bestD = d; best = { x: tx, y: ty }; }
    }
    return best || { x: Math.round(me.x), y: Math.round(me.y) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* (L3) closest-commits: the parcel belongs to the BDI partner if they are
   strictly closer. Tie-break: lower id wins (exactly one agent handles it).
   Without partner position, we do not filter. */
function partnerOwns(parcel) {
    if (!llmPartnerPos) return false;
    const myDist = distance(me, parcel);
    const partnerDist = Math.abs(Math.round(llmPartnerPos.x) - Math.round(parcel.x))
                      + Math.abs(Math.round(llmPartnerPos.y) - Math.round(parcel.y));
    if (partnerDist < myDist) return true;
    if (partnerDist > myDist) return false;
    return llmPartnerId != null && String(llmPartnerId) < String(me.id);
}

/** Returns a text description of the current environment (the OBSERVATION
 *  component of LLM-Memory from slide 11). Called by buildLLMMemory on every
 *  (re)planning cycle so Planner and Replanner always see fresh state. */
async function get_visible_environment() {
    if (me.x === null) return "Error: agent position not available yet.";

    const parcels = myBeliefs.getAvailableParcels();
    const carried  = myBeliefs.getCarriedParcels(me.id);
    const zones    = myBeliefs.deliveryZones;

    let env = `Position: (${Math.round(me.x)},${Math.round(me.y)}) | Score: ${me.score}`;
    env += ` | Carrying: ${carried.length} parcel(s)`;
    if (carried.length > 0) {
        const totalRew = carried.reduce((s, p) => s + Math.round(p.reward), 0);
        env += ` [~${totalRew} pts total, decaying every second]`;
    }
    env += '\n';

    if (parcels.length > 0) {
        const decayPerStep = Math.round(myBeliefs.getDecayRatePerMs() * MOVE_DURATION_MS * 10) / 10;
        if (decayPerStep > 0) env += `Decay rate: ~${decayPerStep} pts/step\n`;

        // Annotate each parcel with estimated reward and utility, sorted best-first.
        // BDI-claimed parcels are labelled (not filtered) so the LLM can see they exist
        // but knows they are being handled by the partner.
        const annotated = parcels
            .map(p => {
                const d           = distance(me, p);
                const rewArrival  = Math.round(estimateRewardAtArrival(p, d));
                const utility     = Math.round(parcelUtility(p, d));
                return { ...p, d, rewArrival, utility };
            })
            .sort((a, b) => b.utility - a.utility);  // BEST FIRST

        env += `Available parcels (sorted by utility = est_reward²/dist, BEST FIRST):\n`;
        for (const p of annotated) {
            const expiring  = p.rewArrival <= 0 ? ' ⚠ WILL EXPIRE BEFORE ARRIVAL' : '';
            const bdiClaim  = bdiGoingFor.has(p.id) ? ' [BDI partner is heading here — pick a different one]' : '';
            const closer    = partnerOwns(p) ? ' [BDI partner is CLOSER — leave it to them]' : '';
            env += `  [ID:${p.id} at (${Math.round(p.x)},${Math.round(p.y)}) ` +
                   `now:${Math.round(p.reward)}pts est_arrival:~${p.rewArrival}pts ` +
                   `dist:${p.d} utility:${p.utility}]${expiring}${bdiClaim}${closer}\n`;
        }
    } else {
        env += `No parcels visible right now.\n`;
    }

    if (zones.length > 0) {
        const sortedZ = zones.map(z => {
            let tag = '';
            const key = `${Math.round(z.x)},${Math.round(z.y)}`;
            if (missionConstraints.zeroValueDeliveryTiles.has(key)) tag = ' [ZERO VALUE]';
            if (missionConstraints.bonusDeliveryTiles.has(key)) tag = ' [BONUS]';
            return { ...z, d: distance(me, z), tag };
        }).sort((a, b) => a.d - b.d);
        env += `Delivery zones: ` + sortedZ.map(z => `(${Math.round(z.x)},${Math.round(z.y)}) dist=${z.d}${z.tag}`).join(' | ') + '\n';
    }

    const ext = getMapExtremes();
    if (ext) {
        env += `Map bounds: x in [${ext.minX}..${ext.maxX}], y in [${ext.minY}..${ext.maxY}]. ` +
               `Extreme walkable tiles → leftmost:(${ext.left.x},${ext.left.y}) rightmost:(${ext.right.x},${ext.right.y}) ` +
               `topmost:(${ext.top.x},${ext.top.y}) bottommost:(${ext.bottom.x},${ext.bottom.y})\n`;
    }
    env += missionRulesText();   // (L2) active mission constraints (if any)
    env += `BDI partner status: ${lastBdiUpdate}`;
    if (llmPartnerPos) env += ` | BDI position: (${llmPartnerPos.x},${llmPartnerPos.y})`;  // (L3)
    return env;
}

/** Navigates to the given coordinates using A*. Accepts "x,y" or "(x,y)". */
async function navigate_to(coords) {
    // Coordinates may contain arithmetic expressions (L1 missions, e.g.
    // "move to x=4*2 y=(1+3)*3" → LLM passes "4*2,(1+3)*3"). Evaluate safely.
    let parts = splitTopComma(String(coords).trim());
    if (parts.length < 2) parts = splitTopComma(stripWrappingParens(coords)); // es. "(4,7)"
    let x, y;
    try {
        x = Math.round(safeEvalArithmetic(parts[0]));
        y = Math.round(safeEvalArithmetic(parts[1]));
    } catch {
        return `Error: invalid coordinates '${coords}'. Use "x,y" (arithmetic allowed, e.g. "4*2,(1+3)*3").`;
    }

    const goal = { x, y };
    let stepsTaken = 0;

    // Persistent congestion map for this navigation — marks rejected tiles so A*
    // reroutes instead of retrying the same blocked move indefinitely.
    const congestion = new Map();
    // L2 forbidden tiles get a huge penalty so A* routes around them. They remain
    // walkable as a last resort so the agent is never fully stuck.
    for (const key of missionConstraints.forbiddenTiles) {
        congestion.set(key, { penalty: 100000, expireAt: Number.MAX_SAFE_INTEGER });
    }
    let consecutiveRejects = 0;
    const MAX_REJECTS = 5;   // dopo tot rifiuti di fila, dichiariamo il blocco

    while (distance(me, goal) > 0) {

        const agents = myBeliefs.getOtherAgentPositions(me.id);

        // If the goal tile is occupied by another agent and we are already adjacent,
        // we can never enter — return immediately rather than accumulating penalties.
        const goalOccupied = agents.some(a => Math.round(a.x) === x && Math.round(a.y) === y);
        if (goalOccupied && distance(me, goal) <= 1) {
            return `Blocked: tile ${x},${y} is occupied by another agent. Now at ${Math.round(me.x)},${Math.round(me.y)}.`;
        }

        const path = Planner.getPath(
            me, goal, myBeliefs.map,
            agents, [], congestion,
            myBeliefs.getCrateKeys(), myBeliefs.deliveryZones
        );
        if (!path || path.length === 0) {
            return `Failed: no path to ${x},${y}. Currently at ${Math.round(me.x)},${Math.round(me.y)}.`;
        }

        const result = await socket.emitMove(path[0]);
        if (result) {
            me.x = result.x;
            me.y = result.y;
            stepsTaken++;
            consecutiveRejects = 0;

            // Opportunistic pickup: if we step on an available parcel, collect it
            // for free (zero LLM calls). Maximises parcels per trip beyond the plan.
            // Disabled when deliverBatchSize is active (would exceed the exact stack).
            // maxParcelReward guard: a prohibited parcel collected by accident would
            // taint the entire delivery and yield zero reward.
            const here = missionConstraints.deliverBatchSize ? null : myBeliefs.getAvailableParcels().find(
                p => Math.round(p.x) === Math.round(me.x) && Math.round(p.y) === Math.round(me.y) &&
                     (!missionConstraints.maxParcelReward || p.reward <= missionConstraints.maxParcelReward)
            );
            if (here) {
                const got = await socket.emitPickup();
                if (got && got.length > 0) {
                    console.log(`[OPPORTUNISTIC] Picked up ${got.length} parcel(s) en route at (${Math.round(me.x)},${Math.round(me.y)}).`);
                }
            }

            if (stepsTaken > 200) return `Stopped: path exceeded 200 steps. Now at ${Math.round(me.x)},${Math.round(me.y)}.`;
        } else {
            // Move rejected: mark the blocked tile so A* reroutes next iteration.
            // Give up only after MAX_REJECTS consecutive rejections (stable block).
            let bx = Math.round(me.x), by = Math.round(me.y);
            if (path[0] === 'right') bx++; else if (path[0] === 'left') bx--;
            else if (path[0] === 'up') by++; else if (path[0] === 'down') by--;
            congestion.set(`${bx},${by}`, { penalty: 100, expireAt: Date.now() + 5000 });

            if (++consecutiveRejects >= MAX_REJECTS) {
                return `Move ${path[0]} rejected ${MAX_REJECTS}x. Path persistently blocked near ${Math.round(me.x)},${Math.round(me.y)}.`;
            }
        }
    }
    return `Arrived at ${x},${y}.`;
}

/** Picks up all parcels on the current tile. */
async function pick_up() {
    if (missionConstraints.deliverBatchSize) {
        const carried = myBeliefs.getCarriedParcels(me.id).length;
        if (carried >= missionConstraints.deliverBatchSize) {
            return `Failed: already carrying ${carried} parcels, which satisfies the exact batch of ${missionConstraints.deliverBatchSize}. Drop them at delivery first.`;
        }
    }
    const picked = await socket.emitPickup();
    if (picked && picked.length > 0) return `Picked up ${picked.length} parcel(s).`;
    return `Failed: no parcel on this tile (${Math.round(me.x)},${Math.round(me.y)}).`;
}

/** Drops all carried parcels. Scores points only on a delivery-zone tile. */
async function put_down() {
    const cx = Math.round(me.x), cy = Math.round(me.y);
    const onDelivery = myBeliefs.deliveryZones.some(z => Math.round(z.x) === cx && Math.round(z.y) === cy);
    if (!onDelivery) {
        const nearest = bestDeliveryZone();
        const hint = nearest ? ` Navigate to (${Math.round(nearest.x)},${Math.round(nearest.y)}) first.` : "";
        return `Error: not on a delivery zone (at ${cx},${cy}).${hint}`;
    }
    // Exact-batch constraint: block delivery until we carry enough parcels.
    if (missionConstraints.deliverBatchSize) {
        const n = myBeliefs.getCarriedParcels(me.id).length;
        if (n < missionConstraints.deliverBatchSize) {
            return `Holding for batch: mission requires stacks of ${missionConstraints.deliverBatchSize}, carrying ${n}. Pick up more before delivering.`;
        }
    }
    await socket.emitPutdown();
    return `Parcels delivered successfully. Points scored!`;
}

/** Sends a coordination message to the BDI partner.
 *  The BDI reads "[LLM] taking parcel ID" and blacklists that parcel. */
async function send_message_to_partner(message) {
    console.log(`---- SEND MSG: ${message} ----`);
    await socket.emitShout(`[LLM] ${message}`);
    return "Message sent to BDI partner.";
}

/** (Challenge 2 - Level 1) Evaluates an arithmetic expression.
 *  Standard "calculate" tool for requests like "Calculate 5*5". */
async function calculate(expression) {
    console.log(`---- CALCULATE ${expression} ----`);
    try {
        return `Result: ${safeEvalArithmetic(expression)}`;
    } catch {
        return `Error: cannot evaluate '${expression}'.`;
    }
}

/** (Challenge 2 - Level 1) Sends a text answer to whoever sent the current request.
 *  Uses emitSay to activeSenderId (falls back to broadcast if no sender).
 *  We use emitSay rather than replyCallback because the server-side ack expires
 *  in ~1 s — too short for an LLM response to arrive. */
async function reply_to_sender(message) {
    console.log(`---- REPLY TO ${activeSenderId ?? '(broadcast)'}: ${message} ----`);
    if (activeSenderId) {
        await socket.emitSay(activeSenderId, message);
        return `Answer sent to the requester.`;
    }
    await socket.emitShout(message);
    return `No specific requester; broadcasted the answer.`;
}

/** (Challenge 2) Drops parcels on the CURRENT tile with no delivery-zone check.
 *  Special missions ("drop a package in the leftmost tile") award points
 *  externally. Normal scored delivery still uses put_down. */
async function drop_here() {
    await socket.emitPutdown();
    return `Dropped parcels at (${Math.round(me.x)},${Math.round(me.y)}).`;
}

/* missionConstraints lives here only; the BDI doesn't know until we tell it.
   We serialise a complete SNAPSHOT (not a diff) into a single [COORD] rules
   message — self-correcting if a message is dropped. Sent on every rule change
   and on the periodic heartbeat for resilience (late-joining partner). */
/** Sends a coordination message to the BDI partner.
 *  Uses emitSay when partner id is known (bypasses SHOUT_DISTANCE); falls back
 *  to emitShout otherwise. */
async function emitCoordMessage(msg) {
    if (llmPartnerId) {
        await socket.emitSay(llmPartnerId, msg);
    } else {
        await socket.emitShout(msg);
    }
}

function broadcastTeamRules() {
    const parts = [
        `avoid=${[...missionConstraints.forbiddenTiles].join(';')}`,
        `batch=${missionConstraints.deliverBatchSize ?? ''}`,
        `bonus=${[...missionConstraints.bonusDeliveryTiles].join(';')}`,
        `zero=${[...missionConstraints.zeroValueDeliveryTiles].join(';')}`,
        `maxreward=${missionConstraints.maxParcelReward ?? ''}`,
    ];
    emitCoordMessage(`[COORD] rules ${parts.join(' ')}`);
}

/** (Challenge 2 - Level 2) Persistently forbids walking on the listed tiles.
 *  Navigation routes around them. Empty arg clears. */
async function avoid_tiles(spec) {
    const tiles = parseTileList(spec);
    missionConstraints.forbiddenTiles = new Set(tiles);
    console.log(`---- AVOID TILES: ${tiles.join(' ') || '(cleared)'} ----`);
    broadcastTeamRules();
    return tiles.length ? `Navigation will now avoid tiles: ${tiles.join(' ')}.` : `Forbidden tiles cleared.`;
}

/** (Challenge 2 - Level 2) Persistently requires delivering in stacks of exactly N
 *  parcels. "0" or empty clears. */
async function set_delivery_batch(n) {
    const v = parseInt(String(n).match(/\d+/)?.[0] ?? '', 10);
    missionConstraints.deliverBatchSize = (Number.isInteger(v) && v > 0) ? v : null;
    console.log(`---- SET DELIVERY BATCH: ${missionConstraints.deliverBatchSize ?? '(cleared)'} ----`);
    broadcastTeamRules();
    return missionConstraints.deliverBatchSize
        ? `Delivery batch set: will only deliver stacks of exactly ${v}.`
        : `Delivery batch cleared.`;
}

/** (Challenge 2 - Level 2) Persistently prefers the listed delivery tiles over
 *  plain nearby zones. Empty arg clears. The multiplier is not computed here —
 *  it is a preference signal for bestDeliveryZone(). */
async function set_delivery_bonus(spec) {
    const tiles = parseTileList(spec);
    missionConstraints.bonusDeliveryTiles = new Set(tiles);
    console.log(`---- SET DELIVERY BONUS: ${tiles.join(' ') || '(cleared)'} ----`);
    broadcastTeamRules();
    return tiles.length ? `Will prefer delivering at: ${tiles.join(' ')}.` : `Bonus delivery tiles cleared.`;
}

/** (Challenge 2 - Level 2) Persistently excludes the listed tiles as delivery
 *  targets. Tiles remain walkable — they are just never chosen by bestDeliveryZone().
 *  Empty arg clears. */
async function set_zero_value_tiles(spec) {
    const tiles = parseTileList(spec);
    missionConstraints.zeroValueDeliveryTiles = new Set(tiles);
    console.log(`---- SET ZERO VALUE TILES: ${tiles.join(' ') || '(cleared)'} ----`);
    broadcastTeamRules();
    return tiles.length ? `Will avoid delivering at: ${tiles.join(' ')}.` : `Zero-value delivery tiles cleared.`;
}

/** (Challenge 2 - Level 2) Persistently prevents picking up parcels with reward
 *  above N. One over-reward parcel taints the whole stack to zero — safer to
 *  never pick it up. "0" or empty clears. */
async function set_max_parcel_reward(n) {
    const v = parseFloat(String(n).match(/-?\d+(\.\d+)?/)?.[0] ?? '');
    missionConstraints.maxParcelReward = (!isNaN(v)) ? v : null;
    console.log(`---- SET MAX PARCEL REWARD: ${missionConstraints.maxParcelReward ?? '(cleared)'} ----`);
    broadcastTeamRules();
    return missionConstraints.maxParcelReward
        ? `Will avoid picking up parcels with reward > ${v}.`
        : `Max parcel reward cleared.`;
}

/** (Challenge 2 - Level 2) Clears all active enforced mission constraints. */
async function clear_mission_rules() {
    missionConstraints.forbiddenTiles = new Set();
    missionConstraints.deliverBatchSize = null;
    missionConstraints.bonusDeliveryTiles = new Set();
    missionConstraints.zeroValueDeliveryTiles = new Set();
    missionConstraints.maxParcelReward = null;
    missionConstraints.relayMode = false;
    console.log("---- CLEAR MISSION RULES ----");
    broadcastTeamRules();
    return `All enforced mission rules cleared.`;
}

/** (L3) RENDEZVOUS: commands the BDI via [COORD] goto_wait, moves ourselves
 *  within 'dist' of (x,y), waits for both to arrive, then releases.
 *  Mission: "move both agents near (x,y) within distance D and wait for each other". */
async function rendezvous(spec) {
    const nums = String(spec).match(/-?\d+/g) || [];
    if (nums.length < 2) return `Error: rendezvous needs "x,y[,dist]".`;
    const x = +nums[0], y = +nums[1], dist = nums.length >= 3 ? Math.max(0, +nums[2]) : 1;
    console.log(`---- RENDEZVOUS (${x},${y}) dist ${dist} ----`);
    partnerArrived = false;
    await emitCoordMessage(`[COORD] goto_wait ${x} ${y} ${dist}`);    // command BDI partner
    const t = coordTargetTile(x, y, dist);
    await navigate_to(`${t.x},${t.y}`);                              // position ourselves
    await emitCoordMessage('[COORD] arrived');
    for (let i = 0; i < 150 && !partnerArrived; i++) await sleep(200); // wait max ~30 s
    await emitCoordMessage('[COORD] release');                        // both free to resume
    return partnerArrived
        ? `Rendezvous reached near (${x},${y}); both agents gathered.`
        : `Reached (${x},${y}); partner did not arrive in time (released).`;
}

/** (L3) HANDOFF: drops currently carried parcels here and tells the BDI partner
 *  to fetch and deliver them. For "a parcel picked up by one agent and delivered
 *  by the other" missions. Only LLM→BDI direction is implemented: the LLM is the
 *  natural initiator because it is the one parsing natural-language missions. */
async function handoff_to_partner() {
    missionConstraints.relayMode = true;
    await emitCoordMessage(`[COORD] rules relay=1`); // puts BDI in clean-relay mode

    const carried = myBeliefs.getCarriedParcels(me.id);   // read BEFORE the drop
    if (carried.length === 0) {
        return `Relay mode active. From now on, you will not deliver parcels yourself. (Currently not carrying any parcel to drop).`;
    }

    if (llmPartnerPos) {
        // Meet at the midpoint between the two agents.
        let midX = Math.round((me.x + llmPartnerPos.x) / 2);
        let midY = Math.round((me.y + llmPartnerPos.y) / 2);
        
        let bestTile = {x: midX, y: midY};
        let bestDist = Infinity;
        for (const [key, t] of myBeliefs.map.entries()) {
            if (!t.walkable) continue;
            if (myBeliefs.deliveryZones.some(dz => dz.x === t.x && dz.y === t.y)) continue;
            const d = Math.abs(t.x - midX) + Math.abs(t.y - midY);
            if (d < bestDist) {
                bestDist = d;
                bestTile = t;
            }
        }

        console.log(`---- RELAY MEET: heading to midpoint (${bestTile.x},${bestTile.y}), calling BDI ----`);
        await emitCoordMessage(`[COORD] rendezvous ${bestTile.x} ${bestTile.y}`);
        await navigate_to(`${bestTile.x},${bestTile.y}`);
        await emitCoordMessage('[COORD] release');
    }

    const x = Math.round(me.x), y = Math.round(me.y);
    await socket.emitPutdown();
    const expireTime = Date.now() + 10000; // ignore dropped parcels for 10 s
    for (const p of carried) {
        handoffBlacklist.set(p.id, expireTime);
        await emitCoordMessage(`[COORD] fetch ${p.id} ${x} ${y}`);
    }
    console.log(`---- HANDOFF: dropped ${carried.length} parcel(s) at (${x},${y}), told BDI partner to fetch ----`);
    return `Relay mode active. Met partner, dropped ${carried.length} parcel(s) at (${x},${y}) and told the BDI partner to fetch and deliver them.`;
}

/** (L3) RED LIGHT / GREEN LIGHT: moves both agents to an odd-numbered row,
 *  then waits for the mission-agent's "go"/"green" signal before resuming. */
async function red_light_green_light() {
    console.log('---- RED LIGHT / GREEN LIGHT ----');
    await emitCoordMessage('[COORD] oddrow');            // command partner to odd row
    const t = nearestOddRowTile();
    await navigate_to(`${t.x},${t.y}`);
    waitingForGo = true; goSignalReceived = false;
    console.log('[COORD] on odd row, waiting for go signal...');
    for (let i = 0; i < 600 && !goSignalReceived; i++) await sleep(200); // max ~120s
    waitingForGo = false;
    await emitCoordMessage('[COORD] release');           // si riparte
    return goSignalReceived ? `Go signal received — resuming.` : `Timed out waiting for go — resuming.`;
}

/** (L3) Releases the partner from any active coordination and resumes normal play. */
async function end_coordination() {
    await emitCoordMessage('[COORD] release');
    return `Coordination ended; partner resumes normal play.`;
}

// ==========================================
// 5. LLM model call helper
// ==========================================
async function callModel(messages) {
    const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0,
    });
    return response.choices?.[0]?.message?.content ?? "";
}

// ==========================================
// 5b. TOOL CATALOG  (see slide 11 and 13: "consulting a catalog of
//     available tools" / "the list of tools is predefined")
//
// Each tool has: name, arg description, text description (shown to the LLM
// in LLM-Memory), and the implementation function.
// `get_visible_environment` is NOT here — the environment observation is
// already injected into memory on every (re)planning cycle, so the LLM does
// not need to spend an action to obtain it.
// ==========================================
const TOOL_CATALOG = [
    { name: 'navigate_to', args: 'x,y',
      desc: 'Move to grid coordinates via A* pathfinding (handles the multi-step path automatically). Returns "Arrived ..." on success.',
      fn: navigate_to },
    { name: 'pick_up', args: '(none)',
      desc: 'Pick up every parcel on the current tile. Returns "Picked up N parcel(s)" or "Failed: no parcel".',
      fn: pick_up },
    { name: 'put_down', args: '(none)',
      desc: 'Drop all carried parcels. Scores points ONLY on a delivery-zone tile, otherwise returns an error with a hint.',
      fn: put_down },
    { name: 'send_message_to_partner', args: 'message',
      desc: 'Send a coordination message to the BDI partner agent (e.g. "taking parcel ID") so it avoids the same parcel.',
      fn: send_message_to_partner },
    { name: 'calculate', args: 'expression',
      desc: 'Evaluate an arithmetic expression (e.g. "5*5", "(1+3)*3"). Returns "Result: N". Use for calculation requests.',
      fn: calculate },
    { name: 'reply_to_sender', args: 'message',
      desc: 'Send a text answer back to whoever sent the current request/mission (e.g. answer "What is the capital of Italy?" with "Rome", or report a computed result). Use for questions/calculations — no movement needed.',
      fn: reply_to_sender },
    { name: 'drop_here', args: '(none)',
      desc: 'Put down carried parcels on the CURRENT tile, with NO delivery-zone check. Use for missions like "drop a package in tile X" (normal scoring delivery still uses put_down).',
      fn: drop_here },
    { name: 'avoid_tiles', args: 'x,y;x,y',
      desc: 'Persistently forbid walking over the listed tiles (navigation routes around them). For "do not go through tile (x,y)" missions. Empty arg clears it.',
      fn: avoid_tiles },
    { name: 'set_delivery_batch', args: 'N',
      desc: 'Persistently require delivering only in stacks of exactly N parcels (put_down is blocked until you carry N; opportunistic pickups pause). "0" clears it.',
      fn: set_delivery_batch },
    { name: 'set_delivery_bonus', args: 'x,y;x,y',
      desc: 'Persistently prefer delivering at the listed tiles over a merely-closer plain delivery zone. For "deliver in (x1,y1) [or (x2,y2)] you get Nx pts" missions. Empty arg clears it.',
      fn: set_delivery_bonus },
    { name: 'set_zero_value_tiles', args: 'x,y;x,y',
      desc: 'Persistently avoid the listed tiles as a delivery target (still walkable, just never chosen to deliver at). For "deliver in (x,y) you get 0 pts" missions. Empty arg clears it.',
      fn: set_zero_value_tiles },
    { name: 'set_max_parcel_reward', args: 'N',
      desc: 'Persistently avoid deliberately picking up parcels with reward above N. For "if you deliver parcels with score higher than N, you get no reward" missions. "0" clears it.',
      fn: set_max_parcel_reward },
    { name: 'clear_mission_rules', args: '(none)',
      desc: 'Clear all enforced mission rules (forbidden tiles, delivery batch, delivery bonus/zero-value tiles, max parcel reward).',
      fn: clear_mission_rules },
    { name: 'rendezvous', args: 'x,y,dist',
      desc: 'Coordinate a meet-up: command the BDI partner AND move yourself within <dist> of (x,y), then both wait for each other. For "move both agents near (x,y) and wait" missions.',
      fn: rendezvous },
    { name: 'handoff_to_partner', args: '(none)',
      desc: 'Drop your currently carried parcel(s) here and tell the BDI partner to fetch and deliver them. For "a parcel picked up by one agent and delivered by the other" missions.',
      fn: handoff_to_partner },
    { name: 'red_light_green_light', args: '(none)',
      desc: 'Red-light/green-light mission: send both agents to an odd-numbered row, then wait for the mission sender\'s "go"/"green" message before resuming.',
      fn: red_light_green_light },
    { name: 'end_coordination', args: '(none)',
      desc: 'Release the BDI partner from any active coordination and resume normal play.',
      fn: end_coordination },
];

// name → function map used by the executor to dispatch plan actions.
const TOOLS = Object.fromEntries(TOOL_CATALOG.map(t => [t.name, t.fn]));

/** Catalogo dei tool in formato testuale, incluso nella LLM-Memory (slide 11). */
function getToolCatalogText() {
    return TOOL_CATALOG.map(t => `  - ${t.name}(${t.args}): ${t.desc}`).join('\n');
}

/** Extracts the PLAN from the LLM response (slide 12 — "PLAN (a1, a2, ..., aN)").
 *  Expected format:
 *    Plan: {"actions": [ {"tool":"navigate_to","args":"5,7"}, {"tool":"pick_up"}, ... ]}
 *  Returns null on parse failure (caller uses deterministic fallback). */
function parsePlan(text) {
    const match = text.match(/\{[\s\S]*\}/);   // primo oggetto JSON nella risposta
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        const actions = Array.isArray(obj.actions)
            ? obj.actions
                .filter(a => a && typeof a.tool === 'string')
                .map(a => ({ tool: a.tool.trim(), args: a.args != null ? String(a.args).trim() : '' }))
            : [];

        // Optional persistent strategy directive (Challenge 2 - Level 2).
        // JSON conventions:
        //   "strategy": "<string>" → set/update the persistent strategy
        //   "strategy": null       → clear it (back to default behaviour)
        //   key absent             → strategy unchanged
        const hasStrategy = Object.prototype.hasOwnProperty.call(obj, 'strategy');

        // Empty actions + valid JSON = intentional DECLINE by the LLM
        // (e.g. negative-reward mission rejected). Distinguished from a parse
        // failure (null) so the executor does NOT fall back to fallbackPlan.
        if (actions.length === 0 && !hasStrategy) {
            return { actions: [], declined: true };
        }

        const result = { actions };
        if (hasStrategy) {
            result.strategy = (typeof obj.strategy === 'string' && obj.strategy.trim())
                ? obj.strategy.trim()
                : null;
        }
        return result;
    } catch {
        return null;
    }
}

/** Deterministic fallback plan: used when the LLM produces no valid plan.
 *  Picks the top-4 parcels by utility then delivers to the nearest zone.
 *  Respects deliverBatchSize: only plans delivery once the pickup count will
 *  satisfy the batch. Navigates to the nearest spawn zone when no parcels
 *  are visible and the batch is not yet met. */
function fallbackPlan() {
    const actions = [];
    const carried = myBeliefs.getCarriedParcels(me.id);
    const batchN  = missionConstraints.deliverBatchSize;

    let maxToPick = 4;
    if (batchN) {
        maxToPick = Math.max(0, batchN - carried.length);
    } else if (missionConstraints.relayMode) {
        // In relay mode, pick at most 1 parcel at a time to hand off immediately.
        maxToPick = carried.length > 0 ? 0 : 1;
    }

    const top = myBeliefs.getAvailableParcels()
        .filter(p => !bdiGoingFor.has(p.id))
        .filter(p => !(handoffBlacklist.get(p.id) > Date.now())) // skip recently handed off to BDI
        .filter(p => !partnerOwns(p))           // (L3) closest-commits
        .map(p => {
            const d = distance(me, p);
            const estRew = estimateRewardAtArrival(p, d);
            const valid = !missionConstraints.maxParcelReward || estRew <= missionConstraints.maxParcelReward;
            return { ...p, d, u: valid ? parcelUtility(p, d) : 0 };
        })
        .filter(p => p.u > 0)
        .sort((a, b) => b.u - a.u)
        .slice(0, maxToPick);

    for (const p of top) {
        actions.push({ tool: 'navigate_to', args: `${Math.round(p.x)},${Math.round(p.y)}` });
        actions.push({ tool: 'pick_up', args: '' });
    }

    const willCarry = top.length + carried.length;
    // Deliver only if the batch will be satisfied after the planned pickups.
    const batchOk = !batchN || willCarry >= batchN;

    if (willCarry > 0 && batchOk) {
        if (missionConstraints.relayMode && carried.length > 0) {
            // Persistent relay mode: hand off as soon as we have parcels.
            actions.push({ tool: 'handoff_to_partner', args: '' });
        } else if (!missionConstraints.relayMode) {
            const z = bestDeliveryZone();
            if (z) {
                actions.push({ tool: 'navigate_to', args: `${Math.round(z.x)},${Math.round(z.y)}` });
                actions.push({ tool: 'put_down', args: '' });
            }
        }
    } else if (willCarry > 0 && !batchOk) {
        // Carrying parcels but not enough for the batch. If no visible pickups
        // remain (top=0), head to the nearest spawn to find more; otherwise the
        // pickup loop above already added them to the plan.
        if (top.length === 0) {
            const spawns = myBeliefs.spawnZones || [];
            if (spawns.length > 0) {
                const nearest = spawns
                    .map(s => ({ ...s, d: distance(me, s) }))
                    .sort((a, b) => a.d - b.d)[0];
                actions.push({ tool: 'navigate_to', args: `${Math.round(nearest.x)},${Math.round(nearest.y)}` });
            }
        }
    }

    return { actions };
}



/** Returns true if the tool observation indicates success. Used by the executor
 *  to decide whether to proceed or trigger the Replanner. */
function isActionSuccessful(tool, observation) {
    switch (tool) {
        case 'navigate_to': return observation.startsWith('Arrived');
        case 'pick_up':     return observation.startsWith('Picked');
        case 'put_down':    return observation.startsWith('Parcels delivered');
        default:            return true;   // send_message_to_partner ecc.
    }
}

/** Returns true if a failed observation is NON-FATAL (should not trigger the
 *  LLM Replanner). "Holding for batch" is expected — the batch is not yet met,
 *  not a navigation error. The next fallbackPlan will pick up more parcels. */
function isNonFatalFailure(tool, observation) {
    if (tool === 'put_down' && observation.startsWith('Holding for batch')) return true;
    return false;
}

// ==========================================
// COMPONENT A: LLM-Memory   (slide 11: "Update the context")
//
// The LLM's context. Slide 11 requires the memory to aggregate three sources,
// rebuilt dynamically because environment and objectives change:
//   1. OBJECTIVE (natural language or structured) — to interpret
//   2. OBSERVATION (get_visible_environment) + BDI beliefs (lastBdiUpdate)
//   3. TOOL CATALOG (getToolCatalogText)
// Plus cross-objective persistent history (getMemoryBlock).
// ==========================================
async function buildLLMMemory(objective) {
    const environment = await get_visible_environment();   // observation + BDI state
    return {
        objective,                              // (1) objective to interpret
        environment,                            // (2) environment + BDI beliefs
        toolCatalog:      getToolCatalogText(), // (3) tool catalog
        memoryBlock:      getMemoryBlock(),     // cross-objective history
        // (L2) Persistent strategy directive — injected into EVERY cycle so
        // both Planner and Replanner respect it.
        strategyBlock:    currentStrategy
            ? `\n\nStanding strategy directive (respect it in EVERY plan): ${currentStrategy}`
            : '',
        objectiveSummary: objective.substring(0, 80).replace(/\n/g, ' ')
    };
}

// ==========================================
// COMPONENTS B / C: LLM-Planner / LLM-Replanner   [llmPlan]
//
// A single LLM call turns objective + memory into a PLAN (ordered tool sequence
// a1..aN). Planning the whole trip at once lets the LLM reason about the full
// route and collect more parcels per trip (vs. the old step-by-step ReAct which
// delivered too early).
//
//   - Without `replanNote` → LLM-Planner : plan from scratch for the new objective.
//   - With    `replanNote` → LLM-Replanner: refine the plan after a surprise
//                                            (action failed or world changed).
//
// Handles both STRUCTURED objectives (autonomous game state) and NATURAL LANGUAGE
// objectives received via message (slide 11).
// ==========================================

const PLANNER_PROMPT = `
You are the PLANNER and REPLANNER of an LLM-based agent in DeliverooJS, a grid delivery game.
You cooperate with a BDI partner agent. Overall goal: maximise points by collecting parcels and
delivering them to a delivery zone.

Your job: read the OBJECTIVE (it may be a structured game state OR a free-form natural-language
instruction), reason over the provided MEMORY (environment + tool catalog), and output a PLAN —
an ORDERED sequence of tool actions a1, a2, ..., aN. A fast engine then executes the actions in
order; it will ask you to REPLAN if an action fails or the world changes.

Each visible parcel in the environment is already annotated:
  - utility = est_reward_at_arrival² / distance   (HIGHER = better choice)
  - dist    = steps away
  - marks:  "WILL EXPIRE" (worth 0 on arrival)  |  "BDI partner is heading here"

OUTPUT EXACTLY this — nothing after the Plan line:
Thought: <1-2 sentences: how you interpret the objective and the route/actions you chosen>
Plan: {"actions": [ {"tool":"navigate_to","args":"5,7"}, {"tool":"pick_up","args":""}, {"tool":"navigate_to","args":"0,0"}, {"tool":"put_down","args":""} ], "strategy": null}

PLANNING RULES:
- Use ONLY tools from the catalog in memory. "args" is the tool argument as a string ("" if none).
- COLLECT MULTIPLE PARCELS PER TRIP: chain several navigate_to + pick_up before the final
  navigate_to(delivery) + put_down. One trip carrying 3-4 parcels beats 3-4 separate trips.
- Prefer high-utility parcels; order pickups to minimise total travel (roughly nearest-neighbour).
- NEVER plan a pickup for a parcel marked "WILL EXPIRE" or "BDI partner is heading here".
- To score, navigate_to a delivery-zone tile and THEN put_down. When choosing a delivery zone from the environment: NEVER pick one marked [ZERO VALUE], and ALWAYS prefer one marked [BONUS] over plain ones, even if further away.
- You MAY send_message_to_partner("taking parcel ID") to claim a parcel so the BDI avoids it.
- If the objective is a natural-language instruction (e.g. "go to 3,4", "deliver everything now"),
  translate it directly into the matching tool actions.
- STANDING STRATEGY (persists across turns): the memory may include a "Standing strategy directive".
  You MUST respect it in every plan you produce, until it is changed or cleared.
- "strategy" field in the plan output:
  • OMIT the "strategy" key entirely from the JSON if you want to keep the current standing strategy unchanged.
  • For a request that changes FUTURE behaviour across turns (e.g. "from now on prioritise
    high-value parcels", "explore the east side"): set "strategy" to a SHORT imperative string.
  • To explicitly clear the active strategy ("back to normal", "resume", "clear rules"): set "strategy": null.
  • IMPORTANT: setting a "strategy" string is a memo for future turns — it does NOT replace calling
    the required L2 tool. If a mission requires avoid_tiles / set_delivery_batch / etc., you MUST
    include those tool calls in "actions" AND ALSO set "strategy" for the memo.
- COORDINATES MAY BE EXPRESSIONS: for "move to x=4*2 y=(1+3)*3" pass navigate_to args "4*2,(1+3)*3"
  (navigate_to evaluates the arithmetic itself).
- QUESTIONS / CALCULATIONS (e.g. "What is the capital of Italy?", "Calculate 5*5"):
  Answer with a SINGLE reply_to_sender action. Compute the value yourself and embed it directly in
  args — do NOT use calculate() followed by reply_to_sender with a placeholder like $result or
  {value}. Example: reply_to_sender("The result of 5*5 is 25"). Do not move.
- "leftmost / rightmost / top / bottom tile" refer to the extreme walkable tiles listed in the
  environment (Map bounds line).
- To DROP parcels on a specific NON-delivery tile (e.g. "drop a package in the leftmost tile"),
  navigate there then use drop_here (drops ALL carried parcels). put_down is only for normal
  scoring on a delivery-zone tile.
- PENALTY AVOIDANCE — when a mission states a PENALTY for something that might happen naturally
  (not a reward for a deliberate action), you MUST actively defend with the matching tool.
  Do NOT return an empty plan for these — return an actions list with the constraint tool:
  • "do not go through tile (x,y) or you lose pts" → avoid_tiles("x,y") — A* will route around it.
  • "if you deliver parcels with score > K, you get no reward" → set_max_parcel_reward(K) — never
    picks up parcels above K (carrying one taints the whole stack and yields zero reward).
  • "delivering in (x,y) gives 0 pts" or "you get 0.3x" → set_zero_value_tiles / set_delivery_bonus.
  Set "strategy" with a human-readable summary of the active constraint so future plans respect it.
- PERSISTENT L2 RULES — use these tools so the constraint is ENFORCED for the whole match:
  • "do not go through / avoid tile (x,y)" → avoid_tiles("x,y").
  • "deliver (only) stacks of exactly N parcels" → set_delivery_batch(N).
  • "deliver in (x1,y1) [or (x2,y2)] you get Nx pts" → set_delivery_bonus("x1,y1;x2,y2").
  • "deliver in (x,y) you get 0 pts" → set_zero_value_tiles("x,y").
  • "if you deliver parcels with score higher than K, you get no reward" → set_max_parcel_reward(K).
  • To cancel ALL of the above rules → clear_mission_rules.
- MISSION DECLINE — return {"actions": []} ONLY when the mission explicitly offers a reward for an
  action that is NEGATIVE or clearly not worth doing (e.g. "move to X to get -10pts"). This is
  different from penalty avoidance (see above). You MAY add a reply_to_sender explaining why.
- LEVEL-3 COORDINATION missions (you ORCHESTRATE the BDI partner via tools, single-action plans):
  • "move both agents near (x,y) within distance D and wait for each other" → rendezvous("x,y,D").
  • "red light / green light: move to an odd row and wait for our message before moving again" →
    red_light_green_light().
  • "a parcel picked up by one agent must be delivered by the other" → if you are or will be
    carrying a parcel, handoff_to_partner() (drops it here and tells the BDI partner to fetch and
    deliver it).
  • call end_coordination to release the partner when a coordination is over.
- Keep the plan concise and achievable with the CURRENT environment; rely on REPLAN for surprises.
`.trim();

/** Single LLM call for both Planner (no replanNote) and Replanner (with replanNote). */
async function llmPlan(memory, replanNote = null) {
    const messages = [
        { role: "system", content: PLANNER_PROMPT + memory.strategyBlock + memory.memoryBlock },
        { role: "user",   content:
            (replanNote ? `REPLANNING — the situation changed during execution: ${replanNote}\n\n` : '') +
            `Objective:\n${memory.objective}\n\n` +
            `Available tools (catalog):\n${memory.toolCatalog}\n\n` +
            `Current environment:\n${memory.environment}\n\n` +
            `Produce the plan now.`
        }
    ];

    const response = await callModel(messages);
    console.log(`[${replanNote ? 'LLM-REPLANNER' : 'LLM-PLANNER'}]:\n${response}`);

    let plan = parsePlan(response);
    if (!plan) {
        console.log('[PLANNER] Could not parse plan → deterministic utility-based fallback.');
        plan = fallbackPlan();
    }
    return plan;
}

// ==========================================
// EXECUTOR (slide 12, "Exec" block) — ZERO LLM calls
//
// The actual execution loop (iterate a1..aN, dispatch to tools, evaluate result,
// switch from deterministic to LLM plan mid-flight, trigger Replanner on failure)
// is inlined in runAgentTurn below — a monolithic executePlan would not allow
// swapping the active plan without restarting from the top.
// ==========================================
const MAX_ACTIONS_PER_PLAN = 30;   // guardia anti-loop

// ==========================================
// Orchestrator: runAgentTurn   (PLAN-AND-EXECUTE)
//
//   [A]  LLM-Memory   : buildLLMMemory(objective)
//   [B]  LLM-Planner  : llmPlan(memory)               (1 call)
//        Executor A*  : action loop                   (0 calls)
//   [C]  LLM-Replanner: llmPlan(memory, reason)        (only on failure)
//
// Typical cost: 1 LLM call per complete trip.
// ==========================================
let isProcessing = false;
const MAX_REPLANS = 3;

/** Rende leggibile un piano come "tool(args) → tool(args)" per i log. */
function planStr(plan) {
    return plan.actions.map(a => a.tool + (a.args ? `(${a.args})` : '')).join(' → ');
}

/**
 * Orchestratore PLAN-AND-EXECUTE con avvio IBRIDO.
 *
 * @param {string}  objective  obiettivo (game-state strutturato o istruzione NL)
 * @param {boolean} hybrid     se true → AVVIO IBRIDO: l'agente parte SUBITO con
 *   un piano deterministico (istantaneo) mentre l'LLM-Planner gira in BACKGROUND;
 *   appena il piano LLM è pronto, lo adotta. Elimina l'attesa di 3-8s prima del
 *   primo movimento. L'LLM-Planner resta SEMPRE nel loop (compliance slide 12-13).
 *   Se false (obiettivi in linguaggio naturale) → si attende l'LLM, perché un
 *   piano deterministico non saprebbe interpretare l'istruzione.
 *
 * In entrambi i casi, dopo l'eventuale adozione del piano LLM, i fallimenti
 * di navigazione/consegna innescano l'LLM-Replanner (cap MAX_REPLANS).
 */
async function runAgentTurn(objective, hybrid = false, senderId = null) {
    if (isProcessing) return;
    isProcessing = true;
    activeSenderId = senderId;   // (L1) per reply_to_sender: rispondi a chi ha inviato la richiesta
    console.log(`\n[NEW OBJECTIVE${hybrid ? ' • HYBRID' : ''}${senderId ? ' • from ' + senderId : ''}] ${objective.substring(0, 80)}`);

    let outcome = "not completed";
    let memory  = null;

    try {
        // ════ [A] LLM-Memory (locale, veloce) ════
        memory = await buildLLMMemory(objective);

        // ════ [B] LLM-Planner ════
        // In modalità ibrida lo lanciamo in BACKGROUND (non lo aspettiamo) e
        // partiamo con un piano deterministico. Altrimenti lo aspettiamo subito.
        let plan;                 // piano attualmente in esecuzione
        let usingLLM;             // true quando stiamo eseguendo il piano dell'LLM
        let llmReady = null;      // riceverà il piano LLM appena pronto
        let llmPending = null;    // promessa della pianificazione in background

        if (hybrid) {
            llmPending = llmPlan(memory)
                .then(p => { llmReady = p; })
                .catch(e => console.error('[LLM-PLANNER bg error]', e));
            plan = fallbackPlan();          // istantaneo, ordinato per utilità
            usingLLM = false;
            console.log(`[HYBRID] Avvio deterministico (l'LLM pianifica in background): ${planStr(plan)}`);
        } else {
            plan = await llmPlan(memory);   // attesa necessaria per obiettivi NL
            usingLLM = true;
            // (Bug D1) Se il piano è un DECLINE intenzionale, usciamo subito
            // dal try con outcome settato; il finally resetta isProcessing
            // e activeSenderId come nel caso normale.
            if (plan.declined) {
                console.log('[DECLINE] LLM planner ha rifiutato la missione — nessuna azione eseguita.');
                outcome = 'declined: mission rejected by LLM planner';
                return;   // esce dal try, finally viene eseguito correttamente
            }
            // (L2) Una richiesta può impostare/azzerare la strategia PERSISTENTE.
            // Lo facciamo solo qui (turni su richiesta, hybrid=false), non nei
            // turni autonomi, così la strategia cambia solo per volontà esplicita.
            if (Object.prototype.hasOwnProperty.call(plan, 'strategy')) {
                currentStrategy = plan.strategy;
                console.log(`[STRATEGY] Direttiva persistente aggiornata → ${currentStrategy ?? '(default autonomo)'}`);
            }
            console.log(`[PLAN] ${planStr(plan)}`);
        }

        // ════ Executor + adozione piano LLM + [C] LLM-Replanner ════
        let idx = 0;        // indice azione corrente nel piano
        let replans = 0;
        const log = [];

        while (true) {

            // Appena il piano LLM (background) è pronto, lo adottiamo UNA volta:
            // sostituisce le azioni rimanenti del piano deterministico.
            if (!usingLLM && llmReady) {
                plan = llmReady; usingLLM = true; idx = 0;
                // (Bug loop fix) Applica aggiornamento strategia anche in
                // modalità ibrida. Se l'LLM restituisce strategy:null, currentStrategy
                // viene azzerata e il loop autonomo torna al gioco deterministico,
                // interrompendo il ciclo infinito. Il vincolo meccanico (forbiddenTiles
                // ecc.) rimane attivo in missionConstraints indipendentemente.
                if (Object.prototype.hasOwnProperty.call(plan, 'strategy')) {
                    currentStrategy = plan.strategy;
                    console.log(`[STRATEGY/HYBRID] Aggiornata → ${currentStrategy ?? '(default autonomo)'}`);
                }
                console.log(`[HYBRID] Piano LLM pronto → adotto: ${planStr(plan)}`);
            }

            // Piano corrente terminato?
            if (idx >= plan.actions.length || idx >= MAX_ACTIONS_PER_PLAN) {
                // Se eravamo ancora sul piano deterministico, aspettiamo l'LLM e
                // adottiamo il suo piano (garantisce che l'LLM-Planner sia usato).
                if (!usingLLM) {
                    await llmPending;
                    if (llmReady) {
                        // Applica strategia anche se il piano è vuoto (es. LLM
                        // restituisce strategy:null perché non c'è nulla da fare).
                        if (Object.prototype.hasOwnProperty.call(llmReady, 'strategy')) {
                            currentStrategy = llmReady.strategy;
                            console.log(`[STRATEGY/HYBRID] Aggiornata → ${currentStrategy ?? '(default autonomo)'}`);
                        }
                        if (llmReady.actions.length > 0) {
                            plan = llmReady; usingLLM = true; idx = 0;
                            console.log(`[HYBRID] LLM plan ready (post-deterministic) → adopting: ${planStr(plan)}`);
                            continue;
                        }
                    }
                }
                outcome = 'done: ' + log.join(' | ');
                break;
            }

            const { tool, args } = plan.actions[idx];
            const fn = TOOLS[tool];
            idx++;

            if (!fn) { log.push(`unknown tool '${tool}' (skipped)`); continue; }

            const obs = await fn(args ?? '');
            log.push(`${tool}(${args ?? ''}) → ${obs}`);

            if (!isActionSuccessful(tool, obs)) {
                // Empty pick_up: non-fatal, keep going.
                if (tool === 'pick_up') continue;

                // "Holding for batch": batch constraint not yet met. Exit the turn;
                // the next autonomousLoop iteration will call fallbackPlan() which heads
                // to a spawn zone. Do NOT trigger the LLM Replanner — it would produce
                // the same pickup+deliver plan that would fail again.
                if (isNonFatalFailure(tool, obs)) {
                    outcome = 'batch not satisfied: will collect more next turn';
                    break;
                }

                // Navigation/delivery failure. If still on the deterministic plan,
                // wait for the background LLM plan and adopt it before replanning.
                if (!usingLLM) {
                    await llmPending;
                    if (llmReady) { plan = llmReady; usingLLM = true; idx = 0; continue; }
                }

                // [C] LLM-Replanner con contesto aggiornato (cap MAX_REPLANS).
                if (++replans > MAX_REPLANS) {
                    outcome = 'stopped: too many replans (' + obs + ')';
                    break;
                }
                console.log(`[LLM-REPLANNER] triggered: ${obs}`);
                memory = await buildLLMMemory(objective);
                plan   = await llmPlan(memory, obs);
                usingLLM = true; idx = 0;
                console.log(`[REPLAN] ${planStr(plan)}`);
            }
        }

    } catch (err) {
        outcome = `error: ${err?.message ?? String(err)}`;
        console.error('[AGENT ERROR]', err);
    } finally {
        const summary = memory?.objectiveSummary ?? objective.substring(0, 80).replace(/\n/g, ' ');
        addMemory(summary, outcome.substring(0, 120));
        activeSenderId = null;   // close the turn's reply context
        isProcessing = false;
    }
}

/* ==========================================================================
   DETERMINISTIC TURN (part of LLM-ON-DEMAND mode)
   --------------------------------------------------------------------------
   Used when there is no queued NL mission and no active strategy directive.
   Agent B plays with a fast deterministic policy (like BDI) — zero LLM calls.
   Level-2 "hard" constraints (forbidden tiles, batch size) remain enforced
   because they live inside navigate_to / put_down.
   LLM is invoked only where it adds value: mission interpretation (L1/L3),
   strategy adaptation (L2), coordination.
========================================================================== */
async function runDeterministicTurn() {
    if (isProcessing) return;
    isProcessing = true;
    activeSenderId = null;

    let plan = fallbackPlan();

    // No worthwhile parcels: explore a spawn zone (BDI-style patrol fallback).
    if (plan.actions.length === 0) {
        const spawns = myBeliefs.spawnZones || [];
        if (spawns.length === 0) { isProcessing = false; return; }
        const t = spawns[Math.floor(Math.random() * spawns.length)];
        plan = { actions: [{ tool: 'navigate_to', args: `${Math.round(t.x)},${Math.round(t.y)}` }] };
    }

    console.log(`[DETERMINISTIC] ${planStr(plan)}`);
    let idx = 0, replans = 0;

    try {
        while (idx < plan.actions.length && idx < MAX_ACTIONS_PER_PLAN) {
            const { tool, args } = plan.actions[idx];
            idx++;
            const fn = TOOLS[tool];
            if (!fn) continue;
            const obs = await fn(args ?? '');
            if (!isActionSuccessful(tool, obs)) {
                if (tool === 'pick_up') continue;            // empty pick_up: non-fatal
                if (isNonFatalFailure(tool, obs)) break;     // batch not met: next turn handles it
                if (++replans > MAX_REPLANS) break;
                console.log(`[DETERMINISTIC-REPLAN] ${obs}`);
                plan = fallbackPlan(); idx = 0;              // deterministic replan (no LLM)
                if (plan.actions.length === 0) break;
            }
        }
    } catch (err) {
        console.error('[AGENT ERROR det]', err);
    } finally {
        isProcessing = false;
    }
}

// ==========================================
// 6. Autonomous objective generator
//    Builds a context-rich objective string for LLM-Memory.
//    No hard-coded thresholds — the LLM-Planner decides strategy.
// ==========================================
function generateAutonomousObjective() {
    if (myBeliefs.map.size === 0 || me.x === null) return null;

    const carried   = myBeliefs.getCarriedParcels(me.id);
    const available = myBeliefs.getAvailableParcels();
    const zones     = myBeliefs.deliveryZones;
    const spawns    = myBeliefs.spawnZones;

    if (carried.length === 0 && available.length === 0 && spawns.length === 0) return null;

    let state = `=== GAME STATE ===\n`;
    state += `My position: (${Math.round(me.x)},${Math.round(me.y)}) | Score: ${me.score}\n`;

    if (carried.length > 0) {
        const totalReward = carried.reduce((s, p) => s + Math.round(p.reward), 0);
        state += `Carrying: ${carried.length} parcel(s), ~${totalReward} pts (decaying)\n`;
    } else {
        state += `Carrying: nothing\n`;
    }

    if (available.length > 0) {
        const now = Date.now();
        // Evict expired BDI claims.

        for (const [id, exp] of bdiGoingFor) if (now > exp) bdiGoingFor.delete(id);

        const decayPerStep = Math.round(myBeliefs.getDecayRatePerMs() * MOVE_DURATION_MS * 10) / 10;
        if (decayPerStep > 0) state += `Decay rate: ~${decayPerStep} pts/step\n`;

        // Exclude BDI-claimed parcels; sort by utility best-first.
        const sorted = available
            .filter(p => !bdiGoingFor.has(p.id))
            .filter(p => !(handoffBlacklist.get(p.id) > Date.now())) // skip recently handed off to BDI
            .filter(p => !partnerOwns(p))           // (L3) closest-commits
            .map(p => {
                const dist       = Math.abs(p.x - me.x) + Math.abs(p.y - me.y);
                const rewArrival = Math.round(estimateRewardAtArrival(p, dist));
                let utility    = Math.round(parcelUtility(p, dist));
                if (missionConstraints.maxParcelReward && rewArrival > missionConstraints.maxParcelReward) {
                    utility = -1; // filter out
                }
                return { ...p, dist, rewArrival, utility };
            })
            .filter(p => p.utility >= 0)
            .sort((a, b) => b.utility - a.utility)  // BEST FIRST
            .slice(0, 12);

        state += `Available parcels (sorted by utility = est_reward²/dist, BEST FIRST):\n`;
        for (const p of sorted) {
            const expiring = p.rewArrival <= 0 ? ' ⚠ WILL EXPIRE' : '';
            state += `  - ID:${p.id} at (${Math.round(p.x)},${Math.round(p.y)}) ` +
                     `now:${Math.round(p.reward)}pts est_arrival:~${p.rewArrival}pts ` +
                     `dist:${p.dist} utility:${p.utility}${expiring}\n`;
        }
        if (available.length > 12) state += `  ... and ${available.length - 12} more parcels not shown.\n`;
    } else {
        state += `No parcels visible.\n`;
    }

    if (zones.length > 0) {
        const zoneDists = zones
            .map(z => ({ ...z, dist: Math.abs(z.x - me.x) + Math.abs(z.y - me.y) }))
            .sort((a, b) => a.dist - b.dist);
        state += `Delivery zones: ` + zoneDists.map(z => `(${Math.round(z.x)},${Math.round(z.y)}) dist=${z.dist}`).join(' | ') + '\n';
    }
    state += `==================`;

    if (available.length === 0 && carried.length === 0) {
        if (spawns.length > 0) {
            const target = spawns[Math.floor(Math.random() * spawns.length)];
            return `${state}\nNo parcels visible. Explore spawn zone at (${Math.round(target.x)},${Math.round(target.y)}) to look for new parcels.`;
        }
        return null;
    }

    return `${state}\nDecide autonomously the optimal strategy and execute it: collect high-value parcels efficiently, plan multi-parcel trips, and deliver to score points.`;
}

// ==========================================
// 7. Main autonomous loop
//
// Each iteration, if the agent is free:
//   - if a NL objective is queued (slide 11), execute it first (human priority);
//   - otherwise generate an autonomous objective from the game state.
// ==========================================
const pendingObjectives = [];  // FIFO queue: { text, senderId }

// (Challenge 2 - Level 2) PERSISTENT STRATEGY: a request can set behaviour that
// survives beyond a single turn ("prioritise high-value parcels", "stay near
// delivery"). Injected into every LLM-Memory cycle until replaced or cleared.
// null = default behaviour.
let currentStrategy = null;

// LLM-ON-DEMAND: when true (default), the agent plays deterministically (zero
// LLM calls) unless a NL mission is queued or a strategy directive is active.
// Level-2 hard constraints stay enforced (they live inside navigate_to / put_down).
// Set LLM_LAZY=false to keep the LLM in the loop for routine collect-and-deliver.
const LLM_LAZY = String(process.env.LLM_LAZY ?? 'true').toLowerCase() !== 'false';

async function autonomousLoop() {
    while (myBeliefs.map.size === 0 || me.x === null) {
        await new Promise(res => setTimeout(res, 300));
    }
    console.log("[LLM AGENT] Autonomous loop started.");

    while (true) {
        if (!isProcessing) {
            // LLM invoked only where it adds value:
            //   1) NL mission queued               → LLM (interpretation)
            //   2) active strategy directive        → LLM (must respect it)
            //   3) LLM_LAZY (default)               → deterministic, zero API calls
            if (pendingObjectives.length > 0) {
                const { text, senderId } = pendingObjectives.shift();
                await runAgentTurn(text, false, senderId);
            } else if (currentStrategy) {
                const obj = generateAutonomousObjective();
                // Hybrid mode even with strategy active: LLM runs in background so
                // we don't block 3–8 s per turn waiting for it.
                if (obj) await runAgentTurn(obj, true);    // hybrid=true: LLM in background
            } else if (LLM_LAZY) {
                await runDeterministicTurn();
            } else {
                const obj = generateAutonomousObjective();
                if (obj) await runAgentTurn(obj, true);     // LLM always in loop (hybrid)
            }
        }
        // 250 ms between turns — short enough to stay reactive, avoids CPU spin.
        await new Promise(res => setTimeout(res, 250));
    }
}
autonomousLoop();

// (L3) Periodic position broadcast for closest-commits and rendezvous.
function emitPositionAndState() {
    if (me.x !== null) emitCoordMessage(`[COORD] pos ${Math.round(me.x)} ${Math.round(me.y)}`);
}
setInterval(() => {
    emitPositionAndState();
    broadcastTeamRules();   // re-sync team constraints — resilience to late joins / dropped messages
}, 2000);

// ==========================================
// 8. Handler messaggi in arrivo
//    - [BDI] → aggiorna lastBdiUpdate (incluso nella prossima LLM-Memory)
//    - altri → trattati come obiettivi in linguaggio naturale (slide 11)
// ==========================================
socket.on('msg', (id, name, msg, replyCallback) => {
    console.log(`\n[MSG IN] From ${name}: ${msg}`);
    if (replyCallback) replyCallback('Received!');

    // (L3) Coordinazione dal partner BDI.
    if (msg.startsWith('[COORD]')) {
        const p = msg.trim().split(/\s+/);
        if (p[1] === 'pos') { llmPartnerPos = { x: Math.round(+p[2]), y: Math.round(+p[3]) }; llmPartnerId = id; }
        else if (p[1] === 'arrived') { partnerArrived = true; console.log('[COORD] partner arrived.'); }
        return;
    }

    // (L3) "Via" del mission-agent durante red light/green light: non è un nuovo
    // obiettivo, è il segnale atteso che sblocca la ripartenza.
    if (waitingForGo && /\b(go|green|start|move)\b/i.test(msg)) {
        goSignalReceived = true;
        console.log('[COORD] "go" signal received from mission-agent.');
        return;
    }

    if (msg.startsWith('[BDI]')) {
        lastBdiUpdate = msg;

        // [BDI] going_for ID → BDI si sta dirigendo verso quel pacco, lo escludiamo
        const goingForMatch = msg.match(/\[BDI\] going_for (\S+)/);
        if (goingForMatch) {
            bdiGoingFor.set(goingForMatch[1], Date.now() + BDI_CLAIM_TTL_MS);
            console.log(`[COORDINATION] BDI going for parcel ${goingForMatch[1]} — excluded from LLM planning.`);
        }

        // [BDI] picked_up ID → pacco raccolto, rimuovi dalla lista
        const pickedUpMatch = msg.match(/\[BDI\] picked_up (\S+)/);
        if (pickedUpMatch) {
            bdiGoingFor.delete(pickedUpMatch[1]);
            console.log(`[COORDINATION] BDI picked up parcel ${pickedUpMatch[1]} — removed from exclusion list.`);
        }

        return;
    }

    // Messaggio NON-[BDI] = obiettivo in linguaggio naturale (slide 11).
    // Se l'agente è libero lo eseguiamo subito; se è occupato lo mettiamo in
    // coda con PRIORITÀ sul gioco autonomo, così un'istruzione umana
    // "sostituisce" l'obiettivo corrente al prossimo turno senza essere persa.
    if (!isProcessing) {
        runAgentTurn(msg, false, id);            // (L1) ricorda il mittente per la risposta
    } else {
        // (Bug B) Coda FIFO: push invece di sovrascrittura, così nessuna missione va persa.
        console.log(`[LLM AGENT] Busy — queuing objective (queue size: ${pendingObjectives.length + 1}).`);
        pendingObjectives.push({ text: msg, senderId: id });
    }
});
