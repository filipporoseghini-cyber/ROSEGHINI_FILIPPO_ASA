/* ============================================================================
   planner.js — A* pathfinder with conveyor-belt and crate support.

   Two non-obvious bugs were fixed vs the original scaffold:

   BUG 1 — Directional tiles ('↑' '→' '↓' '←'): the original code checked
   tile.direction which does not exist in the SDK; the direction is encoded
   directly in tile.type as an arrow character. As a result the one-way
   restriction was never enforced and the agent could enter conveyors against
   the flow. Fix: compare tile.type against arrow characters directly.

   BUG 2 — Crates: the original planner had no crate parameter, so crates were
   treated as empty floor. Fix: accept a crateKeys set (position strings "x,y")
   and treat them as hard walls.

   Architectural choice — crates as absolute walls:
   The A* here never pushes crates. A greedy single-push (even if locally safe
   per checkConnectivity's no-regression check) can irreversibly corrupt a
   Sokoban maze and lock the agent out of spawn or delivery zones. All crate
   pushing goes exclusively through the PDDL Sokoban planner (pddlCrates.js /
   CrateNavigate), which validates the full push sequence before executing.
   When getPath returns null due to blocking crates, the caller delegates to
   CrateNavigate.
============================================================================ */

export class Planner {

    /* -----------------------------------------------------------------------
       getPath() — main entry point.

       Returns an array of moves ['right','up',...] to reach goal from start,
       [] if already at goal, or null if no path exists.

       Parameters:
         start, goal    — { x, y }
         mapBeliefs     — Map<"x,y", tile>  (from Beliefs.map)
         agents         — other agents { x, y }[] treated as soft obstacles
         parcels        — parcels { x, y }[] treated as soft obstacles (+15 cost)
         congestionMap  — Map<"x,y", { penalty, expireAt }> from recent rejects
         crateKeys      — Set<"x,y">  hard-wall crate positions
         criticalZones  — { x, y }[] that must stay connected after any push
    ----------------------------------------------------------------------- */
    static getPath(
        start,
        goal,
        mapBeliefs,
        agents        = [],
        parcels       = [],
        congestionMap = new Map(),
        crateKeys     = new Set(),
        criticalZones = []
    ) {
        const heuristic = (a, b) =>
            Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        const nodeKey = n => `${Math.round(n.x)},${Math.round(n.y)}`;

        const startX = Math.round(start.x), startY = Math.round(start.y);
        const goalX  = Math.round(goal.x),  goalY  = Math.round(goal.y);

        if (!mapBeliefs.has(`${startX},${startY}`)) return null;

        const agentSet  = new Set(agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`));
        const parcelSet = new Set(parcels.map(p => `${Math.round(p.x)},${Math.round(p.y)}`));

        let openSet = [{
            x: startX, y: startY,
            g: 0,
            f: heuristic({ x: startX, y: startY }, { x: goalX, y: goalY }),
            parent: null, action: null
        }];
        const closedSet = new Set();

        // Deliveroo.js coordinate system: 'up' increases Y, 'down' decreases Y.
        const directions = {
            right: { dx:  1, dy:  0 },
            left:  { dx: -1, dy:  0 },
            up:    { dx:  0, dy:  1 },
            down:  { dx:  0, dy: -1 },
        };

        const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);

        // Conveyor entry rule (BUG 1 fix): entering a directional tile is
        // forbidden only from the direction OPPOSITE to the arrow's flow.
        // Exit from a conveyor is always allowed in any direction.
        const arrowProhibitedEntry = {
            '→': 'left',  '←': 'right',
            '↑': 'down',  '↓': 'up',
        };

        while (openSet.length > 0) {
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift();

            if (current.x === goalX && current.y === goalY) {
                // Reconstruct path by walking the parent chain.
                const path = [];
                let node = current;
                while (node.parent) { path.push(node.action); node = node.parent; }
                return path.reverse();
            }

            closedSet.add(nodeKey(current));

            for (const [dirName, vec] of Object.entries(directions)) {
                const nx = current.x + vec.dx;
                const ny = current.y + vec.dy;
                const nKey = `${nx},${ny}`;

                if (closedSet.has(nKey)) continue;

                const neighborTile = mapBeliefs.get(nKey);
                if (!neighborTile || String(neighborTile.type) === '0') continue;

                // Other agents are obstacles everywhere except the goal tile
                // (we need to be able to plan toward an occupied destination).
                if (agentSet.has(nKey) && (nx !== goalX || ny !== goalY)) continue;

                // Crates are hard walls — the A* never pushes (see file header).
                if (crateKeys.has(nKey)) continue;

                // Conveyor entry check (BUG 1 fix).
                if (ARROW_TYPES.has(neighborTile.type) &&
                    arrowProhibitedEntry[neighborTile.type] === dirName) continue;

                let stepCost = 1;
                if (parcelSet.has(nKey) && (nx !== goalX || ny !== goalY)) stepCost += 15;
                if (congestionMap.has(nKey)) stepCost += congestionMap.get(nKey).penalty;

                const tentative_g = current.g + stepCost;
                const existing = openSet.find(n => n.x === nx && n.y === ny);

                if (!existing) {
                    openSet.push({
                        x: nx, y: ny,
                        g: tentative_g,
                        f: tentative_g + heuristic({ x: nx, y: ny }, { x: goalX, y: goalY }),
                        parent: current,
                        action: dirName,
                    });
                } else if (tentative_g < existing.g) {
                    existing.g = tentative_g;
                    existing.f = tentative_g + heuristic({ x: nx, y: ny }, { x: goalX, y: goalY });
                    existing.parent = current;
                    existing.action = dirName;
                }
            }
        }

        return null; // no path exists
    }

    /* -----------------------------------------------------------------------
       checkConnectivity — verifies that pushing a crate from oldCrateKey to
       newCrateKey does not disconnect any of the criticalZones from each other.

       Uses a BFS before and after the simulated push. A push is safe only if
       every zone that was reachable before remains reachable after — stricter
       than a simple count comparison, which could miss a "swap" where one zone
       is disconnected while another becomes reachable, still leaving the net
       count unchanged.

       Using criticalZones[0] = agent position (as AStarMove does) makes the
       invariant "all zones stay in the same connected component as the agent",
       which is exactly what we need to avoid self-stranding.
    ----------------------------------------------------------------------- */
    static checkConnectivity(oldCrateKey, newCrateKey, mapBeliefs, crateKeys, criticalZones) {
        if (criticalZones.length < 2) return true;

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

        const visitedBefore = bfsReachable(crateKeys, criticalZones[0]);

        const simulated = new Set(crateKeys);
        simulated.delete(oldCrateKey);
        simulated.add(newCrateKey);

        const visitedAfter = bfsReachable(simulated, criticalZones[0]);

        // No zone that was reachable before may become unreachable after.
        return criticalZones.every(z => {
            const k = `${Math.round(z.x)},${Math.round(z.y)}`;
            return !visitedBefore.has(k) || visitedAfter.has(k);
        });
    }
}
