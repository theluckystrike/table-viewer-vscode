# Changelog

## 0.3.3 (2026-11-08)

- An empty file (0 bytes), a sheet with no cells or a file that cannot be read no longer counts as a good open for the rating question, so the question never shows next to the "This file is empty" note.
- A CSV saved as Windows-1252 (Excel's "CSV" on Windows in Western locales) now shows é, € and smart quotes instead of the replacement character. UTF-8 and UTF-16 files read as before.
- The README and the Marketplace description now start with what was already true: it is free, with no paywall, no ads, no license banner, no evaluation popup and no account.
- An Excel sheet whose first row has no text (only numbers, dates or true/false) no longer loses that row as column names. The row shows as data, and the columns are named A, B, C as in Excel. A sheet holding one date showed "0 rows" before.
- The rating question now comes after 3 files that opened without an error on 2 different days, and never after an error. "Later" asks one more time after 7 days, "No thanks" ends it, and it never asks more than 2 times. `tableViewer.askForRating: false` turns it off.

## 0.3.2 (2026-11-08)

- The "More free viewers" list and the README now use the current Marketplace names and include the newest Zovo extensions: ZIP, GCode, EPUB, HAR, font and audio viewers.

## 0.3.1 (2026-11-07)

- An empty file (0 bytes) or a sheet with no data now shows a note above the grid instead of an empty table.

## 0.3.0 (2026-11-07)

- Excel number formats: cells show what Excel shows (25.0%, $1,234.50, 1,234,567, dates in the workbook's format). Sort, filters and copy keep the stored values, the cell panel shows both, and "Excel formats: on" in the toolbar switches a tab to the stored values. New setting `tableViewer.excelFormats`.
- Compare with Git HEAD and Compare with Another Table File: CSV, TSV, Excel and Parquet files open as CSV text in VS Code's diff editor, one section per Excel sheet. In the Explorer and Source Control context menus, the editor title bar and the new Compare button. New setting `tableViewer.maxCompareRows`.
- Auto-reload: when the file changes on disk, the table reads it again and keeps the sort, filters, search and sheet. A Reload button reads it on request. New setting `tableViewer.autoReload`.
- The Marketplace name is now "XLSX Viewer, Excel Viewer, CSV Viewer & Parquet Viewer". The extension id, commands and settings stay the same.

## 0.2.3 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.2.2 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.
- The Marketplace name is now "CSV Viewer, Excel Viewer (XLSX) & Parquet Viewer" (it was "CSV Viewer, Excel Viewer & Parquet Viewer"). The extension id, commands and settings stay the same.
- The Marketplace description now opens with "CSV viewer, Excel viewer and XLSX viewer that also opens Parquet".
- Marketplace search keywords updated.

## 0.2.1 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with Large JSON Viewer & JSON Tree and DOCX Viewer & Word Viewer with Dark Mode.

## 0.2.0 (2026-11-06)

- Pick the delimiter for a CSV or TSV file in the toolbar. The choices are Auto, comma, tab, semicolon, pipe and colon. Auto shows what it found, for example "Auto (comma)". This fixes files where the guess was wrong, such as a semicolon file whose text has commas in it. The file is read again with the new choice.
- A "Header row" box for CSV and TSV. Untick it for a file without a header, and the first line stays a row of data, with columns named column_1, column_2 and so on.
- Both choices are kept for each file in the workspace and used the next time it opens. Going back to Auto with a header row forgets them.
- Double-click a cell, or press Enter, to see its full value in a panel under the table. Long text wraps and is shown in full (the grid cuts cells at 2,000 characters), JSON objects and arrays are indented, and "Raw" shows the stored text. The panel follows the arrow keys. "Copy value" copies it, and Esc closes the panel.
- Double-click the edge of a column header to fit that column to the rows loaded so far, up to 900 px.
- The toolbar wraps onto a second line in a narrow editor instead of squeezing its buttons.
- All of this is free. Nothing is sent anywhere.

## 0.1.5 (2026-11-06)

- The Marketplace page now starts with a screenshot of a real VS Code window with a 1,000,000 row Parquet file, sorted and filtered, and a short GIF of the same steps. Both were made from generated sample files. The images load from the GitHub repo and are not packed into the extension, so the download size stays the same.

## 0.1.4 (2026-11-06)

- The status bar under the table ends with a small line with two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `tableViewer.showSupportLinks` (default `true`) hides it, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "Table Viewer: Support the developer" and "Table Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions. No change to what is free or to Pro.

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
