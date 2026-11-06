# TSPTW instances (day planner benchmark)

Dumas, Desrosiers, Gélinas & Solomon (1995), "An optimal algorithm for the
traveling salesman problem with time windows", Operations Research 43(2):
the standard test set for one vehicle with time windows. Here the sizes that
match a working day and a bit beyond: 20, 40 and 60 customers, window widths
20–100, five instances each (75 in all).

    nNNwWW.SSS.txt   number of nodes (depot = node 0), the integer travel-time
                     matrix (service time included in the leg that leaves a
                     node), then one "ready due" line per node
    nNNwWW.SSS.sol   best-known tour (customers in visit order) and its cost

Both are copied unchanged from https://github.com/RieraULL/TSPTW_results
(commit 45bc43d, CC0 1.0), the data of Riera-Ledesma & Rodríguez-Martín,
"Capturing the logic of time windows: a dual-based path inequality approach":
`input/instances/Dumas/` and `input/UB/BK_UB/Dumas/` (their best-known
solutions). Dumas et al. solved these instances to optimality, so the
best-known costs are commonly reported as the optima.

`test/bench-tsptw.js` re-checks every best-known tour against its instance
before using it, and stops if the checker and the file disagree.
