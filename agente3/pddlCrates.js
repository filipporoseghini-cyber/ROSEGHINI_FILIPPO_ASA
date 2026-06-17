/* ============================================================================
   FILE: pddlCrates.js  (agente3)
   SCOPO: Planner ESTERNO PDDL di RECUPERO per ostacoli mobili (casse, Sokoban-
   style), invocato da AStarMove SOLO quando l'A* locale (planner.js) dichiara
   un percorso irraggiungibile.

   PERCHÉ QUESTO FILE ESISTE:
   -------------------------------------------------------------------------
   planner.js (agente3) tratta le casse come MURI assoluti: su mappe Sokoban
   non è in grado di ragionare su sequenze multi-spinta. Questo file fornisce
   il recupero PDDL per quei casi, calcolando l'intera sequenza di push con
   backtracking (STRIPS). pddlPlanner.js (navigazione pura) fa lo stesso:
   tratta le casse come muri e non modella push.

   CASO REALE CHE HA MOTIVATO QUESTO FILE:
   -------------------------------------------------------------------------
   Sulla mappa di test "crates_one_way": il BDI raccoglie pacchi, spinge
   l'unica cassa di un corridoio nell'unica direzione valida, consegna — ma
   al ritorno l'A* fallisce con 'no path to' verso la spawn zone: quella
   spinta era irreversibile dall'angolo da cui si torna normalmente.
   (Layer 1, in agent.js/AStarMove e pddlDelivery.js, riduce la frequenza di
   questi casi includendo le spawn zone tra le criticalZones controllate da
   checkConnectivity; questo file - Layer 2 - è il recupero per quando anche
   quella guardia non basta, es. mappe come "crates_maze" con più casse
   interdipendenti.)

   DOMINIO (estende lo STILE di pddlPlanner.js: un oggetto per TILE, non per
   punto d'interesse — qui conta la geometria fine attorno agli ostacoli):
   -------------------------------------------------------------------------
   Predicati:
     (at ?t)                 : l'agente è sulla tile ?t
     (right/left/up/down ?a ?b) : adiacenza FILTRATA per i nastri direzionali
                                  (stessa generazione di pddlPlanner.js: niente
                                  fact se l'ingresso in ?b è contromano). Usata
                                  per il movimento dell'agente.
     (adj-right/left/up/down ?a ?b) : adiacenza GREZZA, non filtrata. Verificato
                                  sul server (Controller.js): la regola di
                                  spinta NON applica la restrizione dei nastri
                                  alla tile di destinazione della CASSA, solo
                                  "type inizia per 5" e "nessun'altra cassa lì".
                                  Riusare la versione filtrata anche per la
                                  destinazione della spinta rifiuterebbe spinte
                                  valide.
     (crate-at ?c ?t)         : la cassa ?c è sulla tile ?t
     (yellow ?t)              : ?t può ricevere una cassa spinta (type "5"/"5!")
     (crate-free ?t)          : nessuna cassa è su ?t — asserito esplicitamente
                                  per OGNI tile percorribile nello scope, non
                                  solo le gialle (STRIPS è closed-world: un
                                  fatto omesso è falso, quindi un'omissione
                                  bloccherebbe per errore una mossa su una
                                  tile vuota).

   Azioni: move-right/left/up/down (= quelle di pddlPlanner.js + precondizione
   crate-free sulla destinazione) e push-right/left/up/down (sposta la cassa
   di una tile nella stessa direzione, l'agente prende il posto della cassa).

   TRADUZIONE PIANO → MOSSE:
   -------------------------------------------------------------------------
   Sul server una spinta è semplicemente una move normale (Controller.js):
   non esiste un comando "push" separato, lo decide il server in base a cosa
   c'è sulla tile di destinazione. Quindi le 8 azioni del dominio collassano
   tutte sulla stessa stringa-mossa per direzione (move-right/push-right →
   'right', ecc.) — stesso contratto di ritorno di Planner.getPath e
   PddlPlanner.getPath: Array di mosse, [] se già al goal, null se irrisolvibile.

   SCOPING (per restare piccolo e veloce — niente POI qui, serve la griglia):
   -------------------------------------------------------------------------
   Bounding box tra start e goal con margine proporzionale alla distanza,
   espansa una volta per includere le casse appena fuori dal box (così una
   destinazione di spinta valida ma laterale non viene tagliata per errore).
   Tetti di sicurezza MAX_PDDL_CRATE_TILES / MAX_PDDL_CRATES: se superati,
   niente chiamata al solver, si ritorna null e l'agente resta sul fallimento
   originale (nessun rischio, è un recupero best-effort).

   LIMITE NOTO (da scrivere nel report): dominio STRIPS puro, nessuna garanzia
   di ottimalità sul numero di spinte — solo correttezza (se un piano esiste
   nello scope, lo trova).
============================================================================ */

import { onlineSolver, PddlProblem } from "@unitn-asa/pddl-client";

/* Ceilings are lower than MAX_PDDL_TILES (pddlPlanner.js, 600) because push
   actions increase the solver's branching factor significantly. This is a
   local recovery planner, not the primary navigation planner. */
const MAX_PDDL_CRATE_TILES = 150;
const MAX_PDDL_CRATES = 20;   // copre i labirinti densi del corso (crates_maze = 18)

const DIRECTIONS = {
    right: { dx:  1, dy:  0, pred: 'right' },
    left:  { dx: -1, dy:  0, pred: 'left'  },
    up:    { dx:  0, dy:  1, pred: 'up'    },
    down:  { dx:  0, dy: -1, pred: 'down'  },
};

const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);
const ARROW_PROHIBITED_ENTRY = {
    '→': 'left',
    '←': 'right',
    '↑': 'down',
    '↓': 'up',
};

// All 8 plan actions collapse to a plain move string: on the server a push
// is just a move into a tile that happens to have a pushable crate on it.
const ACTION_TO_MOVE = {
    'move-right': 'right', 'push-right': 'right',
    'move-left':  'left',  'push-left':  'left',
    'move-up':    'up',    'push-up':    'up',
    'move-down':  'down',  'push-down':  'down',
};

const DOMAIN_STRING = `\
;; domain file: domain-deliveroo-crates.pddl (generato da pddlCrates.js)
(define (domain default)
    (:requirements :strips)
    (:predicates
        (at ?t)
        (right ?from ?to)
        (left ?from ?to)
        (up ?from ?to)
        (down ?from ?to)
        (adj-right ?a ?b)
        (adj-left ?a ?b)
        (adj-up ?a ?b)
        (adj-down ?a ?b)
        (crate-at ?c ?t)
        (yellow ?t)
        (crate-free ?t)
    )

    (:action move-right
        :parameters (?from ?to)
        :precondition (and (at ?from) (right ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-left
        :parameters (?from ?to)
        :precondition (and (at ?from) (left ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-up
        :parameters (?from ?to)
        :precondition (and (at ?from) (up ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-down
        :parameters (?from ?to)
        :precondition (and (at ?from) (down ?from ?to) (crate-free ?to))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action push-right
        :parameters (?c ?from ?to ?dest)
        :precondition (and (at ?from) (right ?from ?to) (crate-at ?c ?to)
                            (adj-right ?to ?dest) (yellow ?dest) (crate-free ?dest))
        :effect (and (at ?to) (not (at ?from))
                     (crate-at ?c ?dest) (not (crate-at ?c ?to))
                     (not (crate-free ?dest)) (crate-free ?to))
    )
    (:action push-left
        :parameters (?c ?from ?to ?dest)
        :precondition (and (at ?from) (left ?from ?to) (crate-at ?c ?to)
                            (adj-left ?to ?dest) (yellow ?dest) (crate-free ?dest))
        :effect (and (at ?to) (not (at ?from))
                     (crate-at ?c ?dest) (not (crate-at ?c ?to))
                     (not (crate-free ?dest)) (crate-free ?to))
    )
    (:action push-up
        :parameters (?c ?from ?to ?dest)
        :precondition (and (at ?from) (up ?from ?to) (crate-at ?c ?to)
                            (adj-up ?to ?dest) (yellow ?dest) (crate-free ?dest))
        :effect (and (at ?to) (not (at ?from))
                     (crate-at ?c ?dest) (not (crate-at ?c ?to))
                     (not (crate-free ?dest)) (crate-free ?to))
    )
    (:action push-down
        :parameters (?c ?from ?to ?dest)
        :precondition (and (at ?from) (down ?from ?to) (crate-at ?c ?to)
                            (adj-down ?to ?dest) (yellow ?dest) (crate-free ?dest))
        :effect (and (at ?to) (not (at ?from))
                     (crate-at ?c ?dest) (not (crate-at ?c ?to))
                     (not (crate-free ?dest)) (crate-free ?to))
    )
)`;

export class PddlCratePlanner {

    static get domain() { return DOMAIN_STRING; } // for testing / manual inspection

    /* Plan cache — avoids re-calling the solver for the same (start, goal,
       crate config) within a session.

       Key: "startX,startY→goalX,goalY:crateHash"  where crateHash is the
       sorted, joined set of crate position strings. The key changes
       automatically when any crate moves, so no explicit invalidation needed.
       Value: validated move array. Capacity: MAX_CACHE_SIZE (FIFO eviction). */
    static #cache = new Map();
    static #MAX_CACHE_SIZE = 30;

    static #crateHash(crateKeys) {
        return [...crateKeys].sort().join(';');
    }

    static #cacheKey(startX, startY, goalX, goalY, crateKeys) {
        return `${startX},${startY}→${goalX},${goalY}:${PddlCratePlanner.#crateHash(crateKeys)}`;
    }

    /* ------------------------------------------------------------------------
       getPath() — stesso contratto di Planner.getPath / PddlPlanner.getPath:
       Array di mosse, [] se start===goal, null se non risolvibile (mappa/scope
       troppo grande, solver irraggiungibile, nessun piano trovato).

       Parametri:
         - start, goal : { x, y }
         - mapBeliefs  : Map "x,y" → tile (Beliefs.map)
         - agents      : altri agenti { x, y } (ostacoli, eccetto il goal)
         - crateKeys   : Set "x,y" con le posizioni attuali delle casse
         - criticalZones : (non usato qui — il dominio PDDL ragiona già su
           tutto lo scope; la guardia "non isolare zone critiche" rimane
           compito di checkConnectivity in planner.js, usato dall'A* prima di
           arrivare a invocare questo recupero)
    ------------------------------------------------------------------------ */
    static async getPath(start, goal, mapBeliefs, agents = [], crateKeys = new Set(), deliveryZones = [], spawnZones = []) {
        const startX = Math.round(start.x), startY = Math.round(start.y);
        const goalX  = Math.round(goal.x),  goalY  = Math.round(goal.y);

        if (startX === goalX && startY === goalY) return [];

        if (!mapBeliefs.has(`${startX},${startY}`)) return null;
        if (!mapBeliefs.has(`${goalX},${goalY}`))   return null;

        if (!PddlCratePlanner.goalHasEmptyApproach(goalX, goalY, mapBeliefs, crateKeys, agents)) {
            console.log('[PDDL-CRATES] goal has no valid approach; unreachable.');
            return null;
        }

        const cacheKey = PddlCratePlanner.#cacheKey(startX, startY, goalX, goalY, crateKeys);
        const cached = PddlCratePlanner.#cache.get(cacheKey);
        if (cached !== undefined) {
            console.log(`[PDDL-CRATES] cache hit (${cached.length} moves) — skipping solver.`);
            return cached.slice(); // defensive copy
        }

        const built = PddlCratePlanner.buildProblemString(
            startX, startY, goalX, goalY, mapBeliefs, agents, crateKeys
        );
        if (!built) return null; // scope too large → bail out, no network call

        const problem = new PddlProblem('deliveroo-crates', built.objects, built.init, built.goal);

        let plan;
        try {
            plan = await onlineSolver(DOMAIN_STRING, problem.toPddlString());
        } catch (err) {
            console.log('[PDDL-CRATES] solver error, fallback:', err?.message || err);
            return null;
        }

        if (!plan || plan.length === 0) return null;

        const moves = [];
        for (const step of plan) {
            const move = ACTION_TO_MOVE[String(step.action).toLowerCase()];
            if (!move) {
                console.log('[PDDL-CRATES] unknown action in plan:', step.action);
                return null;
            }
            moves.push(move);
        }

        // Safety validation: the STRIPS solver reaches the goal but is blind to
        // global connectivity. Reject any plan whose final crate state disconnects
        // spawn zones from delivery zones (no-regression invariant). Plans that
        // push crates temporarily and restore them always pass because the final
        // crate configuration is identical to the initial one.
        if (!PddlCratePlanner.isPlanSafe(moves, startX, startY, crateKeys, mapBeliefs, deliveryZones, spawnZones)) {
            console.log('[PDDL-CRATES] plan REJECTED: final crate state would disconnect spawn from delivery (or invalid push).');
            return null;
        }

        PddlCratePlanner.#cache.set(cacheKey, moves);
        if (PddlCratePlanner.#cache.size > PddlCratePlanner.#MAX_CACHE_SIZE) {
            // Map preserves insertion order — remove the oldest entry.
            PddlCratePlanner.#cache.delete(PddlCratePlanner.#cache.keys().next().value);
        }

        return moves;
    }

    /* isPlanSafe() — returns true if the FINAL crate state of the plan does not
       reduce spawn-zone → delivery-zone connectivity versus the initial state,
       AND every individual push is physically valid.

       "No-regression" invariant: a plan may not disconnect any spawn zone that
       was reachable before. Plans that move crates temporarily and restore them
       always satisfy this because the final configuration equals the initial one. */
    static isPlanSafe(moves, startX, startY, crateKeys, mapBeliefs, deliveryZones, spawnZones) {
        if (!deliveryZones || deliveryZones.length === 0) return true;
        if (!spawnZones || spawnZones.length === 0) return true;

        // Multi-source BFS from delivery zones; returns the set of spawn zones
        // reachable from at least one delivery zone in crate configuration 'crates'.
        const servedSpawns = (crates) => {
            const visited = new Set();
            const queue = [];
            for (const d of deliveryZones) {
                const k = `${Math.round(d.x)},${Math.round(d.y)}`;
                if (mapBeliefs.has(k) && !crates.has(k) && !visited.has(k)) { visited.add(k); queue.push(k); }
            }
            while (queue.length > 0) {
                const cur = queue.shift();
                const comma = cur.indexOf(',');
                const cx = Number(cur.slice(0, comma)), cy = Number(cur.slice(comma + 1));
                for (const dir of Object.values(DIRECTIONS)) {
                    const nk = `${cx + dir.dx},${cy + dir.dy}`;
                    if (visited.has(nk)) continue;
                    const tile = mapBeliefs.get(nk);
                    if (!tile || String(tile.type) === '0') continue;
                    if (crates.has(nk)) continue;
                    visited.add(nk);
                    queue.push(nk);
                }
            }
            return new Set(
                spawnZones
                    .map(s => `${Math.round(s.x)},${Math.round(s.y)}`)
                    .filter(k => visited.has(k))
            );
        };

        const servedInitial = servedSpawns(crateKeys);

        // Simulate to the FINAL crate state, validating each push along the way.
        let ax = startX, ay = startY;
        const crates = new Set(crateKeys);
        for (const move of moves) {
            const d = DIRECTIONS[move];
            if (!d) continue;
            const nx = ax + d.dx, ny = ay + d.dy;
            const nk = `${nx},${ny}`;
            if (crates.has(nk)) {
                const bx = nx + d.dx, by = ny + d.dy;
                const bk = `${bx},${by}`;
                const bt = mapBeliefs.get(bk);
                // Physical validity: push destination must be a yellow tile, exist, and be free.
                if (!bt || !String(bt.type).startsWith('5') || crates.has(bk)) return false;
                crates.delete(nk);
                crates.add(bk);
            }
            ax = nx; ay = ny;
        }

        const servedFinal = servedSpawns(crates);
        return servedFinal.size >= servedInitial.size;
    }

    /* buildProblemString() — scoping and PDDL object/init/goal generation,
       entirely local (no network). Returns { objects, init, goal } or null if
       the scope exceeds safety ceilings. */
    static buildProblemString(startX, startY, goalX, goalY, mapBeliefs, agents, crateKeys) {
        const tileName = (x, y) => `t_${x}_${y}`;

        const agentObstacles = new Set(agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`));

        const isWalkable = (x, y, isGoal) => {
            const tile = mapBeliefs.get(`${x},${y}`);
            if (!tile || String(tile.type) === '0') return false;
            if (agentObstacles.has(`${x},${y}`) && !isGoal) return false;
            return true;
            // Le tile con una cassa sopra restano "percorribili" come oggetto
            // PDDL: non sono escluse qui, sono semplicemente non crate-free
            // (vedi sotto) — l'agente potrebbe doverle attraversare spingendo.
        };

        // 1) SCOPING. Course maps are small (10x10). If the ENTIRE map fits
        //    within the safety ceiling, include it all — no bounding-box or
        //    per-relevance pruning. Reason (crates_maze lesson): in a dense maze
        //    the region reachable WITHOUT pushing is tiny, so pruning "distant"
        //    crates (which then become walls) makes the puzzle unsolvable. With
        //    the full problem the solver resolves the 18-crate maze in ~3 s.
        const allWalkable = [];
        for (const [key, tile] of mapBeliefs) {
            if (String(tile.type) === '0') continue;
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma)), y = Number(key.slice(comma + 1));
            if (isWalkable(x, y, x === goalX && y === goalY)) allWalkable.push({ x, y });
        }

        let walkable;
        if (allWalkable.length <= MAX_PDDL_CRATE_TILES) {
            walkable = allWalkable;                          // small map → use all
        } else {
            // Mappa grande: bounding-box start↔goal, espanso per le casse vicine.
            const dx = Math.abs(goalX - startX), dy = Math.abs(goalY - startY);
            const margin = Math.min(8, Math.max(4, Math.ceil(0.5 * Math.max(dx, dy))));
            let minX = Math.min(startX, goalX) - margin, maxX = Math.max(startX, goalX) + margin;
            let minY = Math.min(startY, goalY) - margin, maxY = Math.max(startY, goalY) + margin;
            for (const key of crateKeys) {
                const comma = key.indexOf(',');
                const cx = Number(key.slice(0, comma)), cy = Number(key.slice(comma + 1));
                if (cx >= minX - 3 && cx <= maxX + 3 && cy >= minY - 3 && cy <= maxY + 3) {
                    minX = Math.min(minX, cx - 3); maxX = Math.max(maxX, cx + 3);
                    minY = Math.min(minY, cy - 3); maxY = Math.max(maxY, cy + 3);
                }
            }
            walkable = [];
            for (let x = minX; x <= maxX; x++)
                for (let y = minY; y <= maxY; y++)
                    if (isWalkable(x, y, x === goalX && y === goalY)) walkable.push({ x, y });
            if (!walkable.some(t => t.x === startX && t.y === startY)) walkable.push({ x: startX, y: startY });
            if (!walkable.some(t => t.x === goalX && t.y === goalY))   walkable.push({ x: goalX, y: goalY });
            if (walkable.length > MAX_PDDL_CRATE_TILES) {
                console.log(`[PDDL-CRATES] scope too large (${walkable.length} tiles > ${MAX_PDDL_CRATE_TILES}), giving up.`);
                return null;
            }
        }

        const walkableSet = new Set(walkable.map(t => `${t.x},${t.y}`));

        // 2) Include ALL crates within scope — every crate may matter in a maze.
        //    Cap on solver branching: if genuinely too many (large maps) keep the
        //    closest ones; excluded crates stay as hard walls via the
        //    "unmodelled crate = no crate-free fact" rule.
        let cratesInScope = [];
        for (const key of crateKeys) {
            if (!walkableSet.has(key)) continue;
            const comma = key.indexOf(',');
            cratesInScope.push({ x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) });
        }
        if (cratesInScope.length > MAX_PDDL_CRATES) {
            cratesInScope.sort((a, b) => {
                const da = Math.min(Math.abs(a.x - startX) + Math.abs(a.y - startY), Math.abs(a.x - goalX) + Math.abs(a.y - goalY));
                const db = Math.min(Math.abs(b.x - startX) + Math.abs(b.y - startY), Math.abs(b.x - goalX) + Math.abs(b.y - goalY));
                return da - db;
            });
            console.log(`[PDDL-CRATES] too many crates (${cratesInScope.length} > ${MAX_PDDL_CRATES}), keeping ${MAX_PDDL_CRATES} closest.`);
            cratesInScope = cratesInScope.slice(0, MAX_PDDL_CRATES);
        }

        const crateTileKeys = new Set(cratesInScope.map(c => `${c.x},${c.y}`));

        // 4) Oggetti + fatti.
        const objects = [];
        const initFacts = [];

        for (const t of walkable) {
            const name = tileName(t.x, t.y);
            objects.push(name);

            const tile = mapBeliefs.get(`${t.x},${t.y}`);
            if (String(tile.type).startsWith('5')) initFacts.push(`(yellow ${name})`);

            // crate-free only if NO crate is there in the FULL crateKeys set
            // (not just the modelled subset). An out-of-scope crate must not
            // silently become free space: without this the solver plans pushes
            // onto tiles that are actually occupied. An unmodelled crate = wall:
            // no crate-free and no crate-at → neither walkable nor pushable.
            if (!crateKeys.has(`${t.x},${t.y}`)) initFacts.push(`(crate-free ${name})`);

            for (const dir of Object.values(DIRECTIONS)) {
                const nx = t.x + dir.dx, ny = t.y + dir.dy;
                const nKey = `${nx},${ny}`;
                if (!walkableSet.has(nKey)) continue;
                const nName = tileName(nx, ny);

                // Raw adjacency for push destinations: the server does not apply
                // the conveyor restriction to where a crate lands, only to agent movement.
                initFacts.push(`(adj-${dir.pred} ${name} ${nName})`);

                // Filtered adjacency for agent movement: block conveyor entry against flow.
                const neighborTile = mapBeliefs.get(nKey);
                const arrowBlocked = ARROW_TYPES.has(neighborTile.type) &&
                                      ARROW_PROHIBITED_ENTRY[neighborTile.type] === dir.pred;
                if (!arrowBlocked) {
                    initFacts.push(`(${dir.pred} ${name} ${nName})`);
                }
            }
        }

        for (let i = 0; i < cratesInScope.length; i++) {
            const c = cratesInScope[i];
            objects.push(`c${i}`);
            initFacts.push(`(crate-at c${i} ${tileName(c.x, c.y)})`);
        }

        initFacts.push(`(at ${tileName(startX, startY)})`);

        return {
            objects: objects.join(' '),
            init: initFacts.join(' '),
            goal: `at ${tileName(goalX, goalY)}`,
        };
    }

    static goalHasEmptyApproach(goalX, goalY, mapBeliefs, crateKeys, agents) {
        const agentObstacles = new Set(agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`));
        const keyOf = (x, y) => `${x},${y}`;
        const tileAt = (x, y) => mapBeliefs.get(keyOf(x, y));

        const directionName = (fromX, fromY, toX, toY) => {
            const dx = toX - fromX;
            const dy = toY - fromY;
            if (dx === 1 && dy === 0) return 'right';
            if (dx === -1 && dy === 0) return 'left';
            if (dx === 0 && dy === 1) return 'up';
            if (dx === 0 && dy === -1) return 'down';
            return null;
        };

        const allowsExit = (tile, dir) => {
            if (!tile || !ARROW_TYPES.has(tile.type)) return true;
            return tile.type === '→' ? dir === 'right'
                : tile.type === '←' ? dir === 'left'
                : tile.type === '↑' ? dir === 'up'
                : tile.type === '↓' ? dir === 'down'
                : true;
        };

        const allowsEntry = (tile, dir) => {
            if (!tile || !ARROW_TYPES.has(tile.type)) return true;
            return ARROW_PROHIBITED_ENTRY[tile.type] !== dir;
        };

        const isWalkable = (x, y, allowGoal = false) => {
            const key = keyOf(x, y);
            const tile = tileAt(x, y);
            if (!tile || String(tile.type) === '0') return false;
            if (agentObstacles.has(key) && !allowGoal) return false;
            if (crateKeys.has(key)) return false;
            return true;
        };

        const canEnter = (fromX, fromY, toX, toY) => {
            const fromTile = tileAt(fromX, fromY);
            const toTile = tileAt(toX, toY);
            if (!fromTile || !toTile || String(toTile.type) === '0') return false;

            const dir = directionName(fromX, fromY, toX, toY);
            if (!dir) return false;

            return allowsExit(fromTile, dir) && allowsEntry(toTile, dir);
        };

        const canPushCrateFromNeighbor = (crateX, crateY) => {
            if (!crateKeys.has(keyOf(crateX, crateY))) return false;

            for (const { dx, dy } of Object.values(DIRECTIONS)) {
                const destX = crateX + dx;
                const destY = crateY + dy;
                const destKey = keyOf(destX, destY);
                const destTile = tileAt(destX, destY);

                if (!destTile || String(destTile.type) === '0') continue;
                if (!String(destTile.type).startsWith('5')) continue;
                if (crateKeys.has(destKey)) continue;
                if (agentObstacles.has(destKey)) continue;
                if (destX === goalX && destY === goalY) continue;

                const pushFromX = crateX - dx;
                const pushFromY = crateY - dy;
                if (!isWalkable(pushFromX, pushFromY, pushFromX === goalX && pushFromY === goalY)) continue;
                if (!canEnter(pushFromX, pushFromY, crateX, crateY)) continue;
                if (!canEnter(crateX, crateY, goalX, goalY)) continue;

                return true;
            }
            return false;
        };

        const neighbors = [
            { dx: 1, dy: 0 },
            { dx: -1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 0, dy: -1 },
        ];

        for (const { dx, dy } of neighbors) {
            const nx = goalX + dx;
            const ny = goalY + dy;
            const key = keyOf(nx, ny);
            const tile = tileAt(nx, ny);

            if (!tile || String(tile.type) === '0') continue;

            if (!crateKeys.has(key) && isWalkable(nx, ny, true) && canEnter(nx, ny, goalX, goalY)) {
                return true;
            }

            if (crateKeys.has(key) && canPushCrateFromNeighbor(nx, ny)) {
                return true;
            }
        }

        return false;
    }
}
