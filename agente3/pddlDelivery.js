/* ============================================================================
   FILE: pddlDelivery.js  (agente3)
   SCOPO: Planner ESTERNO PDDL di livello TASK (pick-up & deliver).

   PERCHÉ QUESTO FILE ESISTE (allineamento con le richieste del corso):
   -------------------------------------------------------------------------
   La slide "On the Use of the PDDL Planner" chiede di:
     1. identificare DOVE e QUANDO usare il planner DENTRO l'architettura BDI;
     2. estendere l'agente di conseguenza;
     3. discutere i miglioramenti nel report.
   La griglia di valutazione premia la "problem complexity" del PDDL (20%).

   A differenza di pddlPlanner.js — che usa il PDDL solo per la NAVIGAZIONE
   (un tile = un oggetto, azioni move-*: problema STRIPS a bassa complessità) —
   qui il PDDL risolve il problema di livello superiore: dato un insieme di
   pacchi-obiettivo, COMPORRE UN VIAGGIO che li raccoglie tutti e li consegna
   (sequenza pick-up … pick-up … put-down). Questo è il vero contributo:
   il PIANO multi-pacco viene generato dal solver, non da euristiche a mano.

   DOVE/QUANDO NELLA BDI:
   -------------------------------------------------------------------------
   È il passo di MEANS-END REASONING: trasforma il desiderio "consegna il più
   possibile" in un'INTENZIONE concreta (la sequenza di sub-obiettivi go/pick/
   deliver). Va invocato ai PUNTI DI DELIBERAZIONE (avvio, piano completato,
   target sparito, comparsa di un pacco rilevante) — NON ad ogni tick, perché
   il solver è online e lento. Tra una chiamata e l'altra agisce il layer
   reattivo (A* + intention revision). Se il solver fallisce/è troppo grande,
   plan() ritorna null e il chiamante ricade sull'euristica esistente.

   ASTRAZIONE A GRAFO DI POI (come rispettiamo i limiti del solver):
   -------------------------------------------------------------------------
   NON diamo al solver tutta la griglia. Diamo solo pochi "punti d'interesse":
   la posizione dell'agente, i tile dei pacchi-obiettivo e le delivery zone.
   Le distanze/raggiungibilità reali (muri, casse, nastri) sono calcolate
   dall'A* esistente (planner.js). Risultato: problema PDDL con pochi oggetti
   (≈ 5-15) → solver veloce, ma problema di sequencing/routing significativo.
   L'azione "goto" del dominio = un "salto" tra POI che a runtime sarà espanso
   dall'A* nel cammino geometrico reale.

   LIMITE NOTO (onesto, da scrivere nel report):
   -------------------------------------------------------------------------
   Il dominio è STRIPS puro (niente :action-costs). Il piano è quindi CORRETTO
   (raccoglie e consegna tutti i pacchi selezionati) ma NON garantito ottimo in
   distanza: l'ordine dei pick-up può non minimizzare il cammino. La qualità
   deriva (a) dal pre-filtro dei pacchi per utilità qui sotto e (b) dal fatto
   che il PDDL compone comunque viaggi MULTI-pacco (meglio del greedy a singolo
   target). L'upgrade naturale è :action-costs + :metric (vedi report).

   VINCOLO SDK:
   -------------------------------------------------------------------------
   PddlProblem.toPddlString() genera SEMPRE "(define (problem default)
   (:domain default) ...)" e serializza il goal come "(:goal (<goals>))"
   (un solo livello di parentesi). Perciò:
     - il nostro dominio DEVE chiamarsi "default";
     - per una congiunzione passiamo goals = "and (delivered p0) (delivered p1)".
============================================================================ */

import { onlineSolver, PddlProblem } from "@unitn-asa/pddl-client";
import { Planner } from "./planner.js";

/* ----------------------------------------------------------------------------
   PARAMETRI DI DEFAULT (sovrascrivibili dal chiamante via cfg).
---------------------------------------------------------------------------- */
const DEFAULTS = {
    maxParcels: 8,    // pacchi-obiettivo massimi nel problema (tiene il solver veloce)
    maxZones: 4,      // delivery zone più vicine da includere
    maxLocations: 40, // tetto di sicurezza sul numero totale di POI (oggetti location)
    movementDurationMs: 50, // stima passo per il decay nel ranking (solo euristica locale)
};

/* ----------------------------------------------------------------------------
   DOMINIO PDDL (statico) — STRIPS puro.

   Il dominio DEVE chiamarsi "default" (vincolo di PddlProblem, vedi header).

   Predicati:
     (at ?loc)            : l'agente si trova nel POI ?loc
     (parcel-at ?p ?loc)  : il pacco ?p è a terra nel POI ?loc
     (carrying ?p)        : l'agente trasporta il pacco ?p
     (delivered ?p)       : il pacco ?p è stato consegnato (obiettivo)
     (delivery ?loc)      : ?loc è una delivery zone

   Azioni:
     goto    : spostarsi da un POI a un altro (a runtime → cammino A*)
     pickup  : raccogliere un pacco presente nel POI corrente
     putdown : consegnare un pacco trasportato, su una delivery zone

   NB: tutte le precondizioni sono POSITIVE → basta :strips (massima
   compatibilità con il solver online). Gli effetti negativi (not ...) sono
   parte dello STRIPS classico e non richiedono :negative-preconditions.
---------------------------------------------------------------------------- */
const DOMAIN_STRING = `\
;; domain file: domain-deliveroo-delivery.pddl  (generato da pddlDelivery.js)
(define (domain default)
    (:requirements :strips)
    (:predicates
        (at ?loc)
        (parcel-at ?p ?loc)
        (carrying ?p)
        (delivered ?p)
        (delivery ?loc)
    )

    (:action goto
        :parameters (?from ?to)
        :precondition (at ?from)
        :effect (and (at ?to) (not (at ?from)))
    )

    (:action pickup
        :parameters (?p ?loc)
        :precondition (and (at ?loc) (parcel-at ?p ?loc))
        :effect (and (carrying ?p) (not (parcel-at ?p ?loc)))
    )

    (:action putdown
        :parameters (?p ?loc)
        :precondition (and (at ?loc) (carrying ?p) (delivery ?loc))
        :effect (and (delivered ?p) (not (carrying ?p)))
    )
)`;

/* ----------------------------------------------------------------------------
   Helper geometrici locali.
---------------------------------------------------------------------------- */
const manhattan = (a, b) =>
    Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.y) - Math.round(b.y));

export class PddlDeliveryPlanner {

    // Espone il dominio (utile per log/report/test manuale sul solver del corso).
    static get domain() { return DOMAIN_STRING; }

    /* ========================================================================
       plan(me, beliefs, cfg) — il punto di ingresso.

       Costruisce il problema PDDL dalle beliefs correnti, interroga il solver
       online e traduce il piano in una sequenza di STEP di alto livello che il
       chiamante (la Plan Library del BDI) sa eseguire come sub-intention.

       Parametri:
         - me      : { x, y, id }  posizione e id dell'agente
         - beliefs : istanza di Beliefs (map, parcels, deliveryZones, helper…)
         - cfg     : override opzionali (vedi DEFAULTS) + opzionali:
                       congestionMap : Map per l'A* (default vuota)
                       criticalZones : array {x,y} per il check push dell'A*
                       excludeIds    : Set di parcelId da NON pianificare
                                       (es. pacchi reclamati dall'agente LLM)

       Ritorna:
         - { steps, stats, problemPddl, domainPddl }  in caso di successo
             steps: [
               { type:'go',      x, y },
               { type:'pickup',  id, x, y },
               { type:'deliver', x, y }
             ]
         - null  se: niente da pianificare / nessuna delivery zone raggiungibile /
                 problema troppo grande / solver irraggiungibile / nessun piano.
                 → il chiamante ricade sull'euristica (optionsGeneration).
    ======================================================================== */
    static async plan(me, beliefs, cfg = {}) {
        const C = { ...DEFAULTS, ...cfg };

        // 1+2) Selezione POI + costruzione del problema PDDL (senza rete).
        const prep = PddlDeliveryPlanner.prepare(me, beliefs, C);
        if (!prep) return null; // niente da fare / consegna impossibile / troppo grande
        const { problem, built, sel } = prep;

        // 3) Interrogazione del solver online (errori di rete → fallback null).
        let plan;
        try {
            plan = await onlineSolver(DOMAIN_STRING, problem.toPddlString());
        } catch (err) {
            console.log('[PDDL-DELIVERY] solver error → fallback:', err?.message || err);
            return null;
        }

        // Nessun piano (goal irraggiungibile secondo il solver) o piano vuoto.
        if (!plan || plan.length === 0) return null;

        // 4) Traduzione del piano PDDL in step di alto livello eseguibili.
        const steps = [];
        for (const raw of plan) {
            const action = String(raw.action).toLowerCase();
            const args = (raw.args || []).map(a => String(a).toLowerCase());

            if (action === 'goto') {
                const to = built.locXY.get(args[1]);
                if (!to) continue; // arg inatteso: lo ignoriamo (robustezza)
                steps.push({ type: 'go', x: to.x, y: to.y });

            } else if (action === 'pickup') {
                const parcel = built.parcelByName.get(args[0]);
                const loc = built.locXY.get(args[1]);
                if (!loc) continue;
                steps.push({
                    type: 'pickup',
                    id: parcel ? parcel.id : null,
                    x: loc.x, y: loc.y
                });

            } else if (action === 'putdown') {
                const loc = built.locXY.get(args[1]);
                if (!loc) continue;
                // Più pacchi consegnati sulla stessa zona producono putdown
                // consecutivi: a runtime emitPutdown() scarica TUTTO in una volta,
                // quindi collassiamo i deliver ripetuti sullo stesso tile.
                const prev = steps[steps.length - 1];
                if (prev && prev.type === 'deliver' && prev.x === loc.x && prev.y === loc.y) continue;
                steps.push({ type: 'deliver', x: loc.x, y: loc.y });

            } else {
                // Azione sconosciuta nel piano: meglio non eseguire piani ambigui.
                console.log('[PDDL-DELIVERY] azione sconosciuta nel piano:', raw.action);
                return null;
            }
        }

        if (steps.length === 0) return null;

        return {
            steps,
            stats: {
                targets: sel.targets.length,
                carried: sel.carried.length,
                zones: sel.zones.length,
                locations: built.locCount,
                planActions: plan.length,
            },
            problemPddl: problem.toPddlString(),
            domainPddl: DOMAIN_STRING,
        };
    }

    /* ========================================================================
       prepare(me, beliefs, C) — selezione POI + costruzione problema PDDL.
       Tutto in LOCALE (nessuna rete): utile sia per plan() sia per ispezionare
       il problema generato (test/report) senza interrogare il solver.

       Ritorna { problem (PddlProblem), built, sel } oppure null.
    ======================================================================== */
    static prepare(me, beliefs, cfg = {}) {
        const C = { ...DEFAULTS, ...cfg };

        const sel = PddlDeliveryPlanner.selectTargets(me, beliefs, C);
        if (!sel) return null;

        const built = PddlDeliveryPlanner.buildProblem(me, sel, C);
        if (!built) return null;

        const problem = new PddlProblem(
            'deliveroo-delivery', built.objects, built.init, built.goal
        );
        return { problem, built, sel };
    }

    /* ========================================================================
       buildProblemPddl(me, beliefs, C) — restituisce il PROBLEMA PDDL come
       stringa (e qualche statistica), SENZA chiamare il solver.
       Comodo per validazione manuale e per allegare il problema al report.
    ======================================================================== */
    static buildProblemPddl(me, beliefs, cfg = {}) {
        const prep = PddlDeliveryPlanner.prepare(me, beliefs, cfg);
        if (!prep) return null;
        return {
            problemPddl: prep.problem.toPddlString(),
            domainPddl: DOMAIN_STRING,
            stats: {
                targets: prep.sel.targets.length,
                carried: prep.sel.carried.length,
                zones: prep.sel.zones.length,
                locations: prep.built.locCount,
            },
        };
    }

    /* ========================================================================
       selectTargets(me, beliefs, C) — sceglie i POI da mettere nel problema.

       - Pacchi-obiettivo: i pacchi a terra raggiungibili (A*), ordinati per
         utilità reward²/dist (decay-aware), troncati a maxParcels. Sono i
         pacchi il cui (delivered ...) finirà nel goal.
       - Pacchi in mano: vanno comunque consegnati → entrano nel goal.
       - Delivery zone: le più vicine raggiungibili, troncate a maxZones.

       Ritorna { targets:[{id,x,y}], carried:[{id}], zones:[{x,y}] } oppure null
       se non c'è nulla da consegnare o nessuna zona è raggiungibile.
    ======================================================================== */
    static selectTargets(me, beliefs, C) {
        const map = beliefs.map;
        const crateKeys = beliefs.getCrateKeys();
        const agents = beliefs.getOtherAgentPositions(me.id);
        const congestion = C.congestionMap || new Map();
        // (Layer 1 anti-self-stranding, vedi agent.js/AStarMove) include anche
        // le spawn zone nel default, non solo le delivery zone.
        const critical = C.criticalZones || [...beliefs.deliveryZones, ...beliefs.spawnZones];
        const excludeIds = C.excludeIds || new Set();

        // Helper: esiste un cammino A* da 'from' a 'to'? (raggiungibilità reale)
        const reachable = (to) => {
            const path = Planner.getPath(
                me, to, map, agents, [], congestion, crateKeys, critical
            );
            return path !== null; // [] (già lì) o lista mosse = raggiungibile
        };

        // --- Pacchi in mano: sempre da consegnare ---
        const carried = beliefs.getCarriedParcels(me.id).map(p => ({ id: p.id }));

        // --- Pacchi a terra: ranking utilità + filtro raggiungibilità ---
        const rate = beliefs.getDecayRatePerMs();
        const now = Date.now();
        const estReward = (p, distSteps) => {
            const elapsed = now - (p.lastSeen ?? now);
            return Math.max(0, p.reward - (elapsed + distSteps * C.movementDurationMs) * rate);
        };

        const ground = beliefs.getAvailableParcels()
            .filter(p => !excludeIds.has(p.id))
            .map(p => {
                const d = Math.max(1, manhattan(me, p));
                const rew = estReward(p, d);
                return { id: p.id, x: Math.round(p.x), y: Math.round(p.y), util: (rew * rew) / d, rew };
            })
            .filter(p => p.rew > 0)              // scarta pacchi già scaduti all'arrivo
            .sort((a, b) => b.util - a.util)     // BEST FIRST
            .slice(0, C.maxParcels)
            .filter(p => reachable(p));          // tieni solo i raggiungibili (A*)

        // Se non c'è proprio nulla da consegnare, non pianifichiamo (→ patrol).
        if (ground.length === 0 && carried.length === 0) return null;

        // --- Delivery zone: nearest-first, raggiungibili, troncate ---
        const zones = beliefs.deliveryZones
            .map(z => ({ x: Math.round(z.x), y: Math.round(z.y), d: manhattan(me, z) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, C.maxZones)
            .filter(z => reachable(z));

        // Senza una delivery zone raggiungibile il goal è impossibile → fallback.
        if (zones.length === 0) return null;

        return {
            targets: ground.map(p => ({ id: p.id, x: p.x, y: p.y })),
            carried,
            zones,
        };
    }

    /* ========================================================================
       buildProblem(me, sel, C) — genera objects / init / goal + lookup.

       Deduplica i POI per coordinata (lo stesso tile è un solo oggetto), così
       agente/pacco/zona che coincidono condividono il medesimo "locK".

       Ritorna { objects, init, goal, locXY, parcelByName, locCount } oppure
       null se il numero di location supera maxLocations.
    ======================================================================== */
    static buildProblem(me, sel, C) {
        // Tabella coordinata "x,y" → nome PDDL "locK" (con dedup).
        const coordToLoc = new Map();
        // Tabella inversa nome → {x,y}, usata per tradurre il piano in step.
        const locXY = new Map();
        let locSeq = 0;

        const locOf = (x, y) => {
            const key = `${Math.round(x)},${Math.round(y)}`;
            let name = coordToLoc.get(key);
            if (!name) {
                name = `loc${locSeq++}`;
                coordToLoc.set(key, name);
                locXY.set(name, { x: Math.round(x), y: Math.round(y) });
            }
            return name;
        };

        const initFacts = [];

        // Posizione corrente dell'agente.
        const agentLoc = locOf(me.x, me.y);
        initFacts.push(`(at ${agentLoc})`);

        // Pacchi a terra: oggetto pK + fatto (parcel-at pK locDelPacco).
        const parcelByName = new Map(); // "pK" → { id }
        const goalParcelNames = [];
        let parcelSeq = 0;

        for (const t of sel.targets) {
            const pName = `p${parcelSeq++}`;
            parcelByName.set(pName, { id: t.id });
            const loc = locOf(t.x, t.y);
            initFacts.push(`(parcel-at ${pName} ${loc})`);
            goalParcelNames.push(pName);
        }

        // Pacchi in mano: oggetto pK + fatto (carrying pK) (nessuna location).
        for (const c of sel.carried) {
            const pName = `p${parcelSeq++}`;
            parcelByName.set(pName, { id: c.id });
            initFacts.push(`(carrying ${pName})`);
            goalParcelNames.push(pName);
        }

        // Delivery zone: fatto (delivery locK) per ciascuna.
        for (const z of sel.zones) {
            const loc = locOf(z.x, z.y);
            initFacts.push(`(delivery ${loc})`);
        }

        // Tetto di sicurezza sul numero di POI (mantiene il solver rapido).
        if (locSeq > C.maxLocations) {
            console.log(`[PDDL-DELIVERY] troppi POI (${locSeq} > ${C.maxLocations}) → fallback.`);
            return null;
        }

        // Stringa oggetti: tutte le location + tutti i pacchi.
        const objects = [...locXY.keys(), ...parcelByName.keys()].join(' ');

        // Goal come congiunzione: PddlProblem lo avvolge in "(:goal ( ... ))",
        // quindi passiamo "and (delivered p0) (delivered p1) ...".
        const goal = 'and ' + goalParcelNames.map(n => `(delivered ${n})`).join(' ');

        return {
            objects,
            init: initFacts.join(' '),
            goal,
            locXY,
            parcelByName,
            locCount: locSeq,
        };
    }

    /* ========================================================================
       formatSteps(steps) — rende leggibile un piano per i log.
       Es.: "go(5,7) → pickup#abc(5,7) → go(0,0) → deliver(0,0)"
    ======================================================================== */
    static formatSteps(steps) {
        return steps.map(s => {
            if (s.type === 'go') return `go(${s.x},${s.y})`;
            if (s.type === 'pickup') return `pickup${s.id ? '#' + s.id : ''}(${s.x},${s.y})`;
            if (s.type === 'deliver') return `deliver(${s.x},${s.y})`;
            return s.type;
        }).join(' → ');
    }
}
