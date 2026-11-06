# Changelog

## 0.1.1 (2026-11-06)

- Wide files scroll fast. Only the columns in view get cells, so a 5,000 column Parquet file went from about 540 ms to about 30 ms per scroll frame.
- Row numbers stay visible when you scroll sideways. They used to scroll away with the cells.
- Excel times no longer show 1 ms early (17:56:04.999 instead of 17:56:05).
- CSV columns where every value has a date and a time are typed `timestamp`, not `date`.
- A damaged or password protected workbook shows a plain message instead of a parser error.
- Pro features (SQL filter, export, column stats, larger limits) are in the code but switched off. Nothing changes for users in this build.
- README with four real screenshots in light and dark themes, an installs badge and a version badge. Keywords updated.

## 0.1.0

First release. Opens Parquet, Excel (xlsx, xlsm, xlsb, xls), ODS, CSV and TSV files as a read-only table. It has virtual scrolling for 1,000,000 rows, sorting, per-column and global filters, column types, the Parquet schema panel, and copy as CSV, TSV or JSON.
