# Appunti — agente3 (BDI + A*)
**Corso:** Autonomous Software Agents — UniTN  
**Piattaforma:** Deliveroo.js  
**Obiettivo:** raccogliere pacchi dalle spawn zone (verdi) e consegnarli alle delivery zone (rosse), massimizzando i punti prima che il reward dei pacchi decada a zero.

---

## 1. Contesto: cosa fa l'agente

La simulazione Deliveroo.js è una griglia 2D in cui:
- I **pacchi** appaiono sulle caselle verdi (tipo `1`) con un reward iniziale che decade nel tempo.
- L'agente deve raccoglierli con `emitPickup()` e consegnarli nelle caselle rosse (tipo `2`) con `emitPutdown()`.
- La mappa può contenere **casse** (oggetti gialli mobili, tipo `5`/`5!`) e **nastri direzionali** (tipo `→←↑↓`), oltre ai muri (tipo `0`).

---

## 2. Architettura BDI — panoramica

L'agente3 segue il modello **BDI (Belief-Desire-Intention)**, uno dei principali modelli teorici per agenti intelligenti studiati nel corso:

| Componente | Dove vive | Significato |
|---|---|---|
| **Beliefs** | `beliefs.js` | Ciò che l'agente *sa* (o crede) del mondo |
| **Desires/Options** | `optionsGeneration()` in `agent.js` | Ciò che l'agente *vorrebbe* fare, con una utilità calcolata |
| **Intentions** | `IntentionRevisionReplace` + `Intention` | L'obiettivo *scelto* e attualmente in esecuzione |
| **Plans** | Plan Library (`GoPickUp`, `GoDeliver`, `Patrol`, `AStarMove`) | Come raggiungere concretamente un'intenzione |

### Flusso di esecuzione (un tick)

```
socket.onSensing()
    └─► myBeliefs.updateSensing()   ← Belief Revision
    └─► optionsGeneration()         ← Desires: sceglie il miglior predicato
            └─► myAgent.push(pred)  ← Intention Revision
                    └─► Intention.achieve()     ← cerca un piano nella libreria
                            └─► Piano.execute() ← esegue azioni (emitMove, emitPickup…)
```

---

## 3. Beliefs — `beliefs.js`

Il database cognitivo dell'agente. Mantiene due categorie di informazioni:

### 3.1 Informazioni statiche (caricate una volta all'avvio)

| Campo | Tipo | Contenuto |
|---|---|---|
| `this.map` | `Map<"x,y", tile>` | Tutta la struttura della mappa — tipo casella, percorribilità |
| `this.deliveryZones` | `Array<{x,y}>` | Zone di consegna (rosse, tipo `2`) |
| `this.spawnZones` | `Array<{x,y}>` | Zone di spawn pacchi (verdi, tipo `1`) |

### 3.2 Informazioni dinamiche (aggiornate ad ogni sensing)

| Campo | Tipo | Contenuto |
|---|---|---|
| `this.parcels` | `Map<id, parcel>` | Pacchi visibili e recentemente visti |
| `this.crates` | `Map<id, crate>` | Casse mobili (ostacoli fisici) |
| `this.otherAgents` | `Array` | Posizioni altri agenti nell'ultimo tick |
| `this.globalDecayRatePerMs` | `number\|null` | Tasso di decadimento reward stimato dinamicamente |

### 3.3 Belief Revision — `updateSensing()`

Logica per mantenere la memoria coerente con il mondo reale:

1. **Aggiornamento**: tutti i pacchi/casse visibili vengono aggiornati con `lastSeen = Date.now()`.
2. **Pulizia per raggio visivo**: se un pacco è entro `SENSING_RADIUS` tile ma *non* appare nel sensing → è sparito (raccolto, scaduto) → lo si cancella.
3. **Pulizia per TTL**: se un oggetto non è visto da più di **25 secondi** → cancellato per evitare "fantasmi".

Il **tasso di decadimento** viene stimato dinamicamente: ogni volta che si osserva lo stesso pacco in due tick consecutivi con reward calato, si calcola `(vecchioReward - nuovoReward) / deltaT` e si aggiorna con una EMA (media mobile esponenziale, α=0.3).

---

## 4. Generazione Opzioni — `optionsGeneration()`

Chiamata ad ogni sensing. Calcola l'utilità di ogni possibile azione e seleziona la migliore.

### 4.1 Funzione di utilità

Per **raccogliere un pacco**:
```
utilità = rewardStimato² / distanza
```
Il `rewardStimato` include il decadimento già maturato + quello che maturerà durante il percorso:
```js
rewardAtArrival = parcel.reward - (elapsed + distSteps * movementDurationMs) * decayRate
```
Se `rewardAtArrival ≤ 0`, il pacco sarà scaduto prima dell'arrivo → ignorato.

Per **consegnare**:
```
utilità = (rewardAttualeInMano - decayDurantePercorso)² / distanza
```

Per **pattugliare** una spawn zone:
```
utilità = EXPECTED_SPAWN_VALUE² / distanza
```
Solo spawn fuori dal raggio visivo e non visitate di recente (cooldown 15 s).

### 4.2 Logica decisionale

```
1. Tasche piene (≥ MAX_CAPACITY=6 pacchi) → CONSEGNA forzata
2. Consegnare è più utile che raccogliere:
   - c'è un pacco MOLTO vicino (≤ OPPORTUNISTIC_RADIUS=5) → raccoglilo prima
   - altrimenti → CONSEGNA
3. Raccogliere è più utile di pattugliare → PICKUP
4. Nessun pacco conveniente → PATROL
```

### 4.3 Strutture di supporto

| Struttura | Scopo |
|---|---|
| `blacklist.parcels` | Ban temporaneo (3 s) su pacchi irraggiungibili o già presi |
| `blacklist.zones` | Ban temporaneo (3 s) su zone di consegna irraggiungibili |
| `visitedSpawns` | Cooldown (15 s) su spawn già visitate — evita ronde ripetitive |
| `congestionMap` | Penalità temporanee (5 s) su tile dove una mossa è stata rifiutata |
| `movementDurationMs` | Stima auto-calibrata della durata di ogni passo (EMA α=0.3, converge in ~10 passi) |

---

## 5. Intention Revision — `IntentionRevisionReplace`

Implementa la strategia **Replace**: ogni nuovo predicato migliore interrompe immediatamente il piano in corso.

### Meccanismo di inerzia implicita

```js
if (last && last.predicate.join(' ') === predicate.join(' ')) return;
```
Se `optionsGeneration()` genera lo stesso obiettivo del precedente tick, non fa nulla — il piano in corso continua indisturbato.

### Guardia anti-livelock patrol→patrol

Senza questa guardia si creerebbe un trashing: durante il movimento verso una spawn, la posizione dell'agente oscilla leggermente (interpolazione server), rendendo alternata la spawn "più vicina" ad ogni tick. Risultato: `AStarMove` viene interrotto prima di fare anche un solo passo.

```js
if (last.predicate[0] === 'patrol' && predicate[0] === 'patrol') return;
```
Un patrol in corso non può essere interrotto da un altro patrol. Solo `go_pick_up` e `go_deliver` hanno priorità su di esso.

---

## 6. Plan Library — i piani concreti

### `GoPickUp` — raccogliere un pacco
1. `subIntention(['go_to', x, y])` → naviga con A* fino al pacco
2. `socket.emitPickup()` — raccoglie
3. Se `emitPickup` restituisce array vuoto → il pacco è già stato preso → ban temporaneo

### `GoDeliver` — consegnare
1. `subIntention(['go_to', x, y])` → naviga verso la delivery zone
2. `socket.emitPutdown()` — deposita tutti i pacchi in mano
3. Se la navigazione fallisce → ban temporaneo sulla zona

### `Patrol` — esplorare una spawn zone
1. `subIntention(['go_to', x, y])` → naviga verso la spawn
2. Segna la zona come visitata nel `visitedSpawns` (cooldown 15 s)

### `AStarMove` — navigazione passo per passo
Piano di basso livello. Funziona in un **loop** che:
1. Chiama `Planner.getPath()` con le credenze più recenti (casse, agenti, congestione)
2. Esegue **solo il primo passo** del percorso calcolato
3. Ricalcola il percorso al passo successivo (adattamento a ostacoli dinamici)
4. Se il server rifiuta la mossa → aggiunge una penalità nella `congestionMap` per quel tile
5. Se esiste un percorso → aggiorna `me.x/y` e calibra `movementDurationMs`

---

## 7. Il Planner A* — `planner.js`

### Logica di base

**A\*** minimizza `f = g + h` dove:
- `g` = costo reale percorso da start
- `h` = euristica ammissibile (distanza Manhattan)

Esplora sempre il nodo con `f` minore (openSet ordinato), marca i nodi esplorati nel closedSet.

### Costi di spostamento

| Situazione | Costo extra |
|---|---|
| Mossa normale | 1 |
| Pacco a terra sulla casella | +15 |
| Tile in `congestionMap` | +`penalty` (incrementale) |
| Push di una cassa (spingibile) | +10 |
| Muro / bordo / cassa non spingibile | ∞ (casella saltata) |

### Fix implementati rispetto alla versione originale

**Bug 1 — Caselle direzionali (nastri):**  
La versione originale controllava `tile.direction` che è sempre `undefined`. Il fix usa `tile.type` direttamente:
```js
if (ARROW_TYPES.has(neighborTile.type) &&
    arrowToProhibitedEntry[neighborTile.type] === dirName) continue;
```
Regola: non si può entrare in un nastro contromano (es. in `'→'` non si può entrare muovendosi verso `'left'`).

**Bug 2 — Casse mobili:**  
La versione originale non riceveva le casse come parametro. Ora `crateKeys` (un `Set<"x,y">`) viene passato e trattato come ostacolo fisico. Le casse *spingibili* (tile gialla libera dietro) sono attraversabili con costo extra +10, ma solo se il push non disconnette le zone critiche (controllo BFS in `checkConnectivity()`).

### `checkConnectivity()` — sicurezza dei push

Prima di permettere di spingere una cassa, il planner simula la mappa dopo il push e verifica con una **BFS** che tutte le `criticalZones` (posizione corrente dell'agente + delivery zones) rimangano mutuamente raggiungibili. Se il push crea un'isola, viene bloccato.

---

## 8. Differenze rispetto alla versione FSM (agente / agente2)

| Aspetto | FSM (agente) | BDI (agente3) |
|---|---|---|
| Struttura decisionale | Stati IDLE/PICKUP/DELIVER/PATROL | Ciclo Beliefs→Desires→Intentions |
| Interruzione piani | Watchdog con timeout | `stop()` propagato nella catena Intention→Plan→subIntention |
| Navigazione | A* (stessa logica) | A* con ricalcolo ad ogni passo + fix nastri + fix casse |
| Anti-ripetizione patrol | Dynamic Heatmap | `visitedSpawns` con cooldown |
| Congestione | Congestion Map | `congestionMap` (stessa idea, integrata nel planner) |
| Inerzia decisionale | Anti-Jitter System esplicito | Implicita: `push()` ignora predicati identici |

---

## 9. File e configurazione

| File | Ruolo |
|---|---|
| `agent.js` | Entry point: setup connessione, optionsGeneration, Plan Library, loop BDI |
| `beliefs.js` | Database cognitivo: updateMap, updateSensing, helper getter |
| `planner.js` | Algoritmo A* con fix nastri, casse e check connettività |
| `.env` | `HOST`, `TOKEN`, `SENSING_RADIUS` |

**Parametri chiave configurabili in `agent.js`:**

```
movementDurationMs   = 50      (auto-calibrato, EMA α=0.3)
EXPECTED_SPAWN_VALUE = 4       (reward medio atteso per pattugliamento)
MAX_CAPACITY         = 6       (massimo pacchi in mano)
OPPORTUNISTIC_RADIUS = 5       (raggio pickup opportunistico durante delivery)
SPAWN_COOLDOWN_MS    = 15000   (cooldown spawn visitate)
BAN_DURATION_MS      = 3000    (ban obiettivi irraggiungibili)
CONGESTION_PENALTY   = 100     (penalità tile bloccati)
CONGESTION_DURATION_MS = 5000  (TTL voci congestion map)
SENSING_RADIUS       = 5       (da .env — deve corrispondere al server)
```
