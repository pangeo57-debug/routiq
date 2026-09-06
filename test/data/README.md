# Benchmark instances

`C101.txt`, `R101.txt`, `RC101.txt` are Solomon's 1987 VRPTW benchmark
instances (100 customers), the standard test set for vehicle routing with time
windows. They are used here as **independently authored hard data** — geometry
and time windows designed by someone with no knowledge of this scheduler —
rather than as a scored benchmark.

A scored comparison against published best-known solutions is not possible:
those solutions use 10 (C101), 19 (R101) and 14 (RC101) vehicles, while
RoutePal has at most six days. `test/benchmark.js` instead subsets each
instance to what six days can hold and measures the gap to an **exact** optimum
that it computes itself per day.

The three clusters differ deliberately:
  C  — customers in tight geographic clusters
  R  — uniformly random positions
  RC — a mix of both

Source: Solomon, M. M. (1987), "Algorithms for the Vehicle Routing and
Scheduling Problems with Time Window Constraints", Operations Research 35(2).
Files retrieved from https://github.com/iRB-Lab/py-ga-VRPTW
