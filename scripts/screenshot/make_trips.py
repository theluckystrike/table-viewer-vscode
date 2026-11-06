import sys, numpy as np, pyarrow as pa, pyarrow.parquet as pq, datetime
n = 1_000_000
rng = np.random.default_rng(7)
zones = np.array(["Midtown", "Harlem", "SoHo", "Astoria", "Williamsburg", "JFK Airport", "LaGuardia", "Chelsea", "Flatiron", "Upper West Side"])
start = np.datetime64("2026-03-01T00:00:00")
pick = start + (np.sort(rng.integers(0, 31*24*3600, n))).astype("timedelta64[s]")
dist = np.round(rng.gamma(2.0, 2.2, n), 2)
fare = np.round(3.0 + dist * 1.9 + rng.normal(0, 1.5, n).clip(-2, 8), 2)
tip = np.round(np.where(rng.random(n) < 0.7, fare * rng.uniform(0.1, 0.25, n), 0), 2)
pax = rng.integers(1, 5, n).astype("int8")
pay = np.where(rng.random(n) < 0.78, "card", "cash")
t = pa.table({
  "trip_id": pa.array(np.arange(100000001, 100000001 + n, dtype="int64")),
  "pickup_at": pa.array(pick.astype("datetime64[ms]"), pa.timestamp("ms", tz="UTC")),
  "zone": pa.array(zones[rng.integers(0, len(zones), n)]),
  "distance_km": pa.array(dist), "fare_usd": pa.array(fare), "tip_usd": pa.array(tip),
  "passengers": pa.array(pax), "payment": pa.array(pay),
})
pq.write_table(t, sys.argv[1], row_group_size=128_000, compression="zstd")
