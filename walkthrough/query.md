# Query the file with SQL

Click Query in the toolbar. The box starts with an example made from your columns. Press Ctrl+Enter (Cmd+Enter) to run it.

```sql
SELECT city, COUNT(*) AS trips, ROUND(AVG(fare), 2) AS avg_fare
FROM this
WHERE fare > 0
GROUP BY city
ORDER BY trips DESC
LIMIT 20
```

- `FROM this` is the open file. A sheet of the same workbook is `FROM "Sheet 2"`.
- Other files in the workspace go in single quotes: `JOIN 'data/customers.parquet' c ON t.customer_id = c.id`.
- A big CSV is read as a stream, so GROUP BY works on files much larger than the table can show.
- The result opens in the same grid. Sort, filter, copy and Save result (CSV, TSV, JSON, JSON Lines, Parquet) work on it. Back to file shows the file again.
- History keeps the queries you ran on each file, in this workspace only.

Everything runs on your computer. Nothing is sent anywhere.
