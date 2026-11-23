# Single-vehicle PVRP instances (Cordeau, Gendreau & Laporte 1997)

`p03`, `p06`, `p09` of the PVRP set: one vehicle, every customer visited once
in a horizon of 5, 10 or 8 days, on any day, with a load limit per day; no
service times, no time windows, no route-length limit. Minimise the total
Euclidean distance. This is "one person, which client on which day" — what
RoutePal's week planner decides.

Files as published by the Chaire de Distributique (HEC Montréal), copied from
a mirror (github.com/patapizza/stuff, data/cordeau/pvrp/old) because the
original server no longer answers. Format: see that set's README
(type m n t; t lines "D Q"; then "i x y d q f a combinations…").

Best known (Vidal, Crainic, Gendreau, Lahrichi & Rei, CIRRELT-2010-34, Table 3):

| instance | customers | days | best known | |
|---|---|---|---|---|
| p03 | 50 | 5 | 524.61 | proven optimal (Baldacci et al. 2010) |
| p06 | 75 | 10 | 835.26 | proven optimal (Baldacci et al. 2010) |
| p09 | 100 | 8 | 826.14 | best known |
