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
// 2. Connessione a DeliverooJS e stato agente
// ==========================================
const socket    = DjsConnect(process.env.HOST || "localhost:8080", process.env.TOKEN);
const me        = { id: null, name: null, x: null, y: null, score: 0 };
const myBeliefs = new Beliefs();

// Ultimo messaggio di coordinazione ricevuto dall'agente BDI partner.
// Aggiornato dal listener 'msg' e incluso nella LLM-Memory ad ogni ciclo.
let lastBdiUpdate = "No updates from BDI partner yet.";

// Pacchi che il BDI sta attualmente raggiungendo (annunciati via [BDI] going_for ID).
// Vengono esclusi dalla pianificazione dell'LLM per evitare conflitti.
// TTL di 15s: se il BDI non raccoglie il pacco entro 15s, il claim scade.
const bdiGoingFor = new Map(); // parcelId → expireAt timestamp
const BDI_CLAIM_TTL_MS = 15000;

socket.onConnect(() => console.log("[LLM AGENT] Connected to DeliverooJS."));

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
    console.log("[LLM AGENT] Map loaded.");
});

socket.onSensing((sensings) => {
    // Aspetta che onYou abbia fornito la posizione (me.x parte da null): senza
    // questo guard la belief revision userebbe coordinate nulle → distanze NaN.
    if (me.x === null || me.y === null) return;
    myBeliefs.updateSensing(sensings, { x: me.x, y: me.y }, parseInt(process.env.SENSING_RADIUS ?? '5'));
});

// ==========================================
// 3. Memoria storica persistente (parte della LLM-Memory)
//    Mantiene gli ultimi 8 esiti tra obiettivi diversi.
//    Inclusa nel system prompt di ogni nuovo ciclo per evitare errori ripetuti.
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
// 4. Strumenti (Tools) a disposizione del LLM
// ==========================================

function distance(p1, p2) {
    return Math.abs(Math.round(p1.x) - Math.round(p2.x)) + Math.abs(Math.round(p1.y) - Math.round(p2.y));
}

// Stima della durata di ogni passo in ms (valore tipico server online).
// Usato per calcolare il decay durante il percorso verso un pacco.
const MOVE_DURATION_MS = 500;

/**
 * Stima il reward di un pacco al momento dell'arrivo, tenendo conto di:
 *   - decay già maturato da quando il pacco è stato visto l'ultima volta
 *   - decay che maturerà durante il percorso (distSteps passi)
 */
function estimateRewardAtArrival(parcel, distSteps) {
    const rate    = myBeliefs.getDecayRatePerMs();
    const elapsed = Date.now() - (parcel.lastSeen ?? Date.now());
    const travel  = distSteps * MOVE_DURATION_MS;
    return Math.max(0, parcel.reward - (elapsed + travel) * rate);
}

/**
 * Utilità di un pacco: reward_stimato_all'arrivo² / distanza.
 * Bilancia valore e distanza: premia pacchi vicini E ad alto reward.
 * Stessa formula usata dall'agente BDI per confrontabilità.
 */
function parcelUtility(parcel, dist) {
    const rew = estimateRewardAtArrival(parcel, dist);
    return rew > 0 ? (rew * rew) / Math.max(1, dist) : 0;
}

function nearestDeliveryZone() {
    const zones = myBeliefs.deliveryZones;
    if (zones.length === 0) return null;
    return zones.reduce((best, z) => {
        const d  = Math.abs(z.x - me.x) + Math.abs(z.y - me.y);
        const bd = Math.abs(best.x - me.x) + Math.abs(best.y - me.y);
        return d < bd ? z : best;
    });
}

/**
 * Osserva l'ambiente e restituisce una descrizione testuale (l'OSSERVAZIONE
 * che la slide 11 richiede nella LLM-Memory). Chiamato da buildLLMMemory ad
 * ogni (ri)pianificazione, così Planner e Replanner vedono sempre lo stato fresco.
 */
async function get_visible_environment() {
    console.log("---- GET VISIBLE ENVIRONMENT ----");
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

        // Annota ogni pacco con reward stimato all'arrivo e utilità, poi ordina per utilità DESC
        // I pacchi già reclamati dal BDI vengono marcati esplicitamente (non filtrati,
        // così il LLM sa che esistono ma sono presi in carico dal partner).
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
            env += `  [ID:${p.id} at (${Math.round(p.x)},${Math.round(p.y)}) ` +
                   `now:${Math.round(p.reward)}pts est_arrival:~${p.rewArrival}pts ` +
                   `dist:${p.d} utility:${p.utility}]${expiring}${bdiClaim}\n`;
        }
    } else {
        env += `No parcels visible right now.\n`;
    }

    if (zones.length > 0) {
        const sortedZ = zones.map(z => ({ ...z, d: distance(me, z) })).sort((a, b) => a.d - b.d);
        env += `Delivery zones: ` + sortedZ.map(z => `(${Math.round(z.x)},${Math.round(z.y)}) dist=${z.d}`).join(' | ') + '\n';
    }

    env += `BDI partner status: ${lastBdiUpdate}`;
    return env;
}

/**
 * Naviga verso le coordinate specificate usando A*.
 * Accetta formato "x,y" o "(x,y)".
 */
async function navigate_to(coords) {
    console.log(`---- NAVIGATE TO ${coords} ----`);
    const cleaned = coords.replace(/[()]/g, '').replace(/\s/g, '');
    const [x, y]  = cleaned.split(',').map(Number);
    if (isNaN(x) || isNaN(y)) return `Error: invalid coordinates '${coords}'. Use format x,y.`;

    const goal = { x, y };
    let stepsTaken = 0;

    // Mappa di congestione PERSISTENTE per questa navigazione: quando una mossa
    // viene rifiutata segniamo quel tile, così A* lo evita e re-instrada invece
    // di ritentare all'infinito la stessa mossa bloccata. (Prima si usava una
    // Map vuota a ogni iterazione → nessun re-instradamento possibile.)
    const congestion = new Map();
    let consecutiveRejects = 0;
    const MAX_REJECTS = 5;   // dopo tot rifiuti di fila, dichiariamo il blocco

    while (distance(me, goal) > 0) {

        const agents = myBeliefs.getOtherAgentPositions(me.id);

        // ANTI-STALLO: se il tile di destinazione è occupato da un altro agente
        // FERMO e siamo già adiacenti (dist ≤ 1), non potremo mai entrarci.
        // Restituiamo subito senza sbattere contro di lui (niente penalità).
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

            // ── PICKUP OPPORTUNISTICO ──────────────────────────────────────
            // Se calpestiamo un tile con un pacco disponibile, lo raccogliamo
            // gratis lungo il tragitto (zero chiamate LLM). Massimizza i pacchi
            // raccolti per viaggio anche oltre quelli pianificati esplicitamente.
            const here = myBeliefs.getAvailableParcels().find(
                p => Math.round(p.x) === Math.round(me.x) && Math.round(p.y) === Math.round(me.y)
            );
            if (here) {
                const got = await socket.emitPickup();
                if (got && got.length > 0) {
                    console.log(`[OPPORTUNISTIC] Picked up ${got.length} parcel(s) en route at (${Math.round(me.x)},${Math.round(me.y)}).`);
                }
            }

            if (stepsTaken > 200) return `Stopped: path exceeded 200 steps. Now at ${Math.round(me.x)},${Math.round(me.y)}.`;
        } else {
            // Mossa rifiutata: marchiamo il tile bloccato nella congestione così
            // al prossimo giro A* trova un percorso alternativo. Rinunciamo solo
            // dopo MAX_REJECTS rifiuti consecutivi (blocco stabile).
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

/**
 * Raccoglie tutti i pacchi presenti sulla casella corrente.
 */
async function pick_up() {
    console.log("---- PICK UP ----");
    const picked = await socket.emitPickup();
    if (picked && picked.length > 0) return `Picked up ${picked.length} parcel(s).`;
    return `Failed: no parcel on this tile (${Math.round(me.x)},${Math.round(me.y)}).`;
}

/**
 * Deposita i pacchi trasportati. Funziona solo su delivery zone tiles.
 */
async function put_down() {
    console.log("---- PUT DOWN ----");
    const cx = Math.round(me.x), cy = Math.round(me.y);
    const onDelivery = myBeliefs.deliveryZones.some(z => Math.round(z.x) === cx && Math.round(z.y) === cy);
    if (!onDelivery) {
        const nearest = nearestDeliveryZone();
        const hint = nearest ? ` Navigate to (${Math.round(nearest.x)},${Math.round(nearest.y)}) first.` : "";
        return `Error: not on a delivery zone (at ${cx},${cy}).${hint}`;
    }
    await socket.emitPutdown();
    return `Parcels delivered successfully. Points scored!`;
}

/**
 * Invia un messaggio di coordinazione all'agente BDI.
 * Il BDI legge i messaggi "[LLM] taking parcel ID" e blacklista quel pacco.
 */
async function send_message_to_partner(message) {
    console.log(`---- SEND MSG: ${message} ----`);
    await socket.emitShout(`[LLM] ${message}`);
    return "Message sent to BDI partner.";
}

// ==========================================
// 5. Helper: chiamata al modello LLM
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
// 5b. CATALOGO DEI TOOL  (cfr. slide 11 e 13: "consulting a catalog of
//     available tools" / "the list of tools is predefined")
//
// Ogni tool ha: nome, descrizione degli argomenti, descrizione testuale
// (mostrata all'LLM nella LLM-Memory) e la funzione che lo esegue.
// `get_visible_environment` NON è qui perché l'osservazione dell'ambiente
// è già iniettata nella memoria ad ogni (ri)pianificazione, quindi l'LLM
// non deve "sprecare" un'azione per ottenerla.
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
];

// Mappa nome→funzione usata dall'executor per dispacciare le azioni del piano.
const TOOLS = Object.fromEntries(TOOL_CATALOG.map(t => [t.name, t.fn]));

/** Catalogo dei tool in formato testuale, incluso nella LLM-Memory (slide 11). */
function getToolCatalogText() {
    return TOOL_CATALOG.map(t => `  - ${t.name}(${t.args}): ${t.desc}`).join('\n');
}

/**
 * Estrae il PIANO dalla risposta dell'LLM: una sequenza di azioni a1..aN
 * (cfr. architettura slide 12 — "PLAN (a1, a2, ... aN)").
 * Formato atteso:
 *   Plan: {"actions": [ {"tool":"navigate_to","args":"5,7"}, {"tool":"pick_up"}, ... ]}
 * Robusto: se il parsing fallisce restituisce null (→ si userà il fallback).
 */
function parsePlan(text) {
    const match = text.match(/\{[\s\S]*\}/);   // primo oggetto JSON nella risposta
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        if (!Array.isArray(obj.actions)) return null;
        const actions = obj.actions
            .filter(a => a && typeof a.tool === 'string')
            .map(a => ({ tool: a.tool.trim(), args: a.args != null ? String(a.args).trim() : '' }));
        return actions.length > 0 ? { actions } : null;
    } catch {
        return null;
    }
}

/**
 * Piano di fallback DETERMINISTICO: se l'LLM non produce un piano valido,
 * l'agente non si blocca mai. Costruisce una sequenza di azioni che raccoglie
 * i top-4 pacchi per utilità e poi consegna alla zona più vicina.
 * (Risolve il vecchio problema: parsing fragile → nessuna azione → agente fermo.)
 */
function fallbackPlan() {
    const actions = [];
    const top = myBeliefs.getAvailableParcels()
        .filter(p => !bdiGoingFor.has(p.id))
        .map(p => ({ ...p, d: distance(me, p), u: parcelUtility(p, distance(me, p)) }))
        .filter(p => p.u > 0)
        .sort((a, b) => b.u - a.u)
        .slice(0, 4);

    for (const p of top) {
        actions.push({ tool: 'navigate_to', args: `${Math.round(p.x)},${Math.round(p.y)}` });
        actions.push({ tool: 'pick_up', args: '' });
    }

    // Consegna se raccoglieremo qualcosa o se stiamo già trasportando pacchi
    const willCarry = top.length + myBeliefs.getCarriedParcels(me.id).length;
    if (willCarry > 0) {
        const z = nearestDeliveryZone();
        if (z) {
            actions.push({ tool: 'navigate_to', args: `${Math.round(z.x)},${Math.round(z.y)}` });
            actions.push({ tool: 'put_down', args: '' });
        }
    }
    return { actions };
}

/**
 * Verifica se l'osservazione restituita da un tool indica successo.
 * Usata dall'executor per decidere se proseguire o innescare il Replanner.
 */
function isActionSuccessful(tool, observation) {
    switch (tool) {
        case 'navigate_to': return observation.startsWith('Arrived');
        case 'pick_up':     return observation.startsWith('Picked');
        case 'put_down':    return observation.startsWith('Parcels delivered');
        default:            return true;   // send_message_to_partner ecc.
    }
}

// ==========================================
// COMPONENTE A: LLM-Memory   (cfr. slide 11: "Update the context")
//
// È il CONTESTO dell'LLM. La slide 11 richiede che la memoria aggreghi tre
// fonti, aggiornate dinamicamente perché ambiente e obiettivi cambiano:
//   1. l'OBIETTIVO (in linguaggio naturale o strutturato) — da interpretare
//   2. l'OSSERVAZIONE dell'ambiente (get_visible_environment) + beliefs scambiati
//      con l'agente BDI (lastBdiUpdate, incluso nell'environment)
//   3. il CATALOGO DEI TOOL disponibili (getToolCatalogText)
// In più conserviamo una memoria storica cross-obiettivo (getMemoryBlock).
//
// La memoria viene RICOSTRUITA ad ogni (ri)pianificazione, così l'LLM-Planner
// e l'LLM-Replanner ragionano sempre su uno stato aggiornato.
// ==========================================
async function buildLLMMemory(objective) {
    console.log("\n[LLM-MEMORY] Building context...");
    const environment = await get_visible_environment();   // osservazione + stato BDI
    return {
        objective,                              // (1) obiettivo da interpretare
        environment,                            // (2) osservazione ambiente + beliefs BDI
        toolCatalog:      getToolCatalogText(), // (3) catalogo dei tool
        memoryBlock:      getMemoryBlock(),     // memoria storica cross-obiettivo
        objectiveSummary: objective.substring(0, 80).replace(/\n/g, ' ')
    };
}

// ==========================================
// COMPONENTE B / C: LLM-Planner / LLM-Replanner   [llmPlan]
//
// (cfr. slide 12-13) UNA sola chiamata LLM trasforma l'obiettivo + memoria in un
// PIANO = sequenza ordinata di azioni-tool a1..aN. Decidendo l'intero giro in un
// colpo, l'LLM ragiona sull'intero percorso e tende a raccogliere PIÙ pacchi per
// viaggio (al contrario del vecchio ReAct passo-passo, che consegnava troppo presto).
//
//   - Senza `replanNote` → LLM-Planner  : pianifica da zero per il nuovo obiettivo.
//   - Con    `replanNote` → LLM-Replanner: raffina il piano dopo un imprevisto
//                                           (azione fallita, mondo/obiettivo cambiati).
//
// Gestisce sia obiettivi STRUTTURATi (stato di gioco autonomo) sia obiettivi in
// LINGUAGGIO NATURALE ricevuti via messaggio (slide 11: "reading and interpreting
// objectives expressed in natural language"): in entrambi i casi l'LLM li traduce
// nella sequenza di tool appropriata.
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
Thought: <1-2 sentences: how you interpret the objective and the route/actions you chose>
Plan: {"actions": [ {"tool":"navigate_to","args":"5,7"}, {"tool":"pick_up"}, {"tool":"navigate_to","args":"0,0"}, {"tool":"put_down"} ]}

PLANNING RULES:
- Use ONLY tools from the catalog in memory. "args" is the tool argument as a string ("" if none).
- COLLECT MULTIPLE PARCELS PER TRIP: chain several navigate_to + pick_up before the final
  navigate_to(delivery) + put_down. One trip carrying 3-4 parcels beats 3-4 separate trips.
- Prefer high-utility parcels; order pickups to minimise total travel (roughly nearest-neighbour).
- NEVER plan a pickup for a parcel marked "WILL EXPIRE" or "BDI partner is heading here".
- To score, navigate_to a delivery-zone tile and THEN put_down (put_down only scores on such a tile).
- You MAY send_message_to_partner("taking parcel ID") to claim a parcel so the BDI avoids it.
- If the objective is a natural-language instruction (e.g. "go to 3,4", "deliver everything now"),
  translate it directly into the matching tool actions.
- Keep the plan concise and achievable with the CURRENT environment; rely on REPLAN for surprises.
`.trim();

/**
 * COMPONENTE B (Planner) e COMPONENTE C (Replanner): un'unica chiamata LLM.
 * @param {object} memory            contesto costruito da buildLLMMemory
 * @param {string|null} replanNote   se presente → modalità Replanner
 * @returns {{actions: {tool:string, args:string}[]}}
 */
async function llmPlan(memory, replanNote = null) {
    const messages = [
        { role: "system", content: PLANNER_PROMPT + memory.memoryBlock },
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
// EXECUTOR (cfr. slide 12, blocco "Exec") — ZERO chiamate LLM
//
// L'esecuzione vera e propria (scorrere le azioni a1..aN del piano, dispacciarle
// ai tool del catalogo, valutarne l'esito, adottare il piano LLM in modalità
// ibrida e innescare l'LLM-Replanner sui fallimenti) è INLINE nell'orchestratore
// runAgentTurn qui sotto: serviva un loop che potesse SCAMBIARE il piano in corso
// (deterministico → LLM) senza ricominciare da capo, cosa che un executePlan
// "monolitico" non permetteva.
// ==========================================
const MAX_ACTIONS_PER_PLAN = 30;   // guardia anti-loop

// ==========================================
// Orchestratore: runAgentTurn   (schema PLAN-AND-EXECUTE)
//
//   [A]  LLM-Memory   : buildLLMMemory(objective)
//   [B]  LLM-Planner  : llmPlan(memory)               (1 chiamata)
//        Executor A*  : executePlan(plan)             (0 chiamate)
//   [C]  LLM-Replanner: llmPlan(memory, reason)        (solo se disturbato)
//
// Costo tipico: 1 chiamata LLM per giro completo.
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
async function runAgentTurn(objective, hybrid = false) {
    if (isProcessing) return;
    isProcessing = true;
    console.log(`\n[NEW OBJECTIVE${hybrid ? ' • HYBRID' : ''}] ${objective.substring(0, 80)}`);

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
                console.log(`[HYBRID] Piano LLM pronto → adotto: ${planStr(plan)}`);
            }

            // Piano corrente terminato?
            if (idx >= plan.actions.length || idx >= MAX_ACTIONS_PER_PLAN) {
                // Se eravamo ancora sul piano deterministico, aspettiamo l'LLM e
                // adottiamo il suo piano (garantisce che l'LLM-Planner sia usato).
                if (!usingLLM) {
                    await llmPending;
                    if (llmReady && llmReady.actions.length > 0) {
                        plan = llmReady; usingLLM = true; idx = 0;
                        console.log(`[HYBRID] Piano LLM (post-deterministico) → adotto: ${planStr(plan)}`);
                        continue;
                    }
                }
                outcome = 'done: ' + log.join(' | ');
                break;
            }

            const { tool, args } = plan.actions[idx];
            const fn = TOOLS[tool];
            idx++;

            // Tool sconosciuto: lo saltiamo (in fase LLM resta comunque tracciato).
            if (!fn) { log.push(`unknown tool '${tool}' (skipped)`); continue; }

            const obs = await fn(args ?? '');
            log.push(`${tool}(${args ?? ''}) → ${obs}`);

            if (!isActionSuccessful(tool, obs)) {
                // pick_up a vuoto: non fatale, proseguiamo (vedi executePlan).
                if (tool === 'pick_up') continue;

                // Fallimento navigazione/consegna.
                // Se siamo ancora sul piano deterministico, NON sprechiamo un
                // replan: aspettiamo il piano LLM in background e lo adottiamo.
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
        isProcessing = false;
    }
}

// ==========================================
// 6. Generatore di obiettivi autonomi
//    Costruisce un obiettivo ricco di contesto da passare alla LLM-Memory.
//    Nessuna soglia hard-coded: è il LLM-Planner a decidere la strategia.
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
        // Pulizia TTL: rimuove claim BDI scaduti
        const now = Date.now();
        for (const [id, exp] of bdiGoingFor) if (now > exp) bdiGoingFor.delete(id);

        const decayPerStep = Math.round(myBeliefs.getDecayRatePerMs() * MOVE_DURATION_MS * 10) / 10;
        if (decayPerStep > 0) state += `Decay rate: ~${decayPerStep} pts/step\n`;

        // Esclude i pacchi che il BDI sta già raggiungendo, ordina per utilità BEST FIRST
        const sorted = available
            .filter(p => !bdiGoingFor.has(p.id))
            .map(p => {
                const dist       = Math.abs(p.x - me.x) + Math.abs(p.y - me.y);
                const rewArrival = Math.round(estimateRewardAtArrival(p, dist));
                const utility    = Math.round(parcelUtility(p, dist));
                return { ...p, dist, rewArrival, utility };
            })
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
// 7. Loop autonomo principale
//
// Ad ogni iterazione, se l'agente è libero:
//   - se è in coda un obiettivo in linguaggio naturale (slide 11) lo esegue
//     PER PRIMO (priorità sull'istruzione umana);
//   - altrimenti genera autonomamente un obiettivo dallo stato di gioco.
// ==========================================
let pendingObjective = null;   // obiettivo NL ricevuto mentre l'agente era occupato

async function autonomousLoop() {
    while (myBeliefs.map.size === 0 || me.x === null) {
        await new Promise(res => setTimeout(res, 300));
    }
    console.log("[LLM AGENT] Autonomous loop started.");

    while (true) {
        if (!isProcessing) {
            // Priorità all'obiettivo umano in coda, poi al gioco autonomo.
            // - Obiettivo NL in coda → hybrid=false (serve l'interpretazione LLM).
            // - Obiettivo autonomo (raccogli-e-consegna) → hybrid=true (avvio
            //   deterministico immediato + LLM-Planner in background).
            let objective, hybrid;
            if (pendingObjective) {
                objective = pendingObjective;
                pendingObjective = null;
                hybrid = false;
            } else {
                objective = generateAutonomousObjective();
                hybrid = true;
            }
            if (objective) await runAgentTurn(objective, hybrid);
        }
        // Pausa breve tra un obiettivo e l'altro: prima era 1s (tempo morto in
        // cui i pacchi decadono). 250ms basta per non saturare la CPU lasciando
        // l'agente reattivo a ripianificare appena finito un giro.
        await new Promise(res => setTimeout(res, 250));
    }
}
autonomousLoop();

// ==========================================
// 8. Handler messaggi in arrivo
//    - [BDI] → aggiorna lastBdiUpdate (incluso nella prossima LLM-Memory)
//    - altri → trattati come obiettivi in linguaggio naturale (slide 11)
// ==========================================
socket.on('msg', (id, name, msg, replyCallback) => {
    console.log(`\n[MSG IN] From ${name}: ${msg}`);
    if (replyCallback) replyCallback('Received!');

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

        console.log(`[COORDINATION] BDI update: ${msg}`);
        return;
    }

    // Messaggio NON-[BDI] = obiettivo in linguaggio naturale (slide 11).
    // Se l'agente è libero lo eseguiamo subito; se è occupato lo mettiamo in
    // coda con PRIORITÀ sul gioco autonomo, così un'istruzione umana
    // "sostituisce" l'obiettivo corrente al prossimo turno senza essere persa.
    if (!isProcessing) {
        runAgentTurn(msg);
    } else {
        console.log("[LLM AGENT] Busy — queuing natural-language objective for next turn.");
        pendingObjective = msg;
    }
});
