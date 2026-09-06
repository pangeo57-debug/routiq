# Benchmark instances

`*.vrp` are Solomon's 1987 VRPTW benchmark instances (100 customers), the
standard test set for vehicle routing with time windows. `*.sol` are the
best-known solutions for them.

Both come from https://github.com/PyVRP/Instances so the instance and its
best-known solution use the same distance convention. That convention was
**derived, not assumed**: recomputing the C101 solution's routes gives 828.94
with exact Euclidean distances, 829.00 rounded to integers, and **827.30 with
each edge truncated to one decimal** — which is the figure in the file. So the
benchmark truncates too, and its comparison is like for like.

  instance   best known
  C101       10 routes, 827.3
  R101       20 routes, 1637.7
  RC101      15 routes, 1619.8

The three classes differ deliberately: C is tightly clustered customers with
narrow time windows, R is uniformly random, RC a mix.

Solomon, M. M. (1987), "Algorithms for the Vehicle Routing and Scheduling
Problems with Time Window Constraints", Operations Research 35(2).
