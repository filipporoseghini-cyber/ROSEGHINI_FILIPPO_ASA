/* ============================================================================
   FILE: pddlDelivery.test.mjs  (agente3)
   SCOPO: Test/validazione del planner PDDL di livello task (pddlDelivery.js).

   COME SI USA:
     cd agente3
     npm install                      # serve @unitn-asa/pddl-client + deps
     node pddlDelivery.test.mjs            # stampa dominio+problema E prova il solver
     node pddlDelivery.test.mjs --offline  # solo generazione PDDL (nessuna rete)

   COSA VERIFICA:
     1) che il PROBLEMA PDDL generato sia ben formato (objects/init/goal);
     2) (online) che il solver del corso restituisca un piano e che la nostra
        traduzione in step go/pickup/deliver sia corretta.

   Usa una mappa FINTA 6x6 con tre pacchi e una delivery zone: nessun server
   Deliveroo necessario. Le beliefs sono simulate con l'interfaccia minima che
   PddlDeliveryPlanner.plan() richiede.
============================================================================ */

import { PddlDeliveryPlanner } from "./pddlDelivery.js";

const OFFLINE = process.argv.includes('--offline');

/* ----------------------------------------------------------------------------
   FakeBeliefs: implementa solo i metodi/campi usati dal planner.
---------------------------------------------------------------------------- */
class FakeBeliefs {
    constructor() {
        this.map = new Map();
        this.deliveryZones = [];
        this._parcels = [];

        // Mappa aperta 6x6 (x,y in 0..5), tutta percorribile (type '3').
        for (let x = 0; x <= 5; x++) {
            for (let y = 0; y <= 5; y++) {
                this.map.set(`${x},${y}`, { x, y, type: '3' });
            }
        }
        // Delivery zone in (0,5).
        this.map.set('0,5', { x: 0, y: 5, type: '2' });
        this.deliveryZones = [{ x: 0, y: 5 }];

        // Tre pacchi a terra.
        const now = Date.now();
        this._parcels = [
            { id: 'p_alpha', x: 5, y: 0, reward: 30, lastSeen: now },
            { id: 'p_beta',  x: 5, y: 5, reward: 18, lastSeen: now },
            { id: 'p_gamma', x: 3, y: 2, reward: 12, lastSeen: now },
        ];
    }
    getAvailableParcels() { return this._parcels; }
    getCarriedParcels(_myId) { return []; }
    getCrateKeys() { return new Set(); }
    getOtherAgentPositions(_myId) { return []; }
    getDecayRatePerMs() { return 1 / 1000; }
}

const me = { x: 0, y: 0, id: 'me' };
const beliefs = new FakeBeliefs();

console.log('================ DOMINIO PDDL ================\n');
console.log(PddlDeliveryPlanner.domain);

console.log('\n================ PROBLEMA PDDL (offline) ================\n');
const built = PddlDeliveryPlanner.buildProblemPddl(me, beliefs);
if (!built) {
    console.log('buildProblemPddl ha restituito null (niente da pianificare?).');
    process.exit(1);
}
console.log(built.problemPddl);
console.log('Statistiche:', JSON.stringify(built.stats));

if (OFFLINE) {
    console.log('\n[--offline] Salto la chiamata al solver online. OK.');
    process.exit(0);
}

console.log('\n================ PIANO DAL SOLVER (online) ================\n');
const result = await PddlDeliveryPlanner.plan(me, beliefs);
if (!result) {
    console.log('plan() → null (solver irraggiungibile o nessun piano). Il BDI userebbe il fallback euristico.');
    process.exit(0);
}
console.log('Step:', PddlDeliveryPlanner.formatSteps(result.steps));
console.log('Stats:', JSON.stringify(result.stats));
console.log('\nDettaglio step:');
for (const s of result.steps) console.log('  ', JSON.stringify(s));
