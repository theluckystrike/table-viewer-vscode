#!/bin/sh
# Data for the README screenshots: the real USGS M2.5+ catalog for October 2026 (public domain),
# an xlsx made from it, and the generated 1,000,000 row trips Parquet file.
set -e
D="${SHOT_DATA:-$(dirname "$0")/data}"
mkdir -p "$D"
curl -sS -m 60 -o "$D/earthquakes-2026-10.csv" "https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&starttime=2026-10-01&endtime=2026-11-01&minmagnitude=2.5&orderby=time-asc"
python3 "$(dirname "$0")/make-xlsx.py" "$D/earthquakes-2026-10.csv" "$D/earthquakes-2026-10.xlsx"
python3 "$(dirname "$0")/make_trips.py" "$D/trips-2026-03.parquet"
