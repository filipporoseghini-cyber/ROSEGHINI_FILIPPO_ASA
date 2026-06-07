/* ============================================================================
   FILE: pddlPlanner.js  (agente3)
   SCOPO: Planner ESTERNO basato su PDDL (Planning Domain Definition Language).

   PERCHÉ QUESTO FILE ESISTE (allineamento con le richieste del corso):
   -------------------------------------------------------------------------
   Le slide del progetto (slide 2 e 9) richiedono esplicitamente l'uso di un
   "external planner component": l'agente non deve solo muoversi con euristiche
   fatte a mano, ma deve poter DELEGARE la pianificazione a un planner esterno
   che, dato un DOMINIO e un PROBLEMA in PDDL, restituisce un PIANO (sequenza di
   azioni) da eseguire. Questo è esattamente l'argomento del Lab5
   (lab5-APIsForPlanning) e del laboratorio PDDL del corso.

   COS'È IL PDDL?
   -------------------------------------------------------------------------
   PDDL è un linguaggio standard dell'AI Planning per descrivere:
     - un DOMINIO  : i predicati (fatti del mondo) e le AZIONI con le loro
                     precondizioni ed effetti (logica STRIPS);
     - un PROBLEMA : gli oggetti concreti, lo stato iniziale (:init) e
                     l'obiettivo da raggiungere (:goal).
   Un "solver" (qui un servizio online, planning-as-a-service) prende dominio +
   problema e cerca una sequenza di azioni che trasforma lo stato iniziale nello
   stato goal. Quella sequenza È il piano.

   COSA MODELLIAMO QUI:
   -------------------------------------------------------------------------
   Il problema di NAVIGAZIONE sulla griglia di Deliveroo. Ogni casella
   percorribile diventa un oggetto PDDL "t_x_y"; le adiacenze tra caselle
   diventano predicati direzionali (right/left/up/down); l'agente parte da una
   casella (:init "(at t_startx_starty)") e l'obiettivo è raggiungere la casella
   destinazione (:goal "(at t_goalx_goaly)"). Le quattro azioni move-* spostano
   il token "at" da una casella all'adiacente nella direzione corrispondente.
   Il piano restituito è quindi una sequenza di mosse ['right','up',...] che ha
   ESATTAMENTE lo stesso formato dell'output dell'A* (planner.js): questo rende
   PddlPlanner.getPath un rimpiazzo "drop-in" di Planner.getPath.

   STRATEGIA IBRIDA (perché non buttiamo via l'A*):
   -------------------------------------------------------------------------
   Il solver è ONLINE: ogni chiamata è un round-trip di rete + tempo di
   planning. Su mappe grandi è più lento dell'A* locale. Per questo:
     - usiamo il PDDL come planner esterno DIMOSTRABILE (richiesto dal corso);
     - se la mappa è troppo grande, o il solver è offline / fallisce / non
       trova un piano, restituiamo null e il chiamante (AStarMove) ricade
       automaticamente sull'A* locale.
   Così l'agente resta sempre giocabile, ma può esibire la pianificazione PDDL.

   NOTA SUL NOME DEL DOMINIO:
   -------------------------------------------------------------------------
   La classe PddlProblem dell'SDK genera SEMPRE "(:domain default)" nel file di
   problema. Per farli combaciare, il nostro dominio DEVE chiamarsi "default".
============================================================================ */

import { onlineSolver, PddlProblem } from "@unitn-asa/pddl-client";
import { Planner } from "./planner.js";

/* ----------------------------------------------------------------------------
   LIMITE DI SICUREZZA SULLA DIMENSIONE DEL PROBLEMA
   Generare un problema PDDL con migliaia di caselle produce un file enorme e
   un solver lentissimo. Oltre questa soglia rinunciamo al PDDL e lasciamo che
   il chiamante usi l'A* (più veloce e locale). 600 caselle percorribili coprono
   comodamente le mappe tipiche del corso.
---------------------------------------------------------------------------- */
const MAX_PDDL_TILES = 600;

/* ----------------------------------------------------------------------------
   DOMINIO PDDL (statico) — logica STRIPS pura.

   Predicati:
     (at ?t)            : l'agente ("me") si trova sulla casella ?t
     (right ?from ?to)  : ?to è la casella immediatamente a DESTRA di ?from
     (left  ?from ?to)  : ?to è a SINISTRA di ?from
     (up    ?from ?to)  : ?to è SOPRA ?from   (in Deliveroo 'up' aumenta Y)
     (down  ?from ?to)  : ?to è SOTTO ?from   ('down' diminuisce Y)

   Le adiacenze sono generate dinamicamente nel problema (solo quelle PERCORRIBILI
   e consentite, vedi buildProblemString): così il solver non può mai pianificare
   attraverso muri, casse o nastri presi contromano.

   Ogni azione move-* sposta il token (at ...) dalla casella di partenza a quella
   di arrivo: precondizione = essere su ?from ed esistere l'adiacenza direzionale;
   effetto = ora si è su ?to e non più su ?from.
---------------------------------------------------------------------------- */
const DOMAIN_STRING = `\
;; domain file: domain-deliveroo-grid.pddl  (generato da pddlPlanner.js)
(define (domain default)
    (:requirements :strips)
    (:predicates
        (at ?t)
        (right ?from ?to)
        (left ?from ?to)
        (up ?from ?to)
        (down ?from ?to)
    )

    (:action move-right
        :parameters (?from ?to)
        :precondition (and (at ?from) (right ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-left
        :parameters (?from ?to)
        :precondition (and (at ?from) (left ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-up
        :parameters (?from ?to)
        :precondition (and (at ?from) (up ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action move-down
        :parameters (?from ?to)
        :precondition (and (at ?from) (down ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
)`;

/* ----------------------------------------------------------------------------
   TABELLE DI SUPPORTO (identiche alla logica di planner.js per coerenza)
---------------------------------------------------------------------------- */

// Le 4 direzioni di movimento e il loro vettore di spostamento.
// Convenzione Deliveroo: 'up' aumenta Y, 'down' diminuisce Y.
const DIRECTIONS = {
    right: { dx:  1, dy:  0, pred: 'right' },
    left:  { dx: -1, dy:  0, pred: 'left'  },
    up:    { dx:  0, dy:  1, pred: 'up'    },
    down:  { dx:  0, dy: -1, pred: 'down'  },
};

// Caratteri dei nastri direzionali (caselle a senso unico).
const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);

// tipo-freccia → direzione di INGRESSO vietata (stessa regola del backend e
// di planner.js): non si può ENTRARE in un nastro muovendosi contromano.
const ARROW_PROHIBITED_ENTRY = {
    '→': 'left',
    '←': 'right',
    '↑': 'down',
    '↓': 'up',
};

// nome azione PDDL → mossa Deliveroo da inviare al server.
const ACTION_TO_MOVE = {
    'move-right': 'right',
    'move-left':  'left',
    'move-up':    'up',
    'move-down':  'down',
};

export class PddlPlanner {

    /* ------------------------------------------------------------------------
       getPath() — VERSIONE PDDL del pathfinding (asincrona!).

       Stessa firma e stesso valore di ritorno di Planner.getPath, così è un
       sostituto drop-in. ATTENZIONE: qui è async perché interroga un solver
       online; il chiamante deve usare `await`.

       Parametri:
         - start      : { x, y } posizione di partenza
         - goal       : { x, y } posizione di arrivo
         - mapBeliefs : Map "x,y" → tile (da Beliefs.map)
         - agents     : array di altri agenti { x, y } (ostacoli dinamici)
         - parcels    : (ignorato qui, presente solo per parità di firma con A*)
         - crateKeys  : Set di "x,y" con le casse (trattate come muri nel PDDL,
                        non modelliamo il push lato planner)

       Ritorna (come l'A*):
         - Array di mosse  es. ['right','up','up']
         - Array vuoto []  se siamo già sulla casella goal
         - null            se: mappa troppo grande / problema non risolvibile /
                           solver irraggiungibile  → il chiamante userà l'A*.
    ------------------------------------------------------------------------ */
    static async getPath(start, goal, mapBeliefs, agents = [], parcels = [], crateKeys = new Set()) {

        const startX = Math.round(start.x), startY = Math.round(start.y);
        const goalX  = Math.round(goal.x),  goalY  = Math.round(goal.y);

        // Caso banale: siamo già sul goal → nessuna mossa.
        if (startX === goalX && startY === goalY) return [];

        // Sanity check: start e goal devono esistere nella mappa.
        if (!mapBeliefs.has(`${startX},${startY}`)) return null;
        if (!mapBeliefs.has(`${goalX},${goalY}`))   return null;

        // Costruiamo (oggetti, init, adiacenze) per il problema PDDL.
        const built = PddlPlanner.buildProblemString(
            startX, startY, goalX, goalY, mapBeliefs, agents, crateKeys
        );
        // null = mappa troppo grande → lasciamo decidere all'A*.
        if (!built) return null;

        const problem = new PddlProblem(
            'deliveroo-move',
            built.objects,   // lista oggetti "t_x_y ..."
            built.init,      // adiacenze + "(at t_startx_starty)"
            built.goal       // "at t_goalx_goaly"
        );

        // Interroghiamo il solver online. Qualsiasi errore di rete / parsing
        // viene catturato: in quel caso ritorniamo null e l'A* prende il posto.
        let plan;
        try {
            plan = await onlineSolver(DOMAIN_STRING, problem.toPddlString());
        } catch (err) {
            console.log('[PDDL] solver error, fallback ad A*:', err?.message || err);
            return null;
        }

        // Nessun piano trovato (goal irraggiungibile secondo il solver).
        if (!plan || plan.length === 0) {
            // plan === [] può anche significare "0 azioni" (già al goal), ma quel
            // caso l'abbiamo già gestito sopra; qui lo trattiamo come "nessun piano".
            return null;
        }

        // Traduciamo il piano PDDL (azioni move-*) in mosse Deliveroo.
        // NB: alcuni solver restituiscono i nomi azione in MAIUSCOLO
        // (es. "MOVE-UP"), quindi normalizziamo a minuscolo prima del lookup.
        const moves = [];
        for (const step of plan) {
            const move = ACTION_TO_MOVE[String(step.action).toLowerCase()];
            if (!move) {
                // Azione inattesa: meglio non eseguire un piano ambiguo → A*.
                console.log('[PDDL] azione sconosciuta nel piano:', step.action);
                return null;
            }
            moves.push(move);
        }
        return moves;
    }

    /* ------------------------------------------------------------------------
       buildProblemString() — genera oggetti, stato iniziale e goal del problema.

       Scorre la mappa, individua le caselle PERCORRIBILI e, per ciascuna,
       emette i predicati di adiacenza verso i vicini raggiungibili, applicando
       le stesse regole dell'A*:
         - i muri (type '0') e le caselle inesistenti non sono percorribili;
         - le casse (crateKeys) sono trattate come muri (no push nel PDDL);
         - una casella occupata da un altro agente non è attraversabile,
           TRANNE se è proprio il goal (altrimenti non potremmo pianificarci);
         - non si può ENTRARE in un nastro direzionale contromano.

       Ritorna { objects, init, goal } come stringhe pronte per PddlProblem,
       oppure null se la mappa supera MAX_PDDL_TILES.
    ------------------------------------------------------------------------ */
    static buildProblemString(startX, startY, goalX, goalY, mapBeliefs, agents, crateKeys) {

        // Nome PDDL di una casella: "t_x_y". Usiamo underscore perché gli
        // identificatori PDDL non possono contenere virgole o caratteri speciali.
        const tileName = (x, y) => `t_${x}_${y}`;

        // Set delle caselle occupate da altri agenti (ostacoli dinamici).
        const agentObstacles = new Set(
            agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`)
        );

        // Una casella è "percorribile" se esiste, non è muro ('0'), non è una
        // cassa e non è occupata da un agente (a meno che non sia il goal).
        const isWalkable = (x, y) => {
            const key = `${x},${y}`;
            const tile = mapBeliefs.get(key);
            if (!tile || String(tile.type) === '0') return false;
            if (crateKeys.has(key)) return false;
            if (agentObstacles.has(key) && !(x === goalX && y === goalY)) return false;
            return true;
        };

        // 1) Raccogliamo tutte le caselle percorribili (gli oggetti del problema).
        const walkable = [];
        for (const [key, tile] of mapBeliefs.entries()) {
            if (String(tile.type) === '0') continue;          // muro
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            if (!isWalkable(x, y)) continue;
            walkable.push({ x, y });
        }

        // Assicuriamoci che il goal sia tra gli oggetti anche se occupato da un
        // agente (isWalkable lo concede già, ma lo includiamo per robustezza).
        const goalKey = `${goalX},${goalY}`;
        if (!walkable.some(t => t.x === goalX && t.y === goalY) && mapBeliefs.has(goalKey)) {
            walkable.push({ x: goalX, y: goalY });
        }

        // Guardia di dimensione: oltre la soglia, conviene l'A*.
        if (walkable.length > MAX_PDDL_TILES) {
            console.log(`[PDDL] mappa troppo grande (${walkable.length} tile > ${MAX_PDDL_TILES}), uso A*.`);
            return null;
        }

        // 2) Stringa degli oggetti: "t_x_y t_a_b ...".
        const objects = walkable.map(t => tileName(t.x, t.y)).join(' ');

        // 3) Predicati di adiacenza nello stato iniziale.
        const initFacts = [];
        for (const { x, y } of walkable) {
            for (const dir of Object.values(DIRECTIONS)) {
                const nx = x + dir.dx;
                const ny = y + dir.dy;

                // Il vicino deve essere percorribile.
                if (!isWalkable(nx, ny)) continue;

                // Regola dei nastri: non si entra in una freccia contromano.
                const neighborTile = mapBeliefs.get(`${nx},${ny}`);
                if (
                    ARROW_TYPES.has(neighborTile.type) &&
                    ARROW_PROHIBITED_ENTRY[neighborTile.type] === dirNameOf(dir)
                ) {
                    continue;
                }

                // Emettiamo l'adiacenza direzionale: es. "(right t_x_y t_nx_ny)".
                initFacts.push(`(${dir.pred} ${tileName(x, y)} ${tileName(nx, ny)})`);
            }
        }

        // Fatto iniziale: l'agente si trova sulla casella di partenza.
        initFacts.push(`(at ${tileName(startX, startY)})`);

        // 4) Goal: raggiungere la casella destinazione.
        const goal = `at ${tileName(goalX, goalY)}`;

        return {
            objects,
            init: initFacts.join(' '),
            goal,
        };
    }
}

/* ----------------------------------------------------------------------------
   Helper: dato l'oggetto direzione, ne restituisce il nome ('right'/'left'/...).
   Serve solo per confrontarlo con ARROW_PROHIBITED_ENTRY, che è indicizzato per
   nome direzione. (DIRECTIONS.pred coincide col nome, ma teniamo l'helper
   esplicito per leggibilità.)
---------------------------------------------------------------------------- */
function dirNameOf(dir) {
    return dir.pred; // 'right' | 'left' | 'up' | 'down'
}
