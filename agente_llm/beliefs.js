/* ============================================================================
   beliefs.js — Cognitive database for Agent B (LLM).

   Maintains two categories of world state:
     STATIC  — map structure (walls, delivery zones, spawn zones). Loaded once
               from the server's onMap event and never changed.
     DYNAMIC — parcels, crates, other agents. Updated every sensing tick.

   Tile type legend:
     '0'  = wall   '1' = spawn zone   '2' = delivery zone   '3' = floor
     '4'  = base   '5' = crate-slide tile (yellow)   '5!' = crate-spawn tile
     '↑' '→' '↓' '←' = conveyor belts (directional)
============================================================================ */

const AGENT_MEMORY_MS = 30000; // how long to remember an agent we no longer see

export class Beliefs {
    constructor() {
        // STATIC — populated once in updateMap(), never mutated afterward.
        this.map = new Map();           // "x,y" → tile object
        this.deliveryZones = [];        // { x, y }[]
        this.spawnZones = [];           // { x, y }[]

        // DYNAMIC — revised every sensing tick.
        this.parcels = new Map();       // id → { id, x, y, reward, carriedBy, lastSeen }
        this.crates  = new Map();       // id → { id, x, y, lastSeen }  (id-keyed, TTL-based)
        this.otherAgentsMemory = new Map(); // id → { id, x, y, lastSeen }

        // Observed reward-decay rate (pts/ms). Calibrated dynamically from
        // consecutive observations of the same parcel. Null until first measurement.
        this.globalDecayRatePerMs = null;
    }

    /* Called once on startup with the full tile array from the server. */
    updateMap(tiles) {
        let nDelivery = 0, nSpawn = 0;

        for (const tile of tiles) {
            const key = `${Math.round(tile.x)},${Math.round(tile.y)}`;
            this.map.set(key, tile);

            const tx = Math.round(tile.x);
            const ty = Math.round(tile.y);

            // Compatibility: Deliveroo.js exposes zone membership via both a
            // numeric 'type' and boolean flags (tile.delivery, tile.parcelSpawner).
            if (String(tile.type) === '2' || tile.delivery === true) {
                if (!this.deliveryZones.find(z => z.x === tx && z.y === ty)) {
                    this.deliveryZones.push({ x: tx, y: ty });
                    nDelivery++;
                }
            }

            if (String(tile.type) === '1' || tile.parcelSpawner === true) {
                if (!this.spawnZones.find(z => z.x === tx && z.y === ty)) {
                    this.spawnZones.push({ x: tx, y: ty });
                    nSpawn++;
                }
            }
        }

        console.log(`[BELIEFS] Map loaded: ${nDelivery} delivery zones | ${nSpawn} spawn zones`);
    }

    /* Called on every sensing tick. Applies belief revision for parcels,
       crates, and agents. */
    updateSensing(sensings, myPosition, sensingRadius = 5) {
        const now = Date.now();

        // ── PARCELS ──────────────────────────────────────────────────────────
        for (const p of sensings.parcels) {
            const existing = this.parcels.get(p.id);
            p.lastSeen = now;

            // Calibrate global decay rate via EMA (α=0.3) whenever we observe
            // the same free parcel with a lower reward than before.
            if (existing && !existing.carriedBy && !p.carriedBy &&
                p.reward < existing.reward && existing.lastSeen < now) {
                const dt = now - existing.lastSeen;
                const observed = (existing.reward - p.reward) / dt;
                this.globalDecayRatePerMs = this.globalDecayRatePerMs === null
                    ? observed
                    : 0.7 * this.globalDecayRatePerMs + 0.3 * observed;
            }

            this.parcels.set(p.id, p);
        }

        // Evict ghost parcels: inside FOV but absent from sensing frame = gone;
        // not seen for 25 s = probably expired.
        for (const [id, p] of this.parcels.entries()) {
            const dist = Math.abs(p.x - myPosition.x) + Math.abs(p.y - myPosition.y);
            if (dist <= sensingRadius) {
                if (!sensings.parcels.find(sp => sp.id === id)) {
                    this.parcels.delete(id);
                    continue;
                }
            }
            if (now - (p.lastSeen || now) > 25000) this.parcels.delete(id);
        }

        // ── AGENTS ───────────────────────────────────────────────────────────
        for (const a of (sensings.agents || [])) {
            this.otherAgentsMemory.set(a.id, { id: a.id, x: a.x, y: a.y, lastSeen: now });
        }
        for (const [id, a] of this.otherAgentsMemory.entries()) {
            if (now - a.lastSeen > AGENT_MEMORY_MS) this.otherAgentsMemory.delete(id);
        }

        // ── CRATES ───────────────────────────────────────────────────────────
        // Simple id-keyed model with 25 s TTL — no persistent positional model
        // (Agent B does not perform PDDL Sokoban planning).
        const cratesVisible = sensings.crates || [];

        for (const c of cratesVisible) {
            c.lastSeen = now;
            this.crates.set(c.id, c);
        }

        for (const [id, c] of this.crates.entries()) {
            const dist = Math.abs(c.x - myPosition.x) + Math.abs(c.y - myPosition.y);
            if (dist <= sensingRadius) {
                if (!cratesVisible.find(sc => sc.id === id)) {
                    this.crates.delete(id);
                    continue;
                }
            }
            if (now - (c.lastSeen || now) > 25000) this.crates.delete(id);
        }
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    getAvailableParcels() {
        return Array.from(this.parcels.values()).filter(p => !p.carriedBy);
    }

    getCarriedParcels(myId) {
        return Array.from(this.parcels.values()).filter(p => p.carriedBy === myId);
    }

    /* Returns other agents' positions as { x, y } obstacles for the planner.
       Coordinates are rounded because the server interpolates movement. */
    getOtherAgentPositions(myId) {
        return Array.from(this.otherAgentsMemory.values())
            .filter(a => a.id !== myId)
            .map(a => ({ x: Math.round(a.x), y: Math.round(a.y) }));
    }

    /* Conservative default of 1 pt/s until a real observation is available.
       A slightly-high default nudges the agent toward faster delivery. */
    getDecayRatePerMs() {
        return this.globalDecayRatePerMs ?? (1 / 1000);
    }

    /* Returns current crate positions as a Set<"x,y"> for O(1) lookup. */
    getCrateKeys() {
        const set = new Set();
        for (const c of this.crates.values()) {
            set.add(`${Math.round(c.x)},${Math.round(c.y)}`);
        }
        return set;
    }
}
