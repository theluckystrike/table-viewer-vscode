"""Builds earthquakes-2026-10.xlsx (3 sheets, real Excel date cells) from the USGS CSV. Needs openpyxl."""
import csv, datetime, collections, sys
from openpyxl import Workbook
from openpyxl.styles import Font
src, out = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(src)))
wb = Workbook()
ws = wb.active; ws.title = 'M4.5+'
ws.append(['time_utc', 'magnitude', 'mag_type', 'depth_km', 'place', 'latitude', 'longitude', 'network', 'status'])
for r in rows:
    m = float(r['mag'])
    if m < 4.5: continue
    t = datetime.datetime.strptime(r['time'][:19], '%Y-%m-%dT%H:%M:%S')
    ws.append([t, m, r['magType'], float(r['depth']), r['place'], float(r['latitude']), float(r['longitude']), r['net'], r['status']])
for c in ws['A'][1:]: c.number_format = 'yyyy-mm-dd hh:mm:ss'
ws2 = wb.create_sheet('By day')
ws2.append(['date', 'events', 'max_magnitude', 'mean_depth_km'])
d = collections.defaultdict(list)
for r in rows: d[r['time'][:10]].append(r)
for k in sorted(d):
    v = d[k]
    ws2.append([datetime.datetime.strptime(k, '%Y-%m-%d').date(), len(v), max(float(x['mag']) for x in v), round(sum(float(x['depth']) for x in v) / len(v), 1)])
ws3 = wb.create_sheet('By network')
ws3.append(['network', 'events', 'largest'])
n = collections.defaultdict(list)
for r in rows: n[r['net']].append(float(r['mag']))
for k, v in sorted(n.items(), key=lambda kv: -len(kv[1])): ws3.append([k, len(v), max(v)])
for s in (ws, ws2, ws3):
    for c in s[1]: c.font = Font(bold=True)
wb.save(out)
