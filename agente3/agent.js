/* ============================================================================
   agent.js — Agent A: BDI architecture with A* navigation and PDDL planning.

   Execution cycle:
     onSensing → optionsGeneration() → IntentionRevisionReplace.push(predicate)
               → Intention.achieve() → Plan.execute()

   Inertia: if optionsGeneration pushes the same predicate as the current
   intention, IntentionRevisionReplace is a no-op — the running plan is never
   interrupted needlessly (BDI commitment semantics).
============================================================================ */

import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import { Beliefs } from "./beliefs.js";
import { Planner } from "./planner.js";
import { PddlPlanner } from "./pddlPlanner.js";
import { PddlDeliveryPlanner } from "./pddlDelivery.js";
import { PddlCratePlanner } from "./pddlCrates.js";

// ── USE_PDDL_PLANNER: when true, AStarMove delegates navigation to the online
// PDDL solver (pddlPlanner.js) instead of the local A*. Falls back to A*
// automatically if the solver is unreachable or returns no plan.
const USE_PDDL_PLANNER = String(process.env.USE_PDDL_PLANNER).toLowerCase() === 'true';

// ── USE_PDDL_DELIVERY: when true, PddlDeliveryPlan composes the full multi-
// parcel trip (which parcels, in what order, which delivery zone) via the
// online PDDL solver (pddlDelivery.js) — the means-end reasoning step.
// Falls back to the greedy utility heuristic if the solver fails (see
// pddlCooldownUntil). Distinct from USE_PDDL_PLANNER (navigation-only).
const USE_PDDL_DELIVERY = String(process.env.USE_PDDL_DELIVERY).toLowerCase() === 'true';

const myBeliefs = new Beliefs();
const me = {}; // populated by socket.onYou on every tick

let movementDurationMs = 50;  // self-calibrating EMA (α=0.3), converges in ~10 steps
const EXPECTED_SPAWN_VALUE = 4;
const MAX_CAPACITY = 18;
const OPPORTUNISTIC_RADIUS = 5;    // max detour distance for en-route parcel pickup
const SPAWN_COOLDOWN_MS = 15000;
const BAN_DURATION_MS = 3000;      // short ban for unreachable targets
const MAX_MOVE_FAILS = 5;          // consecutive rejected moves before abandoning goal
const CONGESTION_PENALTY = 100;    // cost added to A* for recently rejected tiles
const CONGESTION_DURATION_MS = 5000;
let sensingRadius = parseInt(process.env.SENSING_RADIUS ?? '5');
// Updated by socket.onConfig; the .env value is just the initial fallback.

// Short-lived bans for targets that proved unreachable.
const blacklist = {
    parcels: new Map(), // id → expireAt
    zones: new Map()    // "x,y" → expireAt
};

// Tiles on which a move was recently rejected; passed to A* as extra cost.
// Format: "x,y" → { penalty, expireAt }
const congestionMap = new Map();

// Spawn zones visited recently (cooldown to avoid grinding the same cluster).
const visitedSpawns = new Map();

// If the PDDL delivery solver fails or is unreachable, skip it for
// PDDL_FAIL_COOLDOWN_MS and fall back to the greedy heuristic. Prevents
// hammering a dead solver every deliberation cycle.
let pddlCooldownUntil = 0;
const PDDL_FAIL_COOLDOWN_MS = 30000;

// Active Sokoban navigation goal. When the best reachable target requires
// multi-push crate sequencing (A* returns null), optionsGeneration sets this
// and pushes ['crate_nav', x, y]. It re-pushes the same predicate every tick
// so IntentionRevisionReplace never interrupts the plan mid-execution.
// CrateNavigate clears this on completion or failure.
let crateNavGoal = null;             // { x, y } or null
const crateNavBlacklist = new Map(); // "x,y" → expireAt for PDDL-unsolvable goals
const CRATE_NAV_BAN_MS = 20000;
let mapHasCrates = false;            // true only on maps that have '5!' tiles

/* Coordination protocol with the LLM partner (Challenge 2 - Level 3).
   The LLM is the orchestrator: it reads natural-language missions and sends
   [COORD] commands via game-chat. When a coordination is active, it has top
   priority and suspends normal gameplay. Commands:
     [COORD] pos <x> <y>           — position exchange (beliefs sync)
     [COORD] goto_wait <x> <y> <d> — move within dist d of (x,y) and wait
     [COORD] freeze                — stop and wait (red light)
     [COORD] release               — end coordination, resume normal play
   BDI sends: [COORD] pos (periodic heartbeat) and [COORD] arrived (rendezvous).
*/
const coordState = { mode: null, x: 0, y: 0, dist: 0 };
let partnerPos = null;           // last known position of the LLM partner
let partnerId = null;            // used for closest-commits tie-breaking
let lastCoordBroadcast = 0;
const COORD_BROADCAST_MS = 2000;

// Send to the LLM partner directly once its ID is known; shout only as fallback.
function emitCoord(msg) {
    if (partnerId) socket.emitSay(partnerId, msg);
    else socket.emitShout(msg);
}

/* Team-wide mission constraints received from the LLM via [COORD] rules.
   The BDI never parses free text — only this fixed tag. Each [COORD] rules
   message is a complete snapshot (not a diff), so it self-corrects if a
   message is dropped. */
const teamConstraints = {
    forbiddenTiles: new Set(),
    deliverBatchSize: null,
    bonusDeliveryTiles: new Set(),
    zeroValueDeliveryTiles: new Set(),
    maxParcelReward: null,
};

// Parcels the LLM partner dropped for us to fetch ([COORD] fetch), highest priority.
const pendingFetch = [];  // { id, x, y, expiresAt }
const FETCH_TTL_MS = 20000;


function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    return Math.abs(Math.round(x1) - Math.round(x2)) + Math.abs(Math.round(y1) - Math.round(y2));
}

/* Returns the tile reached by moving 'move' from 'pos'. Used to record the
   blocked tile on a rejected move and to identify upcoming crate pushes. */
function targetTileForMove(pos, move) {
    let x = Math.round(pos.x), y = Math.round(pos.y);
    if (move === 'right') x++;
    else if (move === 'left') x--;
    else if (move === 'up') y++;
    else if (move === 'down') y--;
    return { x, y };
}

/* Estimates a parcel's reward when the agent would arrive, accounting for
   decay already elapsed since lastSeen plus the travel time for distSteps.
   Returns 0 if the parcel will have expired before arrival. */
function estimateRewardAtArrival(parcel, distSteps) {
    const rate = myBeliefs.getDecayRatePerMs();
    const elapsed = Date.now() - (parcel.lastSeen ?? Date.now());
    const travel = distSteps * movementDurationMs;
    return Math.max(0, parcel.reward - (elapsed + travel) * rate);
}

/* Returns the walkable tile within Manhattan dist of (cx,cy) that is closest
   to us. If we are already within range, returns our current position. */
function coordTargetTile(cx, cy, dist) {
    if (distance(me, { x: cx, y: cy }) <= dist) {
        return { x: Math.round(me.x), y: Math.round(me.y) };
    }
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

/* Nearest walkable tile on an odd-numbered row (red-light/green-light mission). */
function nearestOddRowTile() {
    let best = null, bestD = Infinity;
    for (const tile of myBeliefs.map.values()) {
        if (String(tile.type) === '0') continue;
        const ty = Math.round(tile.y);
        if (ty % 2 === 0) continue;   // odd rows only
        const tx = Math.round(tile.x);
        const d = distance(me, { x: tx, y: ty });
        if (d < bestD) { bestD = d; best = { x: tx, y: ty }; }
    }
    return best || { x: Math.round(me.x), y: Math.round(me.y) };
}

/* "Closest-commits" coordination: the parcel belongs to the partner if they
   are strictly closer. Tie-break: lower id wins, so exactly one agent claims
   it. If partner position is unknown, we don't filter (reservation protocol). */
function partnerOwns(parcel) {
    if (!partnerPos) return false;
    const myDist = distance(me, parcel);
    const partnerDist = Math.abs(Math.round(partnerPos.x) - Math.round(parcel.x))
                      + Math.abs(Math.round(partnerPos.y) - Math.round(parcel.y));
    if (partnerDist < myDist) return true;
    if (partnerDist > myDist) return false;
    return partnerId != null && String(partnerId) < String(me.id);  // tie-break: lower id wins
}

const socket = DjsConnect(process.env.HOST, process.env.TOKEN);

socket.onConnect(() => {
    console.log("[SYSTEM] Connected. BDI architecture with A* planning active.");
});

socket.onConfig((config) => {
    const obs = config?.GAME?.player?.observation_distance;
    if (obs !== undefined) sensingRadius = obs;
});

socket.onMap((width, height, tiles) => {
    if (!tiles || typeof tiles[Symbol.iterator] !== 'function') return;
    myBeliefs.updateMap(tiles);
    mapHasCrates = myBeliefs.crates.size > 0;
    if (!mapHasCrates) console.log('[SYSTEM] No crates on this map: PDDL Sokoban disabled.');
});

socket.onYou((data) => {
    me.id = data.id;
    me.name = data.name;
    me.x = data.x;
    me.y = data.y;
    me.score = data.score;

    const prevPenalty = me.penalty ?? 0;
    me.penalty = data.penalty ?? 0;
    const delta = prevPenalty - me.penalty;
    if (delta > 0) {
        console.warn(`[PENALTY] -${delta} pts | total: ${me.penalty} | score: ${me.score}`);
    }

    // Periodically broadcast our position to the LLM partner (throttled)
    // for rendezvous coordination and closest-commits allocation.
    const nowTs = Date.now();
    if (me.x !== undefined && nowTs - lastCoordBroadcast > COORD_BROADCAST_MS) {
        lastCoordBroadcast = nowTs;
        emitCoord(`[COORD] pos ${Math.round(me.x)} ${Math.round(me.y)}`);
    }
});

socket.on('msg', (id, name, msg, replyCallback) => {
    console.log(`\n[MSG IN] From ${name}: ${msg}`);
    if (replyCallback) replyCallback('Message received!');

    if (msg.startsWith('[COORD]')) {
        const p = msg.trim().split(/\s+/);
        const cmd = p[1];
        if (cmd === 'pos') {
            partnerPos = { x: Math.round(+p[2]), y: Math.round(+p[3]) };
            partnerId = id;
        } else if (cmd === 'rendezvous') {
            coordState.mode = 'rendezvous';
            coordState.x = Math.round(+p[2]);
            coordState.y = Math.round(+p[3]);
            console.log(`[COORD] rendezvous → heading to (${coordState.x},${coordState.y})`);
        } else if (cmd === 'goto_wait') {
            const t = nearestOddRowTile();
            coordState.mode = 'goto_wait';
            coordState.x = t.x; coordState.y = t.y; coordState.dist = 0;
            console.log(`[COORD] goto_wait → moving to odd row (${t.x},${t.y})`);
        } else if (cmd === 'freeze') {
            coordState.mode = 'freeze';
            console.log('[COORD] freeze → stopping and waiting');
        } else if (cmd === 'release') {
            coordState.mode = null;
            console.log('[COORD] release → resuming normal play');
        } else if (cmd === 'rules') {
            // Full snapshot of team-wide constraints — always overwrites the
            // entire object (idempotent; self-corrects if a message was lost).
            const parseSet = v => new Set(v ? v.split(';').filter(Boolean) : []);
            const fields = Object.fromEntries(
                p.slice(2).map(kv => kv.split('=')).filter(([k]) => k)
            );
            teamConstraints.forbiddenTiles = parseSet(fields.avoid);
            teamConstraints.deliverBatchSize = fields.batch ? parseInt(fields.batch, 10) || null : null;
            teamConstraints.bonusDeliveryTiles = parseSet(fields.bonus);
            teamConstraints.zeroValueDeliveryTiles = parseSet(fields.zero);
            teamConstraints.maxParcelReward = fields.maxreward ? parseInt(fields.maxreward, 10) || null : null;
            teamConstraints.relayMode = fields.relay === 'true' || fields.relay === '1';
            console.log(`[COORD] rules updated: ${msg}`);
        } else if (cmd === 'fetch') {
            const fid = p[2];
            const fx = Math.round(+p[3]), fy = Math.round(+p[4]);
            pendingFetch.push({ id: fid, x: fx, y: fy, expiresAt: Date.now() + FETCH_TTL_MS });
            console.log(`[COORD] fetch → parcel ${fid} dropped at (${fx},${fy}), top priority`);
        }
        return;
    }

    // If the LLM announces it is heading for a specific parcel, blacklist it
    // so we don't compete for the same target.
    const match = msg.match(/taking parcel\s+(\S+)/i);
    if (match && match[1]) {
        console.log(`[COORDINATION] Ignoring parcel ${match[1]} for 10 s.`);
        blacklist.parcels.set(match[1], Date.now() + 10000);
    }
});

/* ── OPTIONS GENERATION (the "Desires" layer of BDI) ─────────────────────────
   Called every sensing tick. Produces the single best predicate to push into
   IntentionRevisionReplace. Predicates: ['go_pick_up', x, y, id],
   ['go_deliver', x, y], ['patrol', x, y], ['crate_nav', x, y], etc.
*/

/* Returns true if the target tile is reachable by A* (no multi-push needed). */
function reachableByAStar(tx, ty) {
    return Planner.getPath(
        me, { x: tx, y: ty }, myBeliefs.map,
        myBeliefs.getOtherAgentPositions(me.id), [], congestionMap,
        myBeliefs.getCrateKeys(),
        [{ x: Math.round(me.x), y: Math.round(me.y) }, ...myBeliefs.deliveryZones, ...myBeliefs.spawnZones]
    ) !== null;
}

/* Push the chosen predicate, but if the goal tile is A*-unreachable (needs a
   Sokoban multi-push sequence) delegate to CrateNavigate — unless that goal
   is already in crateNavBlacklist (solver declared it unsolvable recently), in
   which case let the normal plan fail and blacklist it, avoiding repeated solver
   hammering. CrateNavigate only brings the agent to the tile; pickup/delivery
   continue normally once the path is clear. */
function chooseGoal(predicate) {
    const tx = Math.round(predicate[1]), ty = Math.round(predicate[2]);
    if (reachableByAStar(tx, ty)) { myAgent.push(predicate); return; }
    // On maps without crates an A* failure is a real wall — don't invoke PDDL.
    if (!mapHasCrates) { myAgent.push(predicate); return; }
    const banned = (crateNavBlacklist.get(`${tx},${ty}`) || 0) > Date.now();
    if (banned) { myAgent.push(predicate); return; }
    crateNavGoal = { x: tx, y: ty };
    myAgent.push(['crate_nav', tx, ty]);
}

function optionsGeneration() {

    if (me.x === undefined || me.y === undefined) return; // position not yet available

    const now = Date.now();

    // Active coordination overrides normal gameplay until released.
    if (coordState.mode === 'freeze') { myAgent.push(['coord_idle']); return; }

    const pacchiInMano = myBeliefs.getCarriedParcels(me.id);
    const carryCount = pacchiInMano.length;
    const isFull = carryCount >= MAX_CAPACITY;
    const hasParcels = carryCount > 0;
    const isOverBatch = teamConstraints.deliverBatchSize && carryCount >= teamConstraints.deliverBatchSize;

    const batchSatisfied = !teamConstraints.deliverBatchSize || carryCount >= teamConstraints.deliverBatchSize || isFull;
    const forcedToDeliver = isFull || isOverBatch;

    if (coordState.mode === 'goto_wait' && !batchSatisfied) {
        myAgent.push(['coord_goto_wait', coordState.x, coordState.y, coordState.dist]);
        return;
    }

    // In relay mode we meet the partner only when empty-handed; if carrying,
    // deliver first. In normal mode, only forced delivery overrides rendezvous.
    const shouldIgnoreRendezvous = teamConstraints.relayMode ? hasParcels : forcedToDeliver;
    if (coordState.mode === 'rendezvous' && !shouldIgnoreRendezvous) {
        myAgent.push(['coord_rendezvous', coordState.x, coordState.y]);
        return;
    }

    // Handoff parcels have top priority, but if we are already ready to deliver
    // we finish that first (avoids holding a full inventory indefinitely).
    for (let i = pendingFetch.length - 1; i >= 0; i--) {
        const pf = pendingFetch[i];
        if (now > pf.expiresAt || pacchiInMano.some(p => p.id === pf.id) || blacklist.parcels.has(pf.id)) {
            pendingFetch.splice(i, 1);
        }
    }
    if (pendingFetch.length > 0 && !forcedToDeliver) {
        const f = pendingFetch[0]; // keep the entry — don't shift, re-push same intent each tick
        myAgent.push(['go_pick_up', f.x, f.y, f.id]);
        return;
    }

    // Proximity delivery: if we are ≤4 tiles from a valid zone and carrying
    // more than 2 parcels, deliver immediately even if a CrateNavigate was active.
    if (hasParcels && carryCount > 2) {
        const nearZone = myBeliefs.deliveryZones
            .filter(z => !blacklist.zones.has(`${Math.round(z.x)},${Math.round(z.y)}`))
            .filter(z => !teamConstraints.zeroValueDeliveryTiles.has(`${Math.round(z.x)},${Math.round(z.y)}`))
            .find(z => distance(me, z) <= 4);
        if (nearZone) {
            crateNavGoal = null;
            myAgent.push(['go_deliver', Math.round(nearZone.x), Math.round(nearZone.y)]);
            return;
        }
    }

    // CrateNavigate commit: re-push the same predicate every tick so
    // IntentionRevisionReplace never interrupts the Sokoban plan mid-execution.
    // We exit the commit when the goal is reached or the corridor opens naturally.
    if (mapHasCrates && crateNavGoal) {
        if (distance(me, crateNavGoal) === 0 || reachableByAStar(crateNavGoal.x, crateNavGoal.y)) {
            crateNavGoal = null;   // reached or corridor now open → normal play
        } else {
            myAgent.push(['crate_nav', crateNavGoal.x, crateNavGoal.y]);
            return;
        }
    }

    // Evict expired entries from all TTL maps.
    for (const [id, exp] of blacklist.parcels.entries()) if (now > exp) blacklist.parcels.delete(id);
    for (const [coord, exp] of blacklist.zones.entries()) if (now > exp) blacklist.zones.delete(coord);
    for (const [coord, exp] of visitedSpawns.entries()) if (now > exp) visitedSpawns.delete(coord);
    for (const [coord, data] of congestionMap.entries()) if (now > data.expireAt) congestionMap.delete(coord);
    for (const [coord, exp] of crateNavBlacklist.entries()) if (now > exp) crateNavBlacklist.delete(coord);

    // In relay mode the BDI ignores map parcels — its only job is fetching and
    // delivering handoff parcels from the LLM partner (via pendingFetch).
    const pacchiDisponibili = teamConstraints.relayMode ? [] : myBeliefs.getAvailableParcels()
        .filter(p => !blacklist.parcels.has(p.id))
        .filter(p => !partnerOwns(p));

    // "Zero value" zones are walkable but never targeted. Among valid zones,
    // bonus tiles are always preferred over plain ones.
    const zoneConsegnaValide = myBeliefs.deliveryZones
        .filter(z => !blacklist.zones.has(`${z.x},${z.y}`))
        .filter(z => !teamConstraints.zeroValueDeliveryTiles.has(`${Math.round(z.x)},${Math.round(z.y)}`));
    const bonusZones = zoneConsegnaValide.filter(
        z => teamConstraints.bonusDeliveryTiles.has(`${Math.round(z.x)},${Math.round(z.y)}`)
    );
    const deliveryCandidates = bonusZones.length > 0 ? bonusZones : zoneConsegnaValide;

    // Utility = estimatedReward² / distance. Skip parcels that will have expired
    // by the time we arrive (estimateRewardAtArrival returns 0).
    let bestParcel = null, maxPickupUtility = -1;
    for (const p of pacchiDisponibili) {
        const dist = Math.max(0.1, distance(me, p));
        const rewardAtArrival = estimateRewardAtArrival(p, dist);
        if (rewardAtArrival <= 0) continue;
        if (teamConstraints.maxParcelReward && rewardAtArrival > teamConstraints.maxParcelReward) continue;
        const utility = Math.pow(rewardAtArrival, 2) / dist;
        if (utility > maxPickupUtility) { maxPickupUtility = utility; bestParcel = p; }
    }

    // Delivery utility = estimatedCarriedReward² / distance.
    let bestZone = null, maxDeliveryUtility = -1;
    if (hasParcels) {
        const rate = myBeliefs.getDecayRatePerMs();
        const currentCarriedReward = pacchiInMano.reduce((s, p) => {
            const elapsed = now - (p.lastSeen ?? now);
            return s + Math.max(0, p.reward - elapsed * rate);
        }, 0);

        for (const z of deliveryCandidates) {
            const dist = Math.max(0.1, distance(me, z));
            const travelDecay = dist * movementDurationMs * rate;
            const expectedReward = Math.max(0.1, currentCarriedReward - travelDecay);
            const utility = Math.pow(expectedReward, 2) / dist;
            if (utility > maxDeliveryUtility) { maxDeliveryUtility = utility; bestZone = z; }
        }
    }

    // Patrol utility: exclude spawn zones already in sensor range (their parcels
    // are already visible) and recently visited ones (cooldown).
    const notVisible = z => distance(me, z) > sensingRadius;
    let unvisited = myBeliefs.spawnZones.filter(z =>
        notVisible(z) && !visitedSpawns.has(`${Math.round(z.x)},${Math.round(z.y)}`)
    );
    if (unvisited.length === 0) {
        visitedSpawns.clear();
        unvisited = myBeliefs.spawnZones.filter(notVisible);
    }

    let bestPatrol = null, maxPatrolUtility = -1;
    if (!isFull && unvisited.length > 0) {
        for (const z of unvisited) {
            const dist = distance(me, z); // always > sensingRadius ≥ 1, never 0
            const utility = Math.pow(EXPECTED_SPAWN_VALUE, 2) / dist;
            if (utility > maxPatrolUtility) { maxPatrolUtility = utility; bestPatrol = z; }
        }
    }

    /* PDDL means-end routing: if USE_PDDL_DELIVERY is on and the solver is not
       in cooldown, delegate the full multi-parcel trip to PddlDeliveryPlan.
       Patrol stays greedy (PDDL adds no value for exploration).
       ['pddl_trip'] is a constant predicate — IntentionRevisionReplace's inertia
       suppresses duplicate pushes, so the solver is called once per trip, not
       once per tick. If the solver fails, PddlDeliveryPlan sets pddlCooldownUntil
       and throws; the next tick falls through to the greedy heuristic below.

       Team rules bypass: when batch/bonus/zero-value/maxReward constraints are
       active, the PDDL selectTargets() is unaware of them and would violate the
       mission silently — stay on the greedy heuristic (already rule-aware above). */
    const teamRulesActive = !!teamConstraints.deliverBatchSize
        || teamConstraints.bonusDeliveryTiles.size > 0
        || teamConstraints.zeroValueDeliveryTiles.size > 0
        || !!teamConstraints.maxParcelReward;

    const somethingToDeliver = (bestParcel !== null) || (hasParcels && bestZone !== null);
    if (USE_PDDL_DELIVERY && !teamRulesActive && now > pddlCooldownUntil && somethingToDeliver) {
        myAgent.push(['pddl_trip']);
        return;
    }

    // Option selection — priority order:

    // 1. FORCED DELIVERY: inventory full or batch target reached.
    if ((isFull || isOverBatch) && bestZone) {
        chooseGoal(['go_deliver', bestZone.x, bestZone.y]);
        return;
    }

    // 2. DELIVERY (with opportunistic pickup): deliver wins on utility, but grab
    //    a very close parcel first if we are not full. Skip if batch not yet met.
    if (hasParcels && bestZone && maxDeliveryUtility > maxPickupUtility && batchSatisfied) {
        if (bestParcel && distance(me, bestParcel) <= OPPORTUNISTIC_RADIUS) {
            chooseGoal(['go_pick_up', bestParcel.x, bestParcel.y, bestParcel.id]);
        } else {
            chooseGoal(['go_deliver', bestZone.x, bestZone.y]);
        }
        return;
    }

    // 3. PICKUP: a parcel beats patrol on expected utility.
    if (bestParcel && maxPickupUtility >= maxPatrolUtility) {
        chooseGoal(['go_pick_up', bestParcel.x, bestParcel.y, bestParcel.id]);
        return;
    }

    // 4. PATROL: no parcels in range worth chasing, explore spawn zones.
    if (bestPatrol) {
        chooseGoal(['patrol', bestPatrol.x, bestPatrol.y]);
        return;
    }

    // 5. FALLBACK (anti-deadlock): bestPatrol requires notVisible (dist > radius),
    //    so on small maps with all spawns inside FOV it is always null. Without
    //    this, the agent pushes no intention at all and freezes — even when a
    //    cached PDDL recovery plan is ready. Push the nearest spawn so AStarMove
    //    can trigger the Sokoban planner if needed.
    if (myBeliefs.spawnZones.length > 0) {
        const nearest = myBeliefs.spawnZones.reduce(
            (best, z) => distance(me, z) < distance(me, best) ? z : best
        );
        chooseGoal(['patrol', nearest.x, nearest.y]);
    }
}

/* ── SENSING LOOP ────────────────────────────────────────────────────────── */
socket.onSensing(async (sensings) => {
    if (me.x === undefined || me.y === undefined) return;
    myBeliefs.updateSensing(sensings, { x: me.x, y: me.y }, sensingRadius);
    optionsGeneration();
});

/* ============================================================================
   INTENTION REVISION — BDI execution engine
============================================================================ */

class IntentionRevision {

    #intention_queue = new Array();
    get intention_queue() { return this.#intention_queue; }

    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {
                const intention = this.intention_queue[0];
                await intention.achieve()
                    .catch(err => {
                        if (!String(err).includes('stopped'))
                            console.log('[INTENTION] failed:', ...intention.predicate, '→', err);
                    });
                this.intention_queue.shift();
            }
            await new Promise(res => setImmediate(res));
        }
    }

    log(...args) { console.log(...args); }
}

/* --------------------------------------------------------------------------
   IntentionRevisionReplace: a new predicate that differs from the current one
   immediately stops and replaces the running plan.

   Implicit inertia: if optionsGeneration pushes the same predicate as what is
   already running, push() detects the match and does nothing — the current plan
   continues uninterrupted (BDI commitment semantics).
-------------------------------------------------------------------------- */
class IntentionRevisionReplace extends IntentionRevision {

    async push(predicate) {

        const last = this.intention_queue.at(this.intention_queue.length - 1);

        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        // Anti-livelock guard: patrol → patrol replacement causes thrashing.
        // During movement the server interpolates position, so two nearby spawns
        // can alternate as "nearest" every tick, giving:
        //   tick 1: patrol (8,6)   → replaces patrol (10,12) → stop
        //   tick 2: patrol (10,12) → replaces patrol (8,6)   → stop  (forever)
        // Fix: if a patrol is already running, ignore any new patrol push — the
        // current one finishes or fails naturally, then optionsGeneration picks
        // the next spawn. High-priority actions (go_pick_up, go_deliver) still
        // interrupt a patrol: this guard fires only for patrol → patrol.
        if (last && last.predicate[0] === 'patrol' && predicate[0] === 'patrol') {
            return;
        }

        const intention = new Intention(this, predicate);
        this.intention_queue.push(intention);
        if (last) last.stop();
    }
}

/* ── INTENTION ───────────────────────────────────────────────────────────── */

class Intention {

    #stopped = false;
    get stopped() { return this.#stopped; }

    #current_plan = null;
    #predicate;
    get predicate() { return this.#predicate; }
    #parent;
    #started = false;

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    stop() {
        this.#stopped = true;
        if (this.#current_plan) this.#current_plan.stop();
    }

    log(...args) {
        if (this.#parent?.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    /* Scan the plan library for the first plan that handles this predicate.
       On failure try the next. Throws if no plan succeeds. */
    async achieve() {
        if (this.#started) return this;
        this.#started = true;

        for (const PlanClass of planLibrary) {
            if (this.stopped) throw ['stopped', ...this.#predicate];

            if (PlanClass.isApplicableTo(...this.#predicate)) {
                this.#current_plan = new PlanClass(this);
                this.log('achieving', ...this.#predicate, 'with plan', PlanClass.name);
                try {
                    const result = await this.#current_plan.execute(...this.#predicate);
                    this.log('success', ...this.#predicate, 'plan', PlanClass.name);
                    return result;
                } catch (error) {
                    this.log('plan', PlanClass.name, 'failed with:', error);
                }
            }
        }

        throw ['no plan found for', ...this.#predicate];
    }
}

/* ── PLAN (base class) ───────────────────────────────────────────────────── */

class Plan {

    #stopped = false;
    get stopped() { return this.#stopped; }
    #sub_intentions = [];
    #parent;

    constructor(parent) { this.#parent = parent; }

    stop() {
        this.#stopped = true;
        for (const i of this.#sub_intentions) i.stop();
    }

    log(...args) {
        if (this.#parent?.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    async subIntention(predicate) {
        const sub = new Intention(this, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }
}

/* ── PLAN LIBRARY ────────────────────────────────────────────────────────── */

/* GoPickUp — navigate to a parcel and pick it up. */
class GoPickUp extends Plan {

    static isApplicableTo(action) {
        return action === 'go_pick_up';
    }

    async execute(action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        // Announce target so the LLM partner doesn't race us to the same parcel.
        emitCoord(`[BDI] going_for ${id}`);

        // Handoff parcels (from pendingFetch) are not blacklisted on nav failure —
        // the LLM partner may still be standing on the tile and about to move off.
        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (!String(err).includes('stopped')) {
                const isHandoff = pendingFetch.some(pf => pf.id === id);
                if (!isHandoff) blacklist.parcels.set(id, Date.now() + BAN_DURATION_MS);
            }
            throw err;
        }

        if (this.stopped) throw ['stopped'];

        const picked = await socket.emitPickup();

        if (this.stopped) throw ['stopped'];

        if (!picked || picked.length === 0) {
            blacklist.parcels.set(id, Date.now() + BAN_DURATION_MS);
            throw ['pickup failed - parcel gone', id];
        }

        emitCoord(`[BDI] picked_up ${id}`);

        return true;
    }
}

/* GoDeliver — navigate to a delivery zone and put down all parcels. */
class GoDeliver extends Plan {

    static isApplicableTo(action) {
        return action === 'go_deliver';
    }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];

        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (!String(err).includes('stopped'))
                blacklist.zones.set(`${Math.round(x)},${Math.round(y)}`, Date.now() + BAN_DURATION_MS);
            throw err;
        }

        if (this.stopped) throw ['stopped'];

        // Safety guard: optionsGeneration already suppresses go_deliver until
        // the batch is met, but this prevents an early delivery if the plan
        // arrives here via an unexpected path in the future.
        const batchN = teamConstraints.deliverBatchSize;
        if (batchN && myBeliefs.getCarriedParcels(me.id).length < batchN) {
            return true;
        }

        await socket.emitPutdown();

        return true;
    }
}

/* Patrol — move to a spawn zone, then mark it (and visible neighbours) as
   visited for SPAWN_COOLDOWN_MS to avoid re-scanning the same cluster. */
class Patrol extends Plan {

    static isApplicableTo(action) {
        return action === 'patrol';
    }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];

        // If the spawn is unreachable (e.g. corridor blocked by a crate), put it
        // on a short cooldown instead of SPAWN_COOLDOWN_MS. A "no path" failure
        // often means a PDDL crate recovery is still in progress (1–3 s), not
        // that the zone is genuinely empty — we want to retry soon, not wait 15 s.
        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (!String(err).includes('stopped'))
                visitedSpawns.set(`${Math.round(x)},${Math.round(y)}`, Date.now() + BAN_DURATION_MS);
            throw err;
        }

        // Mark ALL spawn zones within sensor range as visited, not just (x,y).
        // Without this the agent crawls across adjacent spawns in the same cluster
        // re-scanning the same area. Marking the whole visible region forces
        // optionsGeneration to target a different region next.
        const now = Date.now();
        const center = { x: Math.round(me.x), y: Math.round(me.y) };
        visitedSpawns.set(`${Math.round(x)},${Math.round(y)}`, now + SPAWN_COOLDOWN_MS);
        for (const z of myBeliefs.spawnZones) {
            if (distance(center, z) <= sensingRadius) {
                visitedSpawns.set(`${Math.round(z.x)},${Math.round(z.y)}`, now + SPAWN_COOLDOWN_MS);
            }
        }

        return true;
    }
}

/* PddlDeliveryPlan — means-end reasoning via external PDDL solver.

   Predicate: ['pddl_trip']. The PDDL solver composes the full multi-parcel
   trip (which parcels, what order, which zone) on an abstract POI graph; the
   A* (AStarMove) handles geometry at runtime, avoiding dynamic obstacles.
   If the solver is unreachable or returns no plan, set pddlCooldownUntil and
   fail — the next tick falls through to the greedy heuristic. Already-carried
   parcels appear in the goal state so an interrupted trip is resumed correctly. */
class PddlDeliveryPlan extends Plan {

    static isApplicableTo(action) {
        return action === 'pddl_trip';
    }

    async execute() {
        if (this.stopped) throw ['stopped'];

        // Ephemeral merge of forbidden tiles into the congestion map (same
        // pattern as AStarMove — avoids mutating the persistent congestionMap).
        const pathCongestion = teamConstraints.forbiddenTiles.size === 0
            ? congestionMap
            : new Map([
                ...congestionMap,
                ...[...teamConstraints.forbiddenTiles].map(k => [k, { penalty: 100000, expireAt: Number.MAX_SAFE_INTEGER }]),
            ]);

        // Blacklisted parcels (unreachable or claimed by the LLM via "[LLM] taking")
        // are excluded from the solver's goal state.
        const result = await PddlDeliveryPlanner.plan(me, myBeliefs, {
            congestionMap: pathCongestion,
            excludeIds: new Set(blacklist.parcels.keys()),
            movementDurationMs,
        });

        if (this.stopped) throw ['stopped'];

        if (!result || result.steps.length === 0) {
            pddlCooldownUntil = Date.now() + PDDL_FAIL_COOLDOWN_MS;
            throw ['pddl: no plan (solver unreachable?) → greedy fallback'];
        }

        console.log(`[PDDL-TRIP] ${result.stats.planActions} actions: ${PddlDeliveryPlanner.formatSteps(result.steps)}`);

        // Skip 'go' steps — each 'goto' in the PDDL plan targets the next
        // action's tile, so navigating to it separately would double-move.
        for (const step of result.steps) {
            if (this.stopped) throw ['stopped'];

            if (step.type === 'go') continue;

            if (step.type === 'pickup') {
                if (step.id) emitCoord(`[BDI] going_for ${step.id}`);
                try {
                    await this.subIntention(['go_to', step.x, step.y]);
                } catch (err) {
                    if (!String(err).includes('stopped') && step.id)
                        blacklist.parcels.set(step.id, Date.now() + BAN_DURATION_MS);
                    throw err; // i pacchi già in mano verranno consegnati al re-plan
                }
                if (this.stopped) throw ['stopped'];
                const picked = await socket.emitPickup();
                if (picked && picked.length > 0) {
                    if (step.id) emitCoord(`[BDI] picked_up ${step.id}`);
                } else if (step.id) {
                    // Parcel gone before arrival: short ban, continue the trip.
                    blacklist.parcels.set(step.id, Date.now() + BAN_DURATION_MS);
                }

            } else if (step.type === 'deliver') {
                try {
                    await this.subIntention(['go_to', step.x, step.y]);
                } catch (err) {
                    if (!String(err).includes('stopped'))
                        blacklist.zones.set(`${Math.round(step.x)},${Math.round(step.y)}`, Date.now() + BAN_DURATION_MS);
                    throw err;
                }
                if (this.stopped) throw ['stopped'];
                await socket.emitPutdown();
            }
        }

        return true;
    }
}

/* CrateNavigate — Sokoban-style multi-push navigation via PDDL.

   Invoked only when the best target requires pushing crates in sequence (A*
   returns null). Complete crate knowledge (seeded from '5!' tiles at startup)
   makes the solver reliable. The commit loop in optionsGeneration (re-pushing
   the same predicate) prevents interruption mid-sequence.  isPlanSafe inside
   PddlCratePlanner rejects any plan that disconnects spawn from delivery zones. */
class CrateNavigate extends Plan {

    static isApplicableTo(action) {
        return action === 'crate_nav';
    }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];
        const goal = { x, y };
        crateNavGoal = { x, y };   // keeps the optionsGeneration commit alive

        const crateKeys = myBeliefs.getCrateKeys();
        const agents = myBeliefs.getOtherAgentPositions(me.id);
        console.log(`[CRATE-NAV] solving to (${x},${y}) with ${crateKeys.size} known crates...`);

        let moves;
        try {
            moves = await PddlCratePlanner.getPath(
                me, goal, myBeliefs.map, agents, crateKeys,
                myBeliefs.deliveryZones, myBeliefs.spawnZones
            );
        } catch (err) {
            crateNavGoal = null;
            crateNavBlacklist.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
            throw ['crate_nav solver error', x, y];
        }

        if (this.stopped) { crateNavGoal = null; throw ['stopped']; }

        if (!moves || moves.length === 0) {
            crateNavGoal = null;
            crateNavBlacklist.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
            // If the goal is a delivery zone, also blacklist it as a zone — otherwise
            // chooseGoal keeps re-pushing it via A* (which also fails) for the entire
            // PDDL ban window, wasting dozens of ticks on guaranteed failures.
            if (myBeliefs.deliveryZones.some(z => Math.round(z.x) === x && Math.round(z.y) === y)) {
                blacklist.zones.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
                console.log(`[CRATE-NAV] delivery zone (${x},${y}) unreachable via PDDL → zone blacklist for ${CRATE_NAV_BAN_MS / 1000}s`);
            }
            throw ['crate_nav: no plan', x, y];
        }

        console.log(`[CRATE-NAV] plan of ${moves.length} moves: ${moves.join(' ')}`);

        // Step-by-step execution. On a rejected move (stale beliefs / newly
        // discovered crate), replan inline up to MAX_REPLANS times.
        const MAX_REPLANS = 2;
        let replanCount = 0;
        let i = 0;
        while (i < moves.length) {
            if (this.stopped) { crateNavGoal = null; throw ['stopped']; }
            const result = await socket.emitMove(moves[i]);
            if (this.stopped) { crateNavGoal = null; throw ['stopped']; }
            if (result) {
                me.x = result.x;
                me.y = result.y;
                i++;
            } else {
                // Move rejected — beliefs updated mid-plan (e.g. newly visible crate).
                // Replan from current position with fresh beliefs.
                if (replanCount >= MAX_REPLANS) {
                    console.log(`[CRATE-NAV] move ${moves[i]} rejected after ${replanCount} replans → giving up`);
                    crateNavGoal = null;
                    crateNavBlacklist.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
                    if (myBeliefs.deliveryZones.some(z => Math.round(z.x) === x && Math.round(z.y) === y)) {
                        blacklist.zones.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
                        console.log(`[CRATE-NAV] delivery zone (${x},${y}) unreachable after replan → blacklist`);
                    }
                    throw ['crate_nav: no plan after rejection', x, y];
                }
                replanCount++;
                console.log(`[CRATE-NAV] move ${moves[i]} rejected → replan #${replanCount} from (${Math.round(me.x)},${Math.round(me.y)})`);
                let newMoves;
                try {
                    newMoves = await PddlCratePlanner.getPath(
                        me, goal, myBeliefs.map,
                        myBeliefs.getOtherAgentPositions(me.id),
                        myBeliefs.getCrateKeys(),
                        myBeliefs.deliveryZones, myBeliefs.spawnZones
                    );
                } catch (_) { newMoves = null; }
                if (this.stopped) { crateNavGoal = null; throw ['stopped']; }
                if (!newMoves || newMoves.length === 0) {
                    console.log(`[CRATE-NAV] no alternative plan found → giving up`);
                    crateNavGoal = null;
                    crateNavBlacklist.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
                    if (myBeliefs.deliveryZones.some(z => Math.round(z.x) === x && Math.round(z.y) === y)) {
                        blacklist.zones.set(`${x},${y}`, Date.now() + CRATE_NAV_BAN_MS);
                        console.log(`[CRATE-NAV] delivery zone (${x},${y}) unreachable → blacklist`);
                    }
                    throw ['crate_nav: no plan after rejection', x, y];
                }
                console.log(`[CRATE-NAV] new plan of ${newMoves.length} moves: ${newMoves.join(' ')}`);
                moves = newMoves;
                i = 0;
            }
        }

        crateNavGoal = null;
        console.log(`[CRATE-NAV] arrived at (${x},${y}).`);
        return true;
    }
}

/* AStarMove — low-level navigation plan.
   Recalculates A* from current position every step so the agent adapts to
   dynamic obstacles (moving crates, blocking agents). When USE_PDDL_PLANNER is
   on, the external solver is used instead; A* is the automatic fallback. */
class AStarMove extends Plan {

    static isApplicableTo(action) {
        return action === 'go_to';
    }

    async execute(action, x, y) {
        const goal = { x, y };

        // PDDL plan cache (USE_PDDL_PLANNER mode only): the online solver is too
        // slow to call every step, so we compute the plan once and follow it;
        // recompute only when exhausted or a move is rejected. Unused in A* mode.
        let pddlPath = null;
        let pddlStep = 0;

        let consecutiveFails = 0;

        while (distance(me, goal) > 0) {

            if (this.stopped) throw ['stopped'];

            const crateKeys = myBeliefs.getCrateKeys();

            // criticalZones includes both delivery zones and spawn zones: a push
            // that disconnects us from spawns is just as stranding as one that
            // blocks delivery — this was the root cause of an observed self-lock.
            const criticalZones = [
                { x: Math.round(me.x), y: Math.round(me.y) },
                ...myBeliefs.deliveryZones,
                ...myBeliefs.spawnZones
            ];

            const agents = myBeliefs.getOtherAgentPositions(me.id);

            // Ephemeral merge of forbidden tiles — avoids mutating the persistent
            // congestionMap so removing a [COORD] rule leaves no stale state.
            const pathCongestion = teamConstraints.forbiddenTiles.size === 0
                ? congestionMap
                : new Map([
                    ...congestionMap,
                    ...[...teamConstraints.forbiddenTiles].map(k => [k, { penalty: 100000, expireAt: Number.MAX_SAFE_INTEGER }]),
                ]);

            // If another agent is standing on the goal tile and we are adjacent,
            // abandon — we can never enter while they are there, and retrying
            // would just accumulate penalties. If we are still far away, keep
            // approaching (they may move before we arrive).
            const goalOccupied = agents.some(
                a => Math.round(a.x) === goal.x && Math.round(a.y) === goal.y
            );
            if (goalOccupied && distance(me, goal) <= 1) {
                throw ['goal occupied by agent', x, y];
            }

            let move;

            if (USE_PDDL_PLANNER) {
                // Compute/follow the PDDL plan; fall back to A* if solver fails.
                if (!pddlPath || pddlStep >= pddlPath.length) {
                    pddlPath = await PddlPlanner.getPath(
                        me, goal, myBeliefs.map, agents, [], crateKeys
                    );
                    pddlStep = 0;
                    if (!pddlPath) {
                        pddlPath = Planner.getPath(
                            me, goal, myBeliefs.map, agents, [], pathCongestion,
                            crateKeys, criticalZones
                        );
                    }
                    if (!pddlPath) throw ['no path to', x, y];
                    if (pddlPath.length === 0) break;
                }
                move = pddlPath[pddlStep];

            } else {
                // A* mode (default): recompute every step so crate movements and
                // agent positions are always reflected. If the goal is unreachable
                // even with single-push crate moves, throw 'no path' and let
                // optionsGeneration decide whether to delegate to CrateNavigate.
                const path = Planner.getPath(
                    me, goal, myBeliefs.map, agents, [], pathCongestion,
                    crateKeys, criticalZones
                );
                if (!path) throw ['no path to', x, y];
                if (path.length === 0) break;
                move = path[0];
            }

            const t0 = Date.now();
            const result = await socket.emitMove(move);
            const elapsed = Date.now() - t0;

            if (this.stopped) throw ['stopped'];

            if (result) {
                me.x = result.x;
                me.y = result.y;
                // EMA (α=0.3) — converges to actual server step duration in ~10 steps.
                movementDurationMs = 0.7 * movementDurationMs + 0.3 * elapsed;
                pddlStep++;
                consecutiveFails = 0;
            } else {
                // Move rejected: add a temporary cost to the blocked tile so A*
                // finds an alternative route on the next iteration.
                const blocked = targetTileForMove(me, move);
                const blockedKey = `${blocked.x},${blocked.y}`;
                const existing = congestionMap.get(blockedKey) || { penalty: 0 };
                congestionMap.set(blockedKey, {
                    penalty: existing.penalty + CONGESTION_PENALTY,
                    expireAt: Date.now() + CONGESTION_DURATION_MS
                });
                pddlPath = null;
                consecutiveFails++;
                if (consecutiveFails >= MAX_MOVE_FAILS) {
                    throw ['stuck - too many rejected moves', x, y];
                }
            }
        }

        return true;
    }
}

/* Coordination plans — activated by optionsGeneration when the LLM orchestrator
   sets coordState. They take priority over normal play and run until coordState
   changes, at which point optionsGeneration pushes a different predicate and
   IntentionRevisionReplace stops the current plan. */

// Hold position until released or until the 90 s safety timeout fires
// (guards against a crashed or message-dropping LLM partner).
class CoordIdle extends Plan {
    static isApplicableTo(action) { return action === 'coord_idle'; }
    async execute() {
        const MAX_ITER = 450;   // 450 × 200 ms = 90 s
        for (let i = 0; i < MAX_ITER && !this.stopped; i++) {
            await new Promise(res => setTimeout(res, 200));
        }
        if (!this.stopped) {
            console.log('[COORD] CoordIdle timeout (90 s) — resuming normal play.');
            coordState.mode = null;
        }
        return true;
    }
}

// Move within 'dist' of (x,y), announce arrival, then wait (rendezvous).
// 90 s safety timeout as above.
class CoordGotoWait extends Plan {
    static isApplicableTo(action) { return action === 'coord_goto_wait'; }
    async execute(action, x, y, dist) {
        if (this.stopped) throw ['stopped'];
        const target = coordTargetTile(x, y, dist);
        try {
            await this.subIntention(['go_to', target.x, target.y]);
        } catch (err) {
            if (String(err).includes('stopped')) throw err;
            // Path blocked — announce arrival anyway (best-effort rendezvous).
        }
        if (this.stopped) throw ['stopped'];
        emitCoord('[COORD] arrived');
        console.log('[COORD] arrived, waiting for partner / release.');
        const MAX_ITER = 450;
        for (let i = 0; i < MAX_ITER && !this.stopped; i++) {
            await new Promise(res => setTimeout(res, 200));
        }
        if (!this.stopped) {
            console.log('[COORD] CoordGotoWait timeout (90 s) — resuming normal play.');
            coordState.mode = null;
        }
        return true;
    }
}

// AStarMove must be last: it handles 'go_to', which is a sub-intention used
// by all other plans. Coordination plans come before AStarMove but after
// the gameplay plans so they can still call subIntention(['go_to', ...]).
const planLibrary = [GoPickUp, GoDeliver, Patrol, PddlDeliveryPlan, CrateNavigate, CoordGotoWait, CoordIdle, AStarMove];

const myAgent = new IntentionRevisionReplace();
myAgent.loop();
