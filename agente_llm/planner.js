/* ============================================================================
   FILE: planner.js  (versione corretta - agente3)
   SCOPO: Algoritmo A* (A-Star) con gestione corretta dei nastri e delle casse.

   COS'È L'A* (A-Star)?
   È un algoritmo di ricerca del percorso minimo. Data una posizione di partenza
   e una di arrivo su una griglia, trova la sequenza di mosse più breve (o meno
   costosa) per andare da A a B, evitando gli ostacoli.
   Funziona tenendo una lista di nodi "da esplorare" (openSet) ordinata per costo
   stimato, espandendo sempre il nodo più promettente finché non raggiunge il goal.

   CORREZIONI IN QUESTA VERSIONE rispetto all'originale:

   BUG 1 - CASELLE DIREZIONALI (nastri a senso unico '↑' '→' '↓' '←'):
     PROBLEMA: Il codice originale cercava una proprietà 'tile.direction' che
     non esiste nell'SDK! Le caselle direzionali codificano la direzione
     direttamente nel campo 'tile.type' come carattere freccia ('→', '←', ecc.).
     Quindi i controlli "if (currentTile.direction && ...)" erano sempre falsi
     (undefined è falso in JavaScript), rendendo il controllo senso-unico
     completamente inattivo: l'agente poteva entrare nei nastri al contrario.
     SOLUZIONE: Controlliamo direttamente 'tile.type' confrontandolo con i
     caratteri freccia. La logica di blocco è: non si può ENTRARE in una casella
     freccia muovendosi nella direzione OPPOSTA alla freccia stessa.

   BUG 2 - CASSE (ostacoli mobili su caselle gialle):
     PROBLEMA: Il planner originale non riceveva informazioni sulle casse, quindi
     le trattava come caselle vuote percorribili, causando collisioni con ostacoli.
     SOLUZIONE: Aggiunto il parametro 'crateKeys' (un Set di stringhe "x,y")
     che viene trattato come ostacolo fisico assoluto (come un muro) nel pathfinding.
============================================================================ */

export class Planner {

    /* --------------------------------------------------------------------------
       getPath() - LA FUNZIONE PRINCIPALE DEL PLANNER

       Calcola il percorso ottimale da 'start' a 'goal' usando l'algoritmo A*.

       Parametri:
         - start        : posizione di partenza { x, y }
         - goal         : posizione di arrivo { x, y }
         - mapBeliefs   : la Map della mappa (da Beliefs.map), usata per
                          verificare il tipo di ogni casella
         - agents       : Array degli altri agenti (ostacoli da evitare)
         - parcels      : Array dei pacchi a terra (ostacoli morbidi, costo extra)
         - congestionMap: Map delle zone congestionate con penalità temporanee
         - crateKeys    : Set di stringhe "x,y" con le posizioni delle casse
                          (NUOVO - ostacoli fisici come i muri)

       Restituisce:
         - Array di stringhe con le mosse da fare (es. ['right', 'up', 'up'])
         - Array VUOTO [] se siamo già sulla casella goal (distanza 0)
         - null se non esiste nessun percorso (goal irraggiungibile)
    -------------------------------------------------------------------------- */
    static getPath(
        start,
        goal,
        mapBeliefs,
        agents        = [],
        parcels       = [],
        congestionMap = new Map(),
        crateKeys     = new Set(),  // posizioni casse come ostacoli fisici
        criticalZones = []          // posizioni che devono restare connesse dopo ogni push
    ) {

        // ====================================================================
        // FUNZIONI DI SUPPORTO E STRUTTURE DATI INIZIALI
        // ====================================================================

        // Funzione euristica: stima ottimistica del costo da 'pos0' al goal.
        // La distanza Manhattan (|Δx| + |Δy|) è perfetta per griglie 4-connesse
        // perché non sovrastima mai il percorso reale.
        const heuristic = (pos0, pos1) =>
            Math.abs(pos0.x - pos1.x) + Math.abs(pos0.y - pos1.y);

        // Converte un nodo {x, y} nella stringa chiave "x,y".
        const nodeToString = (n) => `${Math.round(n.x)},${Math.round(n.y)}`;

        // Coordinate intere di start e goal (arrotondiamo per sicurezza).
        const startX = Math.round(start.x);
        const startY = Math.round(start.y);
        const goalX  = Math.round(goal.x);
        const goalY  = Math.round(goal.y);

        // Se la casella di partenza non esiste nella mappa, usciamo subito.
        if (!mapBeliefs.has(`${startX},${startY}`)) return null;

        // Convertiamo agenti e pacchi in Set per ricerche O(1) (istantanee).
        const agentObstacles  = new Set(agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`));
        const parcelObstacles = new Set(parcels.map(p => `${Math.round(p.x)},${Math.round(p.y)}`));

        // Nodo di partenza. Ogni nodo dell'A* ha:
        //   x, y     : coordinate della casella
        //   g        : costo reale dal nodo start a questo nodo
        //   f        : costo totale stimato (g + euristica verso goal)
        //   parent   : nodo dal quale siamo arrivati qui (per ricostruire il path)
        //   action   : la mossa che ha portato qui ('up', 'right', ecc.)
        let startNode = {
            x: startX, y: startY,
            g: 0,
            f: heuristic({ x: startX, y: startY }, { x: goalX, y: goalY }),
            parent: null,
            action: null
        };

        // openSet: lista dei nodi da esplorare. Inizia solo con lo start.
        let openSet = [startNode];

        // closedSet: Set dei nodi già esplorati (non li rivisiteremo).
        let closedSet = new Set();

        // ====================================================================
        // DEFINIZIONE DELLE 4 DIREZIONI DI MOVIMENTO
        // ====================================================================
        // In Deliveroo.js: 'up' aumenta Y (muove verso l'alto sullo schermo),
        // 'down' diminuisce Y (muove verso il basso).
        const directions = {
            'right': { dx:  1, dy:  0 },
            'left':  { dx: -1, dy:  0 },
            'up':    { dx:  0, dy:  1 },
            'down':  { dx:  0, dy: -1 }
        };

        // Tabella delle direzioni opposte (usata in vari controlli).
        const oppositeDir = {
            'right': 'left',
            'left':  'right',
            'up':    'down',
            'down':  'up'
        };

        // ====================================================================
        // COSTANTI PER I NASTRI DIREZIONALI (FIX BUG 1)
        // ====================================================================
        //
        // Set dei tipi-freccia: usato per sapere rapidamente se una casella
        // è direzionale senza dover fare confronti multipli.
        const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);

        // Tabella: tipo-freccia → direzione di ingresso VIETATA.
        //
        // La regola del motore di gioco (da backend/src/deliveroo/Tile.js) è:
        //   allowsMovementFrom(fromX, fromY): restituisce false se il movimento
        //   va nella direzione OPPOSTA alla freccia della casella.
        //   In altre parole: si può entrare in una casella direzionale solo
        //   nella stessa direzione della freccia O perpendicolarmente ad essa,
        //   ma MAI contromano.
        //
        // Corrispondenze (verificate sul sorgente del backend):
        //   '→' ha vettore {dx:+1, dy:0} → vietato entrare con dx=-1 (direzione 'left')
        //   '←' ha vettore {dx:-1, dy:0} → vietato entrare con dx=+1 (direzione 'right')
        //   '↑' ha vettore {dx:0, dy:+1} → vietato entrare con dy=-1 (direzione 'down')
        //   '↓' ha vettore {dx:0, dy:-1} → vietato entrare con dy=+1 (direzione 'up')
        //
        // IMPORTANTE: Il backend permette di USCIRE da un nastro in qualsiasi
        // direzione (allowsExitInDirection() restituisce sempre true).
        // Quindi NON blocchiamo mai l'uscita da un nastro, solo l'entrata contromano.
        const arrowToProhibitedEntry = {
            '→': 'left',   // nastro destra: vietato entrare muovendosi a sinistra
            '←': 'right',  // nastro sinistra: vietato entrare muovendosi a destra
            '↑': 'down',   // nastro su: vietato entrare muovendosi verso il basso
            '↓': 'up'      // nastro giù: vietato entrare muovendosi verso l'alto
        };

        // ====================================================================
        // CICLO PRINCIPALE A*
        // ====================================================================
        while (openSet.length > 0) {

            // Ordiniamo per 'f' crescente e prendiamo il nodo più promettente.
            // 'sort' con (a, b) => a.f - b.f ordina in modo ascendente.
            openSet.sort((a, b) => a.f - b.f);
            let current = openSet.shift(); // shift() rimuove e restituisce il primo

            // ---- CONDIZIONE DI SUCCESSO ----
            // Siamo arrivati al goal! Ricostruiamo il percorso.
            if (current.x === goalX && current.y === goalY) {
                let path = [];
                let curr = current;
                // Risaliamo la catena parent→parent→...→start e raccogliamo le mosse.
                while (curr.parent) {
                    path.push(curr.action);
                    curr = curr.parent;
                }
                // Il path è costruito in ordine inverso: lo giriamo con .reverse()
                return path.reverse();
            }

            // Segniamo questa casella come "già esplorata".
            closedSet.add(nodeToString(current));

            // Recuperiamo i dati della casella corrente dalla mappa.
            let currentTile = mapBeliefs.get(nodeToString(current));

            // ================================================================
            // ESPLORAZIONE DEI VICINI (nelle 4 direzioni)
            // ================================================================
            for (const [dirName, vec] of Object.entries(directions)) {

                // Coordinate della casella vicina in direzione 'dirName'.
                let nx = current.x + vec.dx;
                let ny = current.y + vec.dy;
                let neighborKey = `${nx},${ny}`;

                // Saltiamo i nodi già esplorati.
                if (closedSet.has(neighborKey)) continue;

                // Dati della casella vicina.
                let neighborTile = mapBeliefs.get(neighborKey);

                // ============================================================
                // CHECK 1: MURI (ostacoli statici permanenti)
                // ============================================================
                // Una casella è bloccata se non esiste nella mappa (bordo) o
                // ha tipo '0' (muro).
                if (!neighborTile || String(neighborTile.type) === '0') continue;

                // ============================================================
                // CHECK 2: ALTRI AGENTI (ostacoli dinamici da evitare)
                // ============================================================
                // Evitiamo le caselle occupate da altri agenti, tranne la casella
                // goal (altrimenti non riusciremmo mai a pianificare verso di essa).
                if (agentObstacles.has(neighborKey) && (nx !== goalX || ny !== goalY)) {
                    continue;
                }

                // ============================================================
                // CALCOLO DEL COSTO DELLO SPOSTAMENTO
                // ============================================================
                // Dichiarato qui — prima dei check che lo modificano (CHECK 3) —
                // per evitare la temporal dead zone di 'let' in JavaScript.
                let stepCost = 1; // Costo base di ogni mossa

                // ============================================================
                // CHECK 3: CASSE (ostacoli fisici mobili — con supporto push)
                // ============================================================
                // Una cassa non è necessariamente impassabile: il server permette
                // di spingerla SE la tile immediatamente dietro di essa (nella
                // direzione di movimento) è di tipo "5" o "5!" (tile gialla) e
                // non è già occupata da un'altra cassa.
                //
                // Strategia: distinguiamo due casi.
                //   A) Cassa non spingibile → trattata come muro, si salta.
                //   B) Cassa spingibile → trattata come tile percorribile con
                //      costo extra CRATE_PUSH_COST (spingere costa un po' di più).
                //
                // Non serve modellare sequenze di push nell'A*: AStarMove ricalcola
                // il percorso ad ogni passo con crateKeys freschi, quindi dopo ogni
                // push il planner vede automaticamente la nuova posizione della cassa.
                if (crateKeys.has(neighborKey) && (nx !== goalX || ny !== goalY)) {
                    // Tile dietro la cassa (nella stessa direzione di movimento).
                    const behindKey = `${nx + vec.dx},${ny + vec.dy}`;
                    const behindTile = mapBeliefs.get(behindKey);

                    // La cassa è spingibile solo se il tile dietro esiste,
                    // è di tipo giallo ("5" o "5!") e non ha un'altra cassa sopra.
                    const canPush = behindTile &&
                                    String(behindTile.type).startsWith('5') &&
                                    !crateKeys.has(behindKey);

                    if (!canPush) continue; // Cassa impassabile: trattata come muro.

                    // Controllo di connettività: verifichiamo che spostare la cassa
                    // non disconnetta le zone critiche (consegna, spawn, ecc.).
                    // Si simula la mappa dopo il push e si controlla con una BFS
                    // che tutte le criticalZones rimangano mutuamente raggiungibili.
                    if (!Planner.checkConnectivity(
                            neighborKey, behindKey, mapBeliefs, crateKeys, criticalZones
                        )) continue; // Push pericoloso: isolerebbe una zona critica.

                    // Cassa spingibile e sicura: aggiungiamo un costo extra per
                    // preferire percorsi senza push quando esistono alternative.
                    stepCost += 10;
                }

                // ============================================================
                // CHECK 4: CASELLE DIREZIONALI (CORREZIONE BUG 1)
                // ============================================================
                //
                // Verifichiamo se la casella destinazione è un nastro direzionale
                // e, in caso affermativo, se stiamo cercando di entrarci contromano.
                //
                // Come funziona:
                //   1. Controlliamo se neighborTile.type è una freccia (es. '→')
                //   2. Se sì, recuperiamo la direzione VIETATA per quella freccia
                //      dalla tabella arrowToProhibitedEntry (es. '→' → 'left')
                //   3. Se la direzione che stiamo tentando (dirName) coincide con
                //      quella vietata, blocchiamo la mossa.
                //
                // ESEMPIO:
                //   Casella vicina ha tipo '→' (nastro verso destra)
                //   Stiamo provando dirName = 'left' (muoverci a sinistra)
                //   arrowToProhibitedEntry['→'] = 'left'
                //   'left' === 'left' → TRUE → BLOCCHIAMO!
                //
                // DIFFERENZA DAL CODICE ORIGINALE (che non funzionava):
                //   Originale: if (neighborTile.direction && neighborTile.direction === ...)
                //   neighborTile.direction è SEMPRE undefined (quella proprietà non esiste)
                //   Quindi il blocco NON scattava mai e i nastri erano ignorati.
                //   FIX: Usiamo neighborTile.type che contiene il carattere freccia.
                if (
                    ARROW_TYPES.has(neighborTile.type) &&
                    arrowToProhibitedEntry[neighborTile.type] === dirName
                ) {
                    continue; // Senso unico: ingresso contromano vietato!
                }

                // Penalità per i pacchi che ingombrano la casella (ostacoli morbidi).
                // Li trattiamo come molto scomodi (costo +15) ma non impossibili.
                if (parcelObstacles.has(neighborKey) && (nx !== goalX || ny !== goalY)) {
                    stepCost += 15;
                }

                // Penalità dalla mappa di calore (zone dove ci siamo bloccati di recente).
                if (congestionMap.has(neighborKey)) {
                    stepCost += congestionMap.get(neighborKey).penalty;
                }

                // ============================================================
                // AGGIORNAMENTO DELL'OPEN SET
                // ============================================================
                let tentative_g = current.g + stepCost;
                let existingNode = openSet.find(n => n.x === nx && n.y === ny);

                if (!existingNode) {
                    // Nodo nuovo: lo aggiungiamo all'openSet.
                    openSet.push({
                        x: nx, y: ny,
                        g: tentative_g,
                        f: tentative_g + heuristic({ x: nx, y: ny }, { x: goalX, y: goalY }),
                        parent: current,
                        action: dirName
                    });
                } else if (tentative_g < existingNode.g) {
                    // Nodo già nell'openSet ma abbiamo trovato un percorso più economico.
                    existingNode.g = tentative_g;
                    existingNode.f = tentative_g + heuristic({ x: nx, y: ny }, { x: goalX, y: goalY });
                    existingNode.parent = current;
                    existingNode.action = dirName;
                }

            } // fine del for sulle 4 direzioni
        } // fine del while principale dell'A*

        // openSet esaurito senza trovare il goal: percorso inesistente.
        return null;
    }

    /* --------------------------------------------------------------------------
       checkConnectivity — Verifica che un push non disconnetta le zone critiche.

       Simula lo spostamento della cassa da 'oldCrateKey' a 'newCrateKey' e
       controlla che tutte le posizioni in 'criticalZones' rimangano raggiungibili
       l'una dall'altra tramite una BFS sulla mappa ipotetica risultante.

       Se 'criticalZones' è vuota o ha un solo elemento, restituisce sempre true
       (non c'è niente da connettere).

       Parametri:
         oldCrateKey   : stringa "x,y" — posizione attuale della cassa
         newCrateKey   : stringa "x,y" — posizione dopo il push
         mapBeliefs    : la Map della mappa (stessa di getPath)
         crateKeys     : Set corrente delle posizioni casse
         criticalZones : Array di {x, y} che devono restare connesse
    -------------------------------------------------------------------------- */
    static checkConnectivity(oldCrateKey, newCrateKey, mapBeliefs, crateKeys, criticalZones) {
        if (criticalZones.length < 2) return true;

        // Funzione helper: BFS da 'from', restituisce il Set delle tile raggiungibili
        // usando la mappa di casse fornita.
        const bfsReachable = (crateSet, from) => {
            const startKey = `${Math.round(from.x)},${Math.round(from.y)}`;
            const visited  = new Set([startKey]);
            const queue    = [startKey];
            while (queue.length > 0) {
                const key   = queue.shift();
                const comma = key.indexOf(',');
                const cx    = Number(key.slice(0, comma));
                const cy    = Number(key.slice(comma + 1));
                for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                    const nk = `${cx + dx},${cy + dy}`;
                    if (visited.has(nk)) continue;
                    const tile = mapBeliefs.get(nk);
                    if (!tile || String(tile.type) === '0') continue;
                    if (crateSet.has(nk)) continue;
                    visited.add(nk);
                    queue.push(nk);
                }
            }
            return visited;
        };

        // Contiamo quante zone critiche sono raggiungibili da criticalZones[0]
        // PRIMA del push (con la mappa corrente).
        const visitedBefore   = bfsReachable(crateKeys, criticalZones[0]);
        const reachableBefore = criticalZones.filter(
            z => visitedBefore.has(`${Math.round(z.x)},${Math.round(z.y)}`)
        ).length;

        // Simuliamo la mappa dopo il push.
        const simulatedCrates = new Set(crateKeys);
        simulatedCrates.delete(oldCrateKey);
        simulatedCrates.add(newCrateKey);

        // Contiamo quante zone critiche sono raggiungibili DOPO il push.
        const visitedAfter   = bfsReachable(simulatedCrates, criticalZones[0]);
        const reachableAfter = criticalZones.filter(
            z => visitedAfter.has(`${Math.round(z.x)},${Math.round(z.y)}`)
        ).length;

        // Il push è sicuro se NON riduce la connettività.
        // Permettiamo push neutri (invariati) e push che migliorano la connettività.
        // Blocchiamo solo i push che disconnettono zone che erano già collegate.
        return reachableAfter >= reachableBefore;
    }
}
