# Changelog

## 0.1.3 (2026-11-06)

- Table Viewer asks one time for a Marketplace rating. It counts each success (an opened table file). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `tableViewer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

## 0.1.2 (2026-11-06)

- Listing only, no change to the extension. The display name is now "CSV Viewer, Excel Viewer & Parquet Viewer" and the description is one sentence, so the listing uses the words people search for (csv viewer (18), excel viewer (15), parquet viewer (16), parquet (28)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

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
