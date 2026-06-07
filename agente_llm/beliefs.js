/* ============================================================================
   FILE: beliefs.js  (versione corretta - agente3)
   SCOPO: Il database cognitivo dell'agente.

   DESCRIZIONE GENERALE:
   Questo file implementa il sistema di "Credenze" (Beliefs) dell'agente,
   cioè tutto ciò che l'agente SA (o CREDE di sapere) sul mondo in cui opera.

   Ci sono due categorie di informazioni:
   1. INFORMAZIONI STATICHE - La struttura della mappa (muri, zone di consegna,
      zone di spawn dei pacchi). Vengono ricevute UNA SOLA VOLTA all'avvio.
   2. INFORMAZIONI DINAMICHE - Pacchi visibili e CASSE (oggetti mobili) presenti
      nella mappa. Cambiano continuamente ad ogni ciclo di sensing.

   TIPI DI CASELLE NELLA MAPPA:
   - '0'  = Muro (non percorribile)
   - '1'  = Zona spawn pacchi (casella VERDE - i pacchi appaiono qui)
   - '2'  = Zona consegna (casella ROSSA - qui si scaricano i pacchi)
   - '3'  = Pavimento normale (percorribile)
   - '4'  = Base
   - '5'  = Casella di scivolamento casse (GIALLA - le casse scivolano su queste)
   - '5!' = Casella di spawn casse (GIALLA con punto escl. - le casse appaiono qui)
   - '↑' '→' '↓' '←' = Caselle direzionali (nastri trasportatori a senso unico)

   CORREZIONI IN QUESTA VERSIONE rispetto all'originale:
   - Aggiunto tracking completo delle CASSE (crates): oggetti gialli mobili
     che bloccano fisicamente il passaggio come se fossero muri temporanei.
   - Implementata la "Belief Revision" anche per le casse (stessa logica pacchi).
   - Aggiunto il metodo getCrateKeys() che fornisce le posizioni casse al Planner.
============================================================================ */

// Quanto a lungo (ms) ricordare un agente che non vediamo più.
// Copre il caso degli agenti offline che rimangono fisicamente nella mappa
// ma smettono di comparire nel sensing: teniamo la loro ultima posizione
// nota come ostacolo finché questo TTL non scade.
const AGENT_MEMORY_MS = 30000;

export class Beliefs {
    constructor() {
        // =================================================================
        // DATI STATICI (non cambiano dopo il caricamento della mappa)
        // =================================================================

        // this.map è una struttura dati JavaScript chiamata "Map" (dizionario).
        // Non va confusa con la mappa del gioco! È come una rubrica telefonica:
        //   chiave: stringa "x,y" (es. "3,5")
        //   valore: l'oggetto tile completo ricevuto dal server (es. {x:3, y:5, type:'1'})
        // Serve per sapere istantaneamente di che tipo è una qualsiasi casella.
        this.map = new Map();

        // Array (lista) delle zone di consegna (caselle ROSSE).
        // Ogni elemento è semplicemente {x, y}.
        // Viene riempito una volta sola in updateMap() e poi rimane invariato.
        this.deliveryZones = [];

        // Array delle zone di spawn pacchi (caselle VERDI).
        // L'agente usa questa lista per pianificare le ronde di pattugliamento.
        this.spawnZones = [];

        // =================================================================
        // DATI DINAMICI (cambiano ad ogni ciclo di sensing)
        // =================================================================

        // Memoria dei pacchi visibili (e recentemente visti).
        // Formato: ID_pacco -> oggetto_pacco { id, x, y, reward, carriedBy, lastSeen }
        // Contiene sia i pacchi liberi a terra che quelli già in mano a qualcuno.
        this.parcels = new Map();

        // NUOVO: Memoria delle casse (crates).
        // Le casse sono gli ostacoli fisici mobili che scivolano sulle caselle
        // gialle (tipo '5' e '5!'). Un agente NON può attraversare una casella
        // occupata da una cassa: devono essere trattate come muri temporanei.
        // Formato: ID_cassa -> oggetto_cassa { id, x, y, lastSeen }
        this.crates = new Map();

        // Memoria degli altri agenti con TTL.
        // Formato: id → { id, x, y, lastSeen }
        // Manteniamo l'ultima posizione nota anche quando un agente scompare
        // dal sensing (es. va offline ma rimane fisicamente nella mappa).
        // Le voci scadono dopo AGENT_MEMORY_MS ms senza aggiornamenti.
        this.otherAgentsMemory = new Map();

        // Stima osservata del tasso di decadimento del reward (punti per ms).
        // Viene calibrata dinamicamente osservando lo stesso pacco in due
        // sensing consecutivi. Null finché non abbiamo ancora osservato
        // almeno un calo; in quel caso il chiamante usa un default.
        this.globalDecayRatePerMs = null;
    }

    /* --------------------------------------------------------------------------
       [ updateMap() - ELABORAZIONE DELLA MAPPA STATICA ]

       Questa funzione viene chiamata UNA SOLA VOLTA all'avvio, quando il server
       ci manda la struttura completa del campo di gioco.

       Parametri:
         - tiles: Array di oggetti, uno per ogni casella percorribile della mappa.
                  Ogni tile ha almeno: { x, y, type }
    -------------------------------------------------------------------------- */
    updateMap(tiles) {
        let contatoreConsegne = 0;
        let contatoreSpawn = 0;

        // 'for...of' in JavaScript è il modo standard per iterare su una lista.
        // Ad ogni ciclo, 'tile' contiene i dati di una casella diversa.
        for (const tile of tiles) {

            // Creiamo la chiave "x,y" per questa casella.
            // Math.round() arrotonda all'intero più vicino, necessario perché a
            // volte le coordinate arrivano come numeri con decimali (es. 2.0001).
            const key = `${Math.round(tile.x)},${Math.round(tile.y)}`;

            // Salviamo l'oggetto tile nel database della mappa.
            // Il Planner userà this.map.get("x,y") per sapere se una casella
            // è percorribile, se è un muro, se ha una direzione, ecc.
            this.map.set(key, tile);

            const tx = Math.round(tile.x);
            const ty = Math.round(tile.y);

            // FIX COMPATIBILITÀ: Il Deliveroo.js usa due sistemi paralleli per
            // classificare le caselle: il campo numerico 'type' E delle proprietà
            // booleane (tile.delivery, tile.parcelSpawner). Controlliamo entrambi
            // per essere sicuri di non perdere nessuna casella, indipendentemente
            // da quale versione dell'SDK è installata sul server.

            // --- Zona di consegna (casella ROSSA) ---
            if (String(tile.type) === '2' || tile.delivery === true) {
                // Evitiamo i duplicati nel caso il server reinvii la mappa.
                const alreadySaved = this.deliveryZones.find(z => z.x === tx && z.y === ty);
                if (!alreadySaved) {
                    this.deliveryZones.push({ x: tx, y: ty });
                    contatoreConsegne++;
                }
            }

            // --- Zona di spawn pacchi (casella VERDE) ---
            if (String(tile.type) === '1' || tile.parcelSpawner === true) {
                const alreadySaved = this.spawnZones.find(z => z.x === tx && z.y === ty);
                if (!alreadySaved) {
                    this.spawnZones.push({ x: tx, y: ty });
                    contatoreSpawn++;
                }
            }

            // NOTA sulle caselle GIALLE ('5' e '5!'):
            // Non le aggiungiamo a nessuna lista speciale perché sono caselle
            // normalmente percorribili dall'agente. L'unico problema è che una
            // CASSA può starci sopra, rendendola temporaneamente bloccata.
            // Questo ostacolo dinamico è gestito interamente tramite this.crates.
        }

        console.log(`[BELIEFS] Mappa caricata. Zone Consegna: ${contatoreConsegne} | Zone Spawn: ${contatoreSpawn}`);
    }

    /* --------------------------------------------------------------------------
       [ updateSensing() - BELIEF REVISION (Revisione delle credenze) ]

       Questa è la funzione più importante: viene chiamata AD OGNI TICK (ciclo)
       del gioco, quando il server ci manda un aggiornamento di tutto ciò che
       i nostri "occhi" (sensori) riescono a percepire in questo momento.

       Parametri:
         - sensings: oggetto con le cose che vediamo in questo frame:
             sensings.parcels  → Array dei pacchi visibili ora
             sensings.agents   → Array degli altri agenti visibili ora
             sensings.crates   → Array delle CASSE visibili ora (NUOVO)
         - myPosition: la nostra posizione attuale { x, y }
    -------------------------------------------------------------------------- */
    updateSensing(sensings, myPosition, sensingRadius = 5) {
        // Date.now() restituisce il timestamp Unix attuale in millisecondi.
        // Lo usiamo per sapere "quanto tempo fa" abbiamo visto qualcosa per
        // l'ultima volta (utile per eliminare ricordi troppo vecchi).
        const oraAttuale = Date.now();

        // ====================================================================
        // SEZIONE A: AGGIORNAMENTO DELLA MEMORIA DEI PACCHI
        // ====================================================================

        // Fase A1 - Aggiorniamo i pacchi che VEDIAMO in questo frame.
        for (const p of sensings.parcels) {
            const existing = this.parcels.get(p.id);
            p.lastSeen = oraAttuale;

            // Se vediamo lo stesso pacco libero con reward calato rispetto
            // all'ultima osservazione, calcoliamo il tasso di decadimento osservato
            // e aggiorniamo la stima globale con una media mobile esponenziale
            // (alpha=0.3), che smorzza i valori anomali senza reagire troppo lentamente.
            if (existing && !existing.carriedBy && !p.carriedBy &&
                p.reward < existing.reward && existing.lastSeen < oraAttuale) {
                const dt = oraAttuale - existing.lastSeen;
                const observedRate = (existing.reward - p.reward) / dt;
                this.globalDecayRatePerMs = this.globalDecayRatePerMs === null
                    ? observedRate
                    : 0.7 * this.globalDecayRatePerMs + 0.3 * observedRate;
            }

            this.parcels.set(p.id, p);
        }

        // Fase A2 - Raggio visivo passato da agent.js (letto da SENSING_RADIUS in .env).
        const currentSensingRadius = sensingRadius;

        // Fase A3 - Pulizia dei pacchi "fantasma".
        // Scorriamo TUTTI i pacchi che abbiamo in memoria e verifichiamo se
        // sono ancora validi. La struttura 'for...of entries()' ci dà sia
        // la chiave (id) che il valore (knownParcel) ad ogni iterazione.
        for (const [id, knownParcel] of this.parcels.entries()) {

            // Calcoliamo la distanza Manhattan tra la nostra posizione attuale
            // e la posizione del pacco che abbiamo in memoria.
            // Manhattan Distance = |x1-x2| + |y1-y2| (si muove solo in 4 direzioni)
            const dist = Math.abs(knownParcel.x - myPosition.x) + Math.abs(knownParcel.y - myPosition.y);

            // CASO A: Il pacco è nel nostro campo visivo attuale.
            if (dist <= currentSensingRadius) {
                // Se dovremmo vederlo ma non appare nella lista dei sensori,
                // significa che è sparito (raccolto, scaduto, spostato).
                const stillVisible = sensings.parcels.find(p => p.id === id);
                if (!stillVisible) {
                    this.parcels.delete(id); // Eliminiamo dalla memoria
                    continue; // 'continue' salta al prossimo pacco
                }
            }

            // CASO B: Il pacco è fuori dal campo visivo.
            // Non sappiamo con certezza se c'è ancora, ma se non lo vediamo
            // da 25 secondi, lo consideriamo sparito per evitare di rincorrere
            // "fantasmi" inesistenti in giro per la mappa.
            const timeSinceLastSeen = oraAttuale - (knownParcel.lastSeen || oraAttuale);
            if (timeSinceLastSeen > 25000) { // 25.000 ms = 25 secondi
                this.parcels.delete(id);
            }
        }

        // ====================================================================
        // SEZIONE B: AGGIORNAMENTO DELLA MEMORIA DELLE CASSE (CORREZIONE)
        // ====================================================================
        // Questa intera sezione è NUOVA rispetto alla versione originale.
        // Le casse sono ostacoli fisici che si muovono sulla mappa (sulle
        // caselle gialle '5' e '5!'). Se l'agente tenta di entrare in una
        // casella occupata da una cassa, il server rifiuterà la mossa.
        // Per evitarlo, manteniamo aggiornata una mappa delle posizioni delle
        // casse e la passiamo al Planner come lista di ostacoli dinamici.

        // Usiamo '|| []' perché su mappe senza casse, 'sensings.crates' potrebbe
        // essere undefined. '|| []' garantisce che sia almeno un Array vuoto,
        // evitando errori di tipo "Cannot read properties of undefined".
        const cratesVisibili = sensings.crates || [];

        // ====================================================================
        // SEZIONE C: AGGIORNAMENTO POSIZIONI ALTRI AGENTI (con memoria TTL)
        // ====================================================================
        // Aggiorniamo la posizione di ogni agente visibile e refreshiamo il
        // suo lastSeen. Gli agenti offline che rimangono fisicamente sulla
        // mappa non compaiono nel sensing, ma la loro ultima posizione nota
        // rimane in memoria per AGENT_MEMORY_MS — il planner li tratta ancora
        // come ostacoli, evitando penalità da collisione.
        for (const a of (sensings.agents || [])) {
            this.otherAgentsMemory.set(a.id, { id: a.id, x: a.x, y: a.y, lastSeen: oraAttuale });
        }
        // Pulizia: rimuoviamo le voci scadute.
        for (const [id, a] of this.otherAgentsMemory.entries()) {
            if (oraAttuale - a.lastSeen > AGENT_MEMORY_MS) {
                this.otherAgentsMemory.delete(id);
            }
        }

        // Fase B1 - Aggiorniamo le casse che VEDIAMO in questo frame.
        for (const c of cratesVisibili) {
            // Stessa logica dei pacchi: aggiungiamo il timestamp dell'ultima visione.
            c.lastSeen = oraAttuale;
            this.crates.set(c.id, c);
        }

        // Fase B2 - Pulizia delle casse che non vediamo più.
        // Stessa logica dei pacchi (Sezione A3) applicata alle casse.
        for (const [id, knownCrate] of this.crates.entries()) {

            const dist = Math.abs(knownCrate.x - myPosition.x) + Math.abs(knownCrate.y - myPosition.y);

            // CASO A: La cassa rientra nel nostro campo visivo attuale.
            if (dist <= currentSensingRadius) {
                // Se dovremmo vederla ma non appare nella lista crates del sensing,
                // è stata spostata o rimossa. La cancelliamo dalla memoria.
                const stillVisible = cratesVisibili.find(c => c.id === id);
                if (!stillVisible) {
                    this.crates.delete(id);
                    continue;
                }
            }

            // CASO B: La cassa è fuori visuale. Stessa soglia di 25 secondi.
            const timeSinceLastSeen = oraAttuale - (knownCrate.lastSeen || oraAttuale);
            if (timeSinceLastSeen > 25000) {
                this.crates.delete(id);
            }
        }
    }

    /* --------------------------------------------------------------------------
       [ METODI HELPER - Funzioni di servizio per l'agente ]
    -------------------------------------------------------------------------- */

    // Restituisce un Array di tutti i pacchi a terra (non in mano a nessuno).
    // 'filter()' è una funzione che restituisce solo gli elementi che soddisfano
    // la condizione indicata (qui: pacchi dove la proprietà 'carriedBy' è falsa).
    getAvailableParcels() {
        return Array.from(this.parcels.values()).filter(p => !p.carriedBy);
    }

    // Restituisce un Array dei pacchi che abbiamo IN MANO noi (identificati
    // dal nostro ID agente nel campo 'carriedBy' del pacco).
    getCarriedParcels(myId) {
        return Array.from(this.parcels.values()).filter(p => p.carriedBy === myId);
    }

    /* --------------------------------------------------------------------------
       getOtherAgentPositions(myId)

       Restituisce un Array di oggetti {x, y} con le posizioni degli agenti
       visibili, escludendo noi stessi. Viene passato al Planner come lista
       di ostacoli da evitare proattivamente: nel backend, la tile occupata
       da un agente è sempre "locked", quindi entrarci causa una penalità.

       Usiamo coordinate arrotondate perché durante l'animazione di movimento
       il server può inviare coordinate con decimali (es. 3.6, 4.2).
       Il Planner lavora su celle intere, quindi arrotondiamo per consistenza.
    -------------------------------------------------------------------------- */
    getOtherAgentPositions(myId) {
        return Array.from(this.otherAgentsMemory.values())
            .filter(a => a.id !== myId)
            .map(a => ({ x: Math.round(a.x), y: Math.round(a.y) }));
    }

    /* --------------------------------------------------------------------------
       getDecayRatePerMs()

       Restituisce il tasso di decadimento del reward in punti/ms.
       Usa il valore osservato dinamicamente, se disponibile; altrimenti
       un default conservativo di 1 punto al secondo (1/1000 pt/ms).

       Tenere il default leggermente alto spinge l'agente a consegnare
       prima — comportamento corretto in un torneo competitivo.
    -------------------------------------------------------------------------- */
    getDecayRatePerMs() {
        return this.globalDecayRatePerMs ?? (1 / 1000);
    }

    /* --------------------------------------------------------------------------
       NUOVO METODO: getCrateKeys()

       Scopo: restituire le posizioni di tutte le casse note come un Set di
       stringhe "x,y". Questo formato è scelto appositamente per il Planner:
       durante la ricerca del percorso A*, per ogni casella che stiamo valutando
       dobbiamo sapere istantaneamente se è bloccata da una cassa.

       Confronto di efficienza:
         - Con un Array, controllare se "3,5" è nella lista richiede di scorrere
           tutti gli elementi uno per uno: lento se ci sono molte casse (O(n)).
         - Con un Set, il controllo set.has("3,5") è ISTANTANEO (O(1)) perché
           internamente usa una tabella hash.

       Esempio di output: Set { "3,5", "7,2", "1,8" }
    -------------------------------------------------------------------------- */
    getCrateKeys() {
        const set = new Set();
        for (const c of this.crates.values()) {
            set.add(`${Math.round(c.x)},${Math.round(c.y)}`);
        }
        return set;
    }
}
