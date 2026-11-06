# Writes small test fixtures with pyarrow. Run: python3 -I scripts/make-fixtures.py test/fixtures
import sys, datetime, os
import pyarrow as pa, pyarrow.parquet as pq
out = sys.argv[1]
n = 150
ids = list(range(1, n + 1))
names = [None if i % 17 == 0 else f"item <b>{i}</b> \"q\", ok" if i == 3 else f"item {i}" for i in ids]
price = [None if i % 11 == 0 else round(i * 1.25, 2) for i in ids]
stock = [i % 2 == 0 for i in ids]
created = [datetime.date(2024, 1, 1) + datetime.timedelta(days=i) for i in ids]
ts = [datetime.datetime(2024, 5, 1, 12, 0, 0) + datetime.timedelta(minutes=i) for i in ids]
tags = [[f"t{i % 3}", f"t{i % 5}"] if i % 4 else [] for i in ids]
attrs = [{"a": i, "b": f"x{i}"} for i in ids]
big = [2**60 + i for i in ids]
t = pa.table({
  "id": pa.array(ids, pa.int64()), "name": pa.array(names, pa.string()), "price": pa.array(price, pa.float64()),
  "in_stock": pa.array(stock, pa.bool_()), "created": pa.array(created, pa.date32()),
  "ts": pa.array(ts, pa.timestamp("ms", tz="UTC")), "tags": pa.array(tags, pa.list_(pa.string())),
  "attrs": pa.array(attrs, pa.struct([("a", pa.int32()), ("b", pa.string())])), "big": pa.array(big, pa.int64()),
}, metadata={b"origin": b"fixture"})
pq.write_table(t, os.path.join(out, "sample.parquet"), row_group_size=50, compression="snappy")
pq.write_table(t, os.path.join(out, "sample-zstd.parquet"), row_group_size=50, compression="zstd")
pq.write_table(t, os.path.join(out, "sample-gzip.parquet"), row_group_size=50, compression="gzip")
