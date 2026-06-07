/* ============================================================================
   FILE: agent.js  (versione BDI - agente3)
   ARCHITETTURA: BDI (Belief-Desire-Intention) con pianificazione A*

   COS'È L'ARCHITETTURA BDI?
   BDI è un modello teorico per agenti intelligenti, composto da tre elementi:

   - BELIEFS (Credenze): ciò che l'agente SA sul mondo. Sono gestite in beliefs.js.
     Esempio: "il pacco P è in posizione (3,5)" oppure "la casella (2,2) è un muro".

   - DESIRES (Desideri) / OPTIONS: ciò che l'agente VORREBBE fare, generato
     dalla funzione optionsGeneration(). Non tutte le opzioni diventano intenzioni.
     Esempio: "vorrei raccogliere il pacco P", "vorrei consegnare i pacchi".

   - INTENTIONS (Intenzioni): l'obiettivo che l'agente ha DECISO di perseguire
     in questo momento. Viene eseguito da un piano concreto scelto dalla libreria.
     Esempio: l'agente ha DECISO di raccogliere P e sta eseguendo il piano GoPickUp.

   FLUSSO DI ESECUZIONE:
   1. socket.onSensing() → aggiorna le Beliefs e chiama optionsGeneration()
   2. optionsGeneration() → calcola l'utilità di ogni opzione e sceglie la migliore,
      poi la "spinge" nell'agente tramite myAgent.push(predicate)
   3. IntentionRevisionReplace.push() → se il nuovo obiettivo è diverso da quello
      corrente, interrompe il piano in corso e avvia il nuovo
   4. Intention.achieve() → scorre la Plan Library finché trova un piano applicabile
   5. Piano.execute() → esegue le azioni concrete (emitMove, emitPickup, ecc.)
      usando il Planner A* per navigare

   DIFFERENZE RISPETTO ALLA VERSIONE FSM (agente2):
   - Rimosso il Watchdog (sostituito dal meccanismo stop/fail delle Intentions)
   - Rimossa la Congestion Map (semplificazione: impatto minimo sull'efficienza)
   - Aggiunta struttura BDI formale: Intention, IntentionRevision, Plan Library
   - L'inerzia decisionale è ora implicita: se il target non cambia, il piano
     non viene interrotto (IntentionRevisionReplace.push non fa nulla se il
     predicato è identico a quello già in esecuzione)
============================================================================ */

import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import { Beliefs } from "./beliefs.js";
import { Planner } from "./planner.js";
import { PddlPlanner } from "./pddlPlanner.js";

/* ============================================================================
   SEZIONE 1: SETUP GLOBALE
   Variabili e strutture dati condivise da tutto il file.
============================================================================ */

/* ----------------------------------------------------------------------------
   FLAG: PLANNER ESTERNO PDDL vs A* LOCALE
   -------------------------------------------------------------------------
   Le slide del corso (2 e 9) richiedono un "external planner component".
   Questo flag sceglie QUALE planner usa AStarMove per la navigazione:
     - true  → planner PDDL (pddlPlanner.js): genera dominio+problema STRIPS e
               interroga un solver online (planning-as-a-service). È la modalità
               da mostrare all'esame per dimostrare la competenza PDDL.
               Se il solver fallisce / la mappa è troppo grande, ricade
               AUTOMATICAMENTE sull'A* (nessun blocco di gioco).
     - false → A* locale (planner.js): veloce, deterministico, default per il
               gameplay reale.
   Si può attivare anche da variabile d'ambiente: USE_PDDL_PLANNER=true.
---------------------------------------------------------------------------- */
const USE_PDDL_PLANNER = String(process.env.USE_PDDL_PLANNER).toLowerCase() === 'true';

// Sistema di credenze dell'agente (beliefs.js).
const myBeliefs = new Beliefs();

// Dati sull'agente stesso: vengono aggiornati ad ogni evento 'onYou' del server.
const me = {};

/* --------------------------------------------------------------------------
   COSTANTI DI COMPORTAMENTO
   Definiscono il "carattere" dell'agente: quanto è avido, quanto è paziente.
-------------------------------------------------------------------------- */
let movementDurationMs = 50;  // Stima della durata di ogni passo in ms.
// Si auto-calibra misurando il tempo reale delle mosse (EMA α=0.3).
// Il valore converge al vero movement_duration del server in ~10 passi.
const EXPECTED_SPAWN_VALUE = 4;    // Valore medio atteso di un pacco su una spawn zone
const MAX_CAPACITY = 18;    // Numero massimo di pacchi trasportabili
const OPPORTUNISTIC_RADIUS = 5;    // Raggio entro cui deviare per raccogliere un pacco
// anche quando si sta andando a consegnare
const SPAWN_COOLDOWN_MS = 15000; // Millisecondi di "cooldown" per una spawn visitata
const BAN_DURATION_MS = 3000;  // Millisecondi di ban per obiettivi irraggiungibili
const MAX_MOVE_FAILS = 5;      // Mosse consecutive rifiutate prima di abbandonare
// un obiettivo (anti-stallo: evita di sbattere all'infinito contro un agente fermo)
const CONGESTION_PENALTY = 100; // Penalità aggiunta al costo A* per tile bloccati
const CONGESTION_DURATION_MS = 5000; // TTL di ogni voce nella congestion map
const SENSING_RADIUS = parseInt(process.env.SENSING_RADIUS ?? '5'); // Raggio visivo in tile
// (x_offset + y_offset < sensing_distance).
// Deve corrispondere al parametro del server.
// Configurabile in .env: SENSING_RADIUS=5

/* --------------------------------------------------------------------------
   MEMORIE TEMPORANEE GLOBALI
   Strutture dati che persistono tra un ciclo di sensing e l'altro.
-------------------------------------------------------------------------- */

// Blacklist: obiettivi temporaneamente esclusi perché irraggiungibili.
// Format: ID/coordinate → timestamp di scadenza del ban
const blacklist = {
    parcels: new Map(), // pacchi irraggiungibili
    zones: new Map()  // zone di consegna irraggiungibili
};

// Mappa di congestione: tile su cui una mossa è stata rifiutata dal server.
// Format: "x,y" → { penalty: number, expireAt: timestamp }
// Viene passata al planner A* per aumentare il costo di quei tile.
const congestionMap = new Map();

// Memoria del pattugliamento: zone di spawn già visitate di recente.
// Evita che l'agente continui a tornare sulle stesse caselle vuote.
const visitedSpawns = new Map();

/* --------------------------------------------------------------------------
   FUNZIONE DISTANZA MANHATTAN
   Calcola il numero minimo di passi tra due punti su una griglia 4-connessa.
   Usiamo Math.round() perché le coordinate possono avere piccoli valori decimali.
-------------------------------------------------------------------------- */
function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    return Math.abs(Math.round(x1) - Math.round(x2)) + Math.abs(Math.round(y1) - Math.round(y2));
}

/* --------------------------------------------------------------------------
   estimateRewardAtArrival(parcel, distSteps)

   Stima il reward di un pacco al momento in cui l'agente vi arriverebbe,
   tenendo conto di due componenti di decadimento:
     1. Elapsed: tempo già trascorso dal momento dell'ultimo sensing (il pacco
        sta decadendo anche mentre l'agente sta facendo altro).
     2. Travel: tempo necessario a percorrere 'distSteps' passi fino al pacco.

   Se il reward stimato è ≤ 0, il pacco sarà scaduto prima dell'arrivo
   e non vale la pena inseguirlo.
-------------------------------------------------------------------------- */
function estimateRewardAtArrival(parcel, distSteps) {
    const rate = myBeliefs.getDecayRatePerMs();
    const elapsed = Date.now() - (parcel.lastSeen ?? Date.now());
    const travel = distSteps * movementDurationMs;
    return Math.max(0, parcel.reward - (elapsed + travel) * rate);
}

/* ============================================================================
   SEZIONE 2: CONNESSIONE AL SERVER
============================================================================ */

const socket = DjsConnect(process.env.HOST, process.env.TOKEN);

socket.onConnect(() => {
    console.log("[SYSTEM] Connesso. Architettura BDI con pianificazione A* attiva.");
});

// Ricezione mappa statica: una sola volta all'avvio.
socket.onMap((width, height, tiles) => {
    if (!tiles || typeof tiles[Symbol.iterator] !== 'function') return;
    myBeliefs.updateMap(tiles);
});

// Aggiornamento posizione, punteggio e penalità ad ogni tick.
socket.onYou((data) => {
    me.id = data.id;
    me.name = data.name;
    me.x = data.x;
    me.y = data.y;
    me.score = data.score;

    // Rileva se il server ci ha assegnato una nuova penalità.
    // 'penalty' è un numero ≤ 0: diminuisce ad ogni azione invalida.
    // Il server disconnette automaticamente l'agente se scende sotto -1000.
    const prevPenalty = me.penalty ?? 0;
    me.penalty = data.penalty ?? 0;
    const delta = prevPenalty - me.penalty; // positivo = penalità appena incassata
    if (delta > 0) {
        console.warn(`[PENALTY] -${delta} pti | totale: ${me.penalty} | score: ${me.score}`);
    }
});

// Ricezione messaggi di coordinazione (es. dall'Agente LLM)
socket.on('msg', (id, name, msg, replyCallback) => {
    console.log(`\n[MSG IN] Da ${name}: ${msg}`);
    if (replyCallback) replyCallback('Messaggio ricevuto!');
    
    // Semplice logica di coordinazione: se l'LLM ci dice che sta andando 
    // a prendere un pacco specifico, lo ignoriamo temporaneamente (blacklist).
    const match = msg.match(/taking parcel\s+(\S+)/i);
    if (match && match[1]) {
        const parcelId = match[1];
        console.log(`[COORDINATION] Ignoro il pacco ${parcelId} per 10 secondi.`);
        blacklist.parcels.set(parcelId, Date.now() + 10000);
    }
});

/* ============================================================================
   SEZIONE 3: GENERAZIONE DELLE OPZIONI (il layer "Desires" del BDI)

   Questa funzione implementa il ragionamento strategico dell'agente.
   Viene chiamata ad ogni ciclo di sensing e produce UN'opzione (il predicato
   migliore) da spingere nell'IntentionRevision.

   Un PREDICATO è un Array che descrive un'azione in forma dichiarativa:
     ['go_pick_up', x, y, id]  → "vai a raccogliere il pacco id in (x,y)"
     ['go_deliver', x, y]      → "vai a consegnare i pacchi nella zona (x,y)"
     ['patrol', x, y]          → "vai a pattugliare la zona spawn in (x,y)"
============================================================================ */
function optionsGeneration() {

    // Non deliberiamo se non abbiamo ancora ricevuto la nostra posizione.
    if (me.x === undefined || me.y === undefined) return;

    const now = Date.now();

    /* -- Pulizia blacklist, memoria pattugliamento e congestion map scaduti -- */
    for (const [id, exp] of blacklist.parcels.entries()) if (now > exp) blacklist.parcels.delete(id);
    for (const [coord, exp] of blacklist.zones.entries()) if (now > exp) blacklist.zones.delete(coord);
    for (const [coord, exp] of visitedSpawns.entries()) if (now > exp) visitedSpawns.delete(coord);
    for (const [coord, data] of congestionMap.entries()) if (now > data.expireAt) congestionMap.delete(coord);

    /* ---- RACCOLTA DATI ---- */

    const pacchiDisponibili = myBeliefs.getAvailableParcels()
        .filter(p => !blacklist.parcels.has(p.id));

    const zoneConsegnaValide = myBeliefs.deliveryZones
        .filter(z => !blacklist.zones.has(`${z.x},${z.y}`));

    const pacchiInMano = myBeliefs.getCarriedParcels(me.id);
    const carryCount = pacchiInMano.length;
    const isFull = carryCount >= MAX_CAPACITY;
    const hasParcels = carryCount > 0;

    /* ---- CALCOLO UTILITÀ: RACCOGLIERE UN PACCO ---- */
    // Utilità = rewardStimato² / distanza
    // Il reward stimato include il decadimento già accumulato dal momento
    // dell'ultimo sensing + quello che maturerà durante il percorso verso il pacco.
    // Se il pacco sarà già scaduto quando arriviamo, lo saltiamo del tutto.
    let bestParcel = null, maxPickupUtility = -1;
    for (const p of pacchiDisponibili) {
        const dist = Math.max(0.1, distance(me, p));
        const rewardAtArrival = estimateRewardAtArrival(p, dist);
        if (rewardAtArrival <= 0) continue;
        const utility = Math.pow(rewardAtArrival, 2) / dist;
        if (utility > maxPickupUtility) { maxPickupUtility = utility; bestParcel = p; }
    }

    /* ---- CALCOLO UTILITÀ: CONSEGNARE I PACCHI IN MANO ---- */
    let bestZone = null, maxDeliveryUtility = -1;
    if (hasParcels) {
        // Valore attuale dei pacchi in mano: sottraiamo il decay già maturato
        // dal momento dell'ultimo sensing a oggi (i pacchi decadono anche
        // mentre l'agente si muove, non solo quando il server li aggiorna).
        const rate = myBeliefs.getDecayRatePerMs();
        const now = Date.now();
        const currentCarriedReward = pacchiInMano.reduce((s, p) => {
            const elapsed = now - (p.lastSeen ?? now);
            return s + Math.max(0, p.reward - elapsed * rate);
        }, 0);

        for (const z of zoneConsegnaValide) {
            const dist = Math.max(0.1, distance(me, z));
            const travelDecay = dist * movementDurationMs * rate;
            const expectedReward = Math.max(0.1, currentCarriedReward - travelDecay);
            const utility = Math.pow(expectedReward, 2) / dist;
            if (utility > maxDeliveryUtility) { maxDeliveryUtility = utility; bestZone = z; }
        }
    }

    /* ---- CALCOLO UTILITÀ: PATTUGLIARE UNA ZONA SPAWN ---- */
    // Escludiamo le spawn già nel raggio visivo: i loro pacchi sono già in
    // pacchiDisponibili, e se sono vuote non c'è nulla da scoprire andendoci.
    // Escludiamo anche le zone visitate di recente (cooldown).
    const notVisible = z => distance(me, z) > SENSING_RADIUS;
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
            const dist = distance(me, z); // sempre > SENSING_RADIUS >= 1, mai 0
            const utility = Math.pow(EXPECTED_SPAWN_VALUE, 2) / dist;
            if (utility > maxPatrolUtility) { maxPatrolUtility = utility; bestPatrol = z; }
        }
    }

    /* ---- SELEZIONE DELL'OPZIONE MIGLIORE ---- */
    // Logica decisionale: la priorità dipende dal confronto tra le utilità.
    //
    // Caso 1: CONSEGNA FORZATA
    //   Se le tasche sono piene, dobbiamo per forza consegnare.
    if (isFull && bestZone) {
        myAgent.push(['go_deliver', bestZone.x, bestZone.y]);
        return;
    }

    // Caso 2: CONSEGNA CONVENIENTE (con opportunismo)
    //   Se consegnare è più utile che raccogliere, andiamo a consegnare.
    //   Ma se c'è un pacco MOLTO vicino e non siamo pieni, lo raccogliamo prima.
    if (hasParcels && bestZone && maxDeliveryUtility > maxPickupUtility) {
        if (bestParcel && distance(me, bestParcel) <= OPPORTUNISTIC_RADIUS) {
            myAgent.push(['go_pick_up', bestParcel.x, bestParcel.y, bestParcel.id]);
        } else {
            myAgent.push(['go_deliver', bestZone.x, bestZone.y]);
        }
        return;
    }

    // Caso 3: RACCOLTA PACCO
    //   Raccogliere è più utile che esplorare.
    if (bestParcel && maxPickupUtility >= maxPatrolUtility) {
        myAgent.push(['go_pick_up', bestParcel.x, bestParcel.y, bestParcel.id]);
        return;
    }

    // Caso 4: PATTUGLIAMENTO
    //   Nessun pacco visibile conveniente: esploriamo le zone spawn.
    if (bestPatrol) {
        myAgent.push(['patrol', bestPatrol.x, bestPatrol.y]);
    }
}

/* ============================================================================
   CICLO DI SENSING
   Ad ogni tick del server: aggiorniamo le Beliefs e rigeneriamo le opzioni.
============================================================================ */
socket.onSensing(async (sensings) => {
    if (me.x === undefined || me.y === undefined) return;
    myBeliefs.updateSensing(sensings, { x: me.x, y: me.y }, SENSING_RADIUS);
    optionsGeneration();
});

/* ============================================================================
   SEZIONE 4: INTENTION REVISION

   Questa è la componente BDI che gestisce le Intenzioni nel tempo.

   La classe base IntentionRevision definisce il loop principale: un ciclo
   infinito che prende la prima intenzione dalla coda e la esegue.

   IntentionRevisionReplace estende questa logica: ogni volta che arriva
   una nuova intenzione DIVERSA da quella corrente, interrompe quella in corso
   e la sostituisce immediatamente. Questo garantisce che l'agente reagisca
   sempre all'opzione più aggiornata generata dai sensori.
============================================================================ */

class IntentionRevision {

    // La coda delle intenzioni. Con IntentionRevisionReplace sarà sempre
    // lunga al massimo 1-2 elementi (la corrente + la nuova appena arrivata).
    #intention_queue = new Array();
    get intention_queue() { return this.#intention_queue; }

    /* Il loop principale: gira all'infinito controllando la coda.
       'setImmediate' cede il controllo all'event loop di Node.js tra un'iterazione
       e l'altra, evitando di bloccare il thread mentre aspettiamo eventi. */
    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {

                const intention = this.intention_queue[0];

                // Eseguiamo l'intenzione. Se fallisce (piano non trovato, obiettivo
                // irraggiungibile, ecc.) catturiamo l'errore e continuiamo.
                await intention.achieve()
                    .catch(err => {
                        if (!String(err).includes('stopped'))
                            console.log('[INTENTION] Fallita:', ...intention.predicate, '→', err);
                    });

                // Rimuoviamo l'intenzione completata (o fallita) dalla coda.
                this.intention_queue.shift();
            }
            // Cediamo il controllo al sistema prima della prossima iterazione.
            await new Promise(res => setImmediate(res));
        }
    }

    log(...args) { console.log(...args); }
}

/* --------------------------------------------------------------------------
   IntentionRevisionReplace: quando arriva un nuovo obiettivo diverso da quello
   corrente, ferma immediatamente il piano in esecuzione e lo sostituisce.

   INERZIA IMPLICITA: se optionsGeneration() spinge lo stesso predicato
   (stesso pacco, stessa zona) due volte di fila, il metodo push() si accorge
   che è identico all'ultimo in coda e NON lo sostituisce → il piano corrente
   continua indisturbato. Questo è il meccanismo di inerzia del BDI.
-------------------------------------------------------------------------- */
class IntentionRevisionReplace extends IntentionRevision {

    async push(predicate) {

        // Recuperiamo l'ultima intenzione in coda (quella corrente o l'ultima accodata).
        const last = this.intention_queue.at(this.intention_queue.length - 1);

        // Se il predicato è identico all'intenzione corrente, non facciamo nulla:
        // il piano in corso sta già lavorando verso questo obiettivo.
        // 'join(' ')' converte l'Array in una stringa per confronto semplice.
        // Es.: ['go_pick_up', 3, 5, 'abc'] → "go_pick_up 3 5 abc"
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        // ----------------------------------------------------------------
        // GUARDIA ANTI-LIVELOCK: patrol → patrol
        //
        // PROBLEMA (trashing/livelock):
        //   optionsGeneration() viene chiamata ad ogni tick del server.
        //   Durante il movimento verso una zona spawn, la posizione dell'agente
        //   (me.x, me.y) oscilla leggermente perché il server interpola
        //   l'animazione (movement_duration: 50ms). Questo fa sì che due spawn
        //   vicine abbiano distanze che si alternano di qualche decimo ad ogni
        //   tick, rendendo "la più vicina" diversa da un tick all'altro.
        //
        //   Risultato senza questo blocco:
        //     tick 1: best spawn = (8, 6)  → push(['patrol', 8, 6])  → REPLACE patrol (10,12) → stop
        //     tick 2: best spawn = (10,12) → push(['patrol', 10,12]) → REPLACE patrol (8,6)   → stop
        //     tick 3: best spawn = (8, 6)  → push(['patrol', 8, 6])  → REPLACE patrol (10,12) → stop
        //     ... all'infinito. L'AStarMove viene stoppato prima di compiere
        //     anche un solo passo: l'agente non si muove mai.
        //
        // SOLUZIONE:
        //   Se il piano corrente È già un patrol (verso qualsiasi destinazione),
        //   ignoriamo le nuove proposte di patrol. Il patrol corrente completerà
        //   il suo percorso naturalmente, oppure fallirà per motivi reali
        //   (percorso bloccato), e solo allora optionsGeneration() sceglierà
        //   la prossima spawn da visitare.
        //
        //   Le azioni ad alta priorità (go_pick_up, go_deliver) possono comunque
        //   interrompere un patrol: il blocco si attiva SOLO per patrol → patrol.
        // ----------------------------------------------------------------
        if (last && last.predicate[0] === 'patrol' && predicate[0] === 'patrol') {
            return; // Non interrompere un patrol in corso con un altro patrol
        }

        // Creiamo la nuova intenzione e la mettiamo in coda.
        const intention = new Intention(this, predicate);
        this.intention_queue.push(intention);

        // Interrompiamo il piano corrente (se esiste).
        // stop() propaga lo stop anche ai sub-piani e alle sub-intenzioni.
        if (last) last.stop();
    }
}

/* ============================================================================
   SEZIONE 5: INTENTION

   Un'Intention rappresenta UN obiettivo da raggiungere.
   Contiene il predicato (cosa vogliamo fare) e si occupa di trovare
   un Piano applicabile nella Plan Library per raggiungerlo.
============================================================================ */

class Intention {

    // Indica se questa intenzione è stata fermata dall'esterno.
    #stopped = false;
    get stopped() { return this.#stopped; }

    // Il piano correntemente in esecuzione per raggiungere questa intenzione.
    #current_plan = null;

    // Il predicato che descrive l'obiettivo. Es.: ['go_pick_up', 3, 5, 'abc123']
    #predicate;
    get predicate() { return this.#predicate; }

    // Riferimento al "genitore" (l'IntentionRevision o il Piano che ci ha creati).
    // Serve per la catena di log.
    #parent;

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    // Ferma questa intenzione E il piano in corso.
    // Viene chiamato da IntentionRevisionReplace quando arriva un obiettivo migliore.
    stop() {
        this.#stopped = true;
        if (this.#current_plan) this.#current_plan.stop();
    }

    log(...args) {
        if (this.#parent?.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    // Flag per evitare di avviare la stessa intenzione due volte.
    #started = false;

    /* achieve() - Il cuore dell'Intention.
       Scorre la Plan Library cercando un piano applicabile al nostro predicato.
       Se il piano fallisce (eccezione), prova il successivo.
       Se nessun piano funziona, l'intenzione fallisce lanciando un'eccezione. */
    async achieve() {
        if (this.#started) return this;
        this.#started = true;

        for (const PlanClass of planLibrary) {

            // Se siamo stati fermati nel frattempo, usciamo subito.
            if (this.stopped) throw ['stopped', ...this.#predicate];

            // isApplicableTo() verifica se questo piano sa gestire il nostro predicato.
            if (PlanClass.isApplicableTo(...this.#predicate)) {

                // Istanziamo il piano (ogni esecuzione è un oggetto separato).
                this.#current_plan = new PlanClass(this);
                this.log('achieving', ...this.#predicate, 'with plan', PlanClass.name);

                try {
                    // Eseguiamo il piano e restituiamo il risultato se va a buon fine.
                    const result = await this.#current_plan.execute(...this.#predicate);
                    this.log('success', ...this.#predicate, 'plan', PlanClass.name);
                    return result;
                } catch (error) {
                    // Il piano è fallito: proviamo il prossimo nella libreria.
                    this.log('plan', PlanClass.name, 'failed with:', error);
                }
            }
        }

        // Nessun piano ha soddisfatto l'intenzione.
        throw ['no plan found for', ...this.#predicate];
    }
}

/* ============================================================================
   SEZIONE 6: PLAN (classe base)

   Un Piano è la sequenza concreta di azioni per raggiungere un obiettivo.
   Ogni Piano specifico (GoPickUp, GoDeliver, ecc.) estende questa classe base
   che fornisce:
   - Il meccanismo di stop (propagato alle sub-intenzioni)
   - Il metodo subIntention() per delegare a piani di livello inferiore
     (es.: GoPickUp usa subIntention(['go_to', x, y]) per navigare)
============================================================================ */

class Plan {

    #stopped = false;
    get stopped() { return this.#stopped; }

    // Lista delle sub-intenzioni attive, per propagare lo stop.
    #sub_intentions = [];

    #parent;
    constructor(parent) { this.#parent = parent; }

    stop() {
        this.#stopped = true;
        // Propaghiamo lo stop a tutte le sub-intenzioni in corso.
        for (const i of this.#sub_intentions) i.stop();
    }

    log(...args) {
        if (this.#parent?.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    /* subIntention() - Crea e avvia una sotto-intenzione.
       Permette di comporre i piani in modo gerarchico.
       Es.: GoPickUp chiama subIntention(['go_to', x, y]) che a sua volta
       usa il piano AStarMove per navigare passo dopo passo. */
    async subIntention(predicate) {
        const sub = new Intention(this, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }
}

/* ============================================================================
   SEZIONE 7: PLAN LIBRARY - I piani concreti dell'agente

   Ogni piano ha:
   - isApplicableTo(...predicate): metodo STATICO che dice se il piano sa
     gestire un dato predicato. Viene chiamato da Intention.achieve().
   - execute(...predicate): metodo ASINCRONO che esegue le azioni concrete.
     Può chiamare subIntention() per delegare sotto-obiettivi ad altri piani.
============================================================================ */

/* --------------------------------------------------------------------------
   PIANO: GoPickUp
   Obiettivo: raggiungere un pacco e raccoglierlo.
   Strategia: delega la navigazione a subIntention(['go_to', x, y]),
              poi emette il comando di raccolta.
-------------------------------------------------------------------------- */
class GoPickUp extends Plan {

    static isApplicableTo(action) {
        return action === 'go_pick_up';
    }

    async execute(action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        // Annuncia al partner LLM che il BDI sta andando per questo pacco,
        // così l'LLM non si dirige verso lo stesso target contemporaneamente.
        socket.emitShout(`[BDI] going_for ${id}`);

        // Prima sotto-intenzione: raggiungere la casella del pacco.
        // Sarà gestita dal piano AStarMove.
        // Se la navigazione fallisce (es. un altro agente è fermo sulla casella
        // del pacco e non possiamo entrarci, oppure il percorso è bloccato),
        // mettiamo il pacco in blacklist per un breve periodo: così
        // optionsGeneration() sceglie un altro obiettivo invece di rincorrere
        // all'infinito questo pacco accumulando penalità. Dopo BAN_DURATION_MS
        // il pacco torna selezionabile (l'altro agente potrebbe essersi spostato).
        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (!String(err).includes('stopped')) {
                blacklist.parcels.set(id, Date.now() + BAN_DURATION_MS);
            }
            throw err;
        }

        if (this.stopped) throw ['stopped'];

        // Siamo sulla casella: raccogliamo i pacchi presenti.
        const picked = await socket.emitPickup();

        if (this.stopped) throw ['stopped'];

        // Se la raccolta non ha prodotto nulla, il pacco potrebbe essere
        // già stato preso da un altro agente. Lo banniamo per evitare
        // di rincorrerlo di nuovo immediatamente.
        if (!picked || picked.length === 0) {
            blacklist.parcels.set(id, Date.now() + BAN_DURATION_MS);
            throw ['pickup failed - parcel gone', id];
        }

        // Notifica l'agente LLM che questo pacco è già stato raccolto dal BDI,
        // così l'LLM aggiorna le sue credenze e non ci si dirige inutilmente.
        socket.emitShout(`[BDI] picked_up ${id}`);

        return true;
    }
}

/* --------------------------------------------------------------------------
   PIANO: GoDeliver
   Obiettivo: raggiungere una zona di consegna e depositare i pacchi.
-------------------------------------------------------------------------- */
class GoDeliver extends Plan {

    static isApplicableTo(action) {
        return action === 'go_deliver';
    }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];

        // Navigazione verso la zona di consegna.
        // Se il percorso non esiste, banniamo la zona per BAN_DURATION_MS
        // così optionsGeneration() non la sceglie di nuovo immediatamente.
        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (!String(err).includes('stopped')) {
                blacklist.zones.set(`${Math.round(x)},${Math.round(y)}`, Date.now() + BAN_DURATION_MS);
            }
            throw err;
        }

        if (this.stopped) throw ['stopped'];

        // Depositiamo tutti i pacchi in mano (nessun argomento = tutti).
        await socket.emitPutdown();

        return true;
    }
}

/* --------------------------------------------------------------------------
   PIANO: Patrol
   Obiettivo: raggiungere una zona spawn per controllarla.
   Dopo l'arrivo, registra la zona come "visitata" per SPAWN_COOLDOWN_MS.
-------------------------------------------------------------------------- */
class Patrol extends Plan {

    static isApplicableTo(action) {
        return action === 'patrol';
    }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];

        await this.subIntention(['go_to', x, y]);

        // Registriamo la zona come visitata: optionsGeneration() la ignorerà
        // per i prossimi SPAWN_COOLDOWN_MS millisecondi.
        visitedSpawns.set(`${Math.round(x)},${Math.round(y)}`, Date.now() + SPAWN_COOLDOWN_MS);

        return true;
    }
}

/* --------------------------------------------------------------------------
   PIANO: AStarMove  (il piano di navigazione di basso livello)
   Obiettivo: raggiungere la casella (x, y) usando l'algoritmo A*.

   Questo è il piano che effettivamente muove l'agente nella mappa.
   Funziona in un loop: ad ogni iterazione ricalcola il percorso ottimale
   dalla posizione attuale al goal (tenendo conto delle casse mobili),
   poi esegue il PRIMO passo di quel percorso.

   Ricalcolare ad ogni passo (invece di eseguire tutto il percorso in una volta)
   garantisce che l'agente si adatti a ostacoli dinamici (casse che si muovono,
   altri agenti che bloccano il percorso pianificato).

   Se il server rifiuta una mossa (result = false), il loop continua e
   l'A* ricalcolerà un percorso alternativo al prossimo ciclo.
-------------------------------------------------------------------------- */
class AStarMove extends Plan {

    static isApplicableTo(action) {
        return action === 'go_to';
    }

    async execute(action, x, y) {
        const goal = { x, y };

        // ----------------------------------------------------------------
        // CACHE DEL PIANO PDDL (usata solo in modalità USE_PDDL_PLANNER).
        // -------------------------------------------------------------
        // Il solver PDDL è online: una chiamata per OGNI passo sarebbe troppo
        // lenta. Quindi, in modalità PDDL, calcoliamo il piano UNA VOLTA e lo
        // seguiamo passo-passo; lo ricalcoliamo solo quando lo esauriamo o
        // quando una mossa viene rifiutata (ambiente cambiato).
        // In modalità A* questa cache resta inutilizzata (l'A* è locale e
        // ricalcola ogni passo, gestendo nativamente le casse mobili).
        let pddlPath = null;   // array di mosse ['right','up',...]
        let pddlStep = 0;      // indice della prossima mossa nel piano cache

        // Contatore anti-stallo: quante mosse consecutive il server ha rifiutato.
        // Se supera MAX_MOVE_FAILS, abbandoniamo l'obiettivo (qualcosa ci blocca
        // stabilmente, es. un agente fermo) invece di insistere accumulando penalità.
        let consecutiveFails = 0;

        // Loop finché non siamo arrivati alla destinazione.
        // distance() > 0 significa che non siamo ancora sulla casella goal.
        while (distance(me, goal) > 0) {

            // Controlliamo ad ogni iterazione se siamo stati fermati dall'esterno
            // (IntentionRevisionReplace ha trovato un obiettivo migliore).
            if (this.stopped) throw ['stopped'];

            // Aggiorniamo le posizioni delle casse ad ogni passo:
            // le casse si muovono, quindi il percorso libero può cambiare!
            const crateKeys = myBeliefs.getCrateKeys();

            // Zone critiche per il controllo di connettività sui push:
            // includiamo la posizione attuale dell'agente (per non isolarsi)
            // e tutte le delivery zones (per non precludersi la consegna).
            const criticalZones = [
                { x: Math.round(me.x), y: Math.round(me.y) },
                ...myBeliefs.deliveryZones
            ];

            const agents = myBeliefs.getOtherAgentPositions(me.id);

            // ----------------------------------------------------------------
            // ANTI-STALLO: TILE-OBIETTIVO OCCUPATO DA UN ALTRO AGENTE
            // -------------------------------------------------------------
            // Caso tipico: un altro giocatore resta FERMO sulla casella di un
            // pacco senza raccoglierlo. Quella casella è la nostra destinazione,
            // ma non potremo MAI entrarci finché lui è lì. Se siamo già adiacenti
            // (o sopra, distanza ≤ 1) e il tile è ancora occupato, abbandoniamo
            // subito l'obiettivo: continuare significherebbe solo sbattere contro
            // di lui e incassare penalità a ogni tentativo.
            //
            // Nota: NON abbandoniamo se siamo ancora lontani (distanza > 1): in
            // quel caso continuiamo ad avvicinarci, dando all'altro agente il
            // tempo di spostarsi prima del nostro arrivo.
            const goalOccupied = agents.some(
                a => Math.round(a.x) === goal.x && Math.round(a.y) === goal.y
            );
            if (goalOccupied && distance(me, goal) <= 1) {
                throw ['goal occupied by agent', x, y];
            }

            // 'move' = la singola mossa da eseguire in questa iterazione.
            let move;

            if (USE_PDDL_PLANNER) {
                // ---- MODALITÀ PLANNER ESTERNO PDDL ----
                // (Ri)calcoliamo il piano se non ne abbiamo uno o l'abbiamo finito.
                if (!pddlPath || pddlStep >= pddlPath.length) {
                    pddlPath = await PddlPlanner.getPath(
                        me, goal, myBeliefs.map, agents, [], crateKeys
                    );
                    pddlStep = 0;

                    // FALLBACK: se il solver PDDL fallisce (offline, timeout,
                    // mappa troppo grande, nessun piano), usiamo l'A* locale.
                    if (!pddlPath) {
                        pddlPath = Planner.getPath(
                            me, goal, myBeliefs.map, agents, [], congestionMap,
                            crateKeys, criticalZones
                        );
                    }

                    if (!pddlPath) throw ['no path to', x, y];
                    if (pddlPath.length === 0) break; // già sul goal
                }
                move = pddlPath[pddlStep];

            } else {
                // ---- MODALITÀ A* LOCALE (default) ----
                // Calcoliamo il percorso ottimale dalla posizione attuale al goal.
                const path = Planner.getPath(
                    me, goal, myBeliefs.map, agents, [], congestionMap,
                    crateKeys, criticalZones
                );

                // Se il percorso non esiste (goal bloccato o irraggiungibile),
                // lanciamo un'eccezione che farà fallire il piano chiamante.
                if (!path) throw ['no path to', x, y];

                // path vuoto = siamo già sulla casella goal (distanza 0).
                if (path.length === 0) break;

                // Eseguiamo solo il PRIMO passo: al prossimo ciclo ricalcoleremo
                // con la posizione aggiornata (gestione nativa delle casse mobili).
                move = path[0];
            }

            // Eseguiamo la mossa scelta dalla modalità attiva.
            const t0 = Date.now();
            const result = await socket.emitMove(move);
            const elapsed = Date.now() - t0;

            if (this.stopped) throw ['stopped'];

            // Se il server ci ha confermato la mossa (result contiene {x, y}),
            // aggiorniamo la nostra posizione locale e calibriamo movementDurationMs.
            if (result) {
                me.x = result.x;
                me.y = result.y;
                // Aggiorniamo la stima con media mobile esponenziale (α=0.3).
                // Converge al valore reale del server in ~10 passi, indipendentemente
                // dalla configurazione della mappa.
                movementDurationMs = 0.7 * movementDurationMs + 0.3 * elapsed;
                // Avanziamo nel piano PDDL cache (ininfluente in modalità A*).
                pddlStep++;
                // Mossa riuscita: azzeriamo il contatore anti-stallo.
                consecutiveFails = 0;
            } else {
                // Mossa rifiutata: calcoliamo il tile che si è rivelato bloccato
                // e lo registriamo nella congestion map con una penalità temporanea.
                // Al prossimo ciclo A* aumenterà il costo di quel tile e cercherà
                // un percorso alternativo.
                let blockedX = Math.round(me.x);
                let blockedY = Math.round(me.y);
                if (move === 'right') blockedX++;
                else if (move === 'left') blockedX--;
                else if (move === 'up') blockedY++;
                else if (move === 'down') blockedY--;

                const blockedKey = `${blockedX},${blockedY}`;
                const existing = congestionMap.get(blockedKey) || { penalty: 0 };
                congestionMap.set(blockedKey, {
                    penalty: existing.penalty + CONGESTION_PENALTY,
                    expireAt: Date.now() + CONGESTION_DURATION_MS
                });

                // Invalidiamo il piano PDDL cache: l'ambiente è cambiato, va
                // ricalcolato (in modalità A* questo è già implicito).
                pddlPath = null;

                // Anti-stallo generico: se accumuliamo troppe mosse rifiutate di
                // fila, qualcosa ci blocca stabilmente (agente fermo, ingorgo).
                // Abbandoniamo l'obiettivo così il ciclo BDI può ridecidere.
                consecutiveFails++;
                if (consecutiveFails >= MAX_MOVE_FAILS) {
                    throw ['stuck - too many rejected moves', x, y];
                }
            }
        }

        return true;
    }
}

/* ============================================================================
   SEZIONE 8: PLAN LIBRARY e AVVIO DELL'AGENTE

   La planLibrary è l'elenco ORDINATO dei piani disponibili.
   Intention.achieve() li scorre in ordine: il primo piano la cui
   isApplicableTo() restituisce true viene istanziato ed eseguito.

   ORDINE IMPORTANTE:
   - GoPickUp, GoDeliver, Patrol intercettano i predicati di alto livello
   - AStarMove intercetta 'go_to', usato come sub-intenzione dagli altri piani
============================================================================ */
const planLibrary = [GoPickUp, GoDeliver, Patrol, AStarMove];

// Creiamo l'agente con strategia di revisione "Replace":
// ogni nuovo obiettivo migliore interrompe immediatamente quello corrente.
const myAgent = new IntentionRevisionReplace();

// Avviamo il loop infinito di esecuzione delle intenzioni.
// Gira in background grazie a setImmediate (non blocca il thread).
myAgent.loop();
