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

All 56 instances of the set are here. `npm run bench` runs three of them as a
quick check; `npm run bench -- --all` runs the whole set, and
`npm run bench -- --class R2` one family.

  instance   best known
  C101       10 routes, 827.3
  R101       20 routes, 1637.7
  RC101      15 routes, 1619.8

Six families, and they differ on purpose — a method can be good at one and
poor at another, so quoting a single instance proves nothing:

  C   clustered customers          R   uniformly random      RC  a mix
  1   short horizon, many routes   2   long horizon, few routes, large capacity

The three originally committed here (C101, R101, RC101) are all from series 1,
which is the easy direction for us: series 2 asks for a few long routes, and
routes are the objective we do not have. The whole set was added so that the
number being quoted is an average over the families rather than a choice of
which three to show.

Verification: the three files already in the repository were compared
byte-for-byte against the same upstream checkout before the other 53 were
trusted from it.

Solomon, M. M. (1987), "Algorithms for the Vehicle Routing and Scheduling
Problems with Time Window Constraints", Operations Research 35(2).
