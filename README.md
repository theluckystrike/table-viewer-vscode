# CSV Viewer, Excel Viewer (XLSX) & Parquet Viewer

<a href="https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode"><img src="https://img.shields.io/visual-studio-marketplace/i/zovo.table-viewer-vscode?label=VS%20Code%20installs" alt="VS Code installs"></a>
<a href="https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/zovo.table-viewer-vscode?label=version" alt="Version"></a>

A CSV viewer, Excel viewer (XLSX) and Parquet viewer for VS Code: it shows Parquet, Excel and CSV files as a sortable, filterable table, even at 1,000,000 rows, with no Python and no setup.

![A 1,000,000 row Parquet file in VS Code, sorted by fare_usd from high to low and filtered to zones that contain Airport, with 99,481 of 1,000,000 rows matching](https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/vscode-parquet.png)

*A real VS Code 1.142 window running this extension on a generated 1,000,000 row taxi-trip Parquet file (12 MB, zstd, made by [`scripts/screenshot/make_trips.py`](https://github.com/theluckystrike/table-viewer-vscode/blob/main/scripts/screenshot/make_trips.py)). It loaded in 0.8 s on an M-series Mac.*

- Opens fast. Rows are read in a background thread and only the rows and columns on screen are drawn, so VS Code doesn't freeze, even on a file with 5,000 columns. A big CSV shows its first rows while the rest load, and a Parquet file with several row groups shows the first group early. Excel files load whole.
- No Python, no kernel, no account. It's plain JavaScript that runs offline and sends nothing anywhere.
- Answers the usual questions in one place. You get the column types, the row count, the full Parquet schema, sort, filter and copy-as-CSV/JSON, and the full text of any cell with its JSON indented.

## Quick start

1. Install Table Viewer and click any `.parquet`, `.xlsx`, `.xls` or `.ods` file. It opens as a table.
2. For a `.csv` or `.tsv` file, click the table icon at the top right of the editor (or right-click the file and pick "Open in Table Viewer").

![A click on the Parquet file opens 1,000,000 rows. A click on the fare_usd header sorts it, Airport in the zone filter keeps the airport trips, and <60 in the fare filter drops the top fares](https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/demo-table.gif)

*Recorded in the same window. The white arrow is drawn in to show where each click lands.*

Run "Table Viewer: Get Started" from the Command Palette for a short tour.

## What you can do

Click a column header to sort it. Clicks cycle through ascending, descending and the file's own order. Nulls always go last.

Type in the box under a header to filter that column. Number columns take `>10`, `>=10`, `<5`, `=3`, `!=3` and ranges like `5..9`. Text columns match any part of the text, `=word` matches exactly and `!word` drops rows that contain it. `empty` and `!empty` work everywhere. The search box at the top looks in every column at once.

Drag or Shift+click to select cells. Click row numbers to select whole rows, or the `#` corner (or Ctrl+A) to select everything. "Copy CSV" copies the selection with a header row, and "Copy JSON" copies an array of objects that keeps numbers, booleans and nested values as JSON. Ctrl+C (Cmd+C on macOS) copies plain tab-separated values, which paste straight into Excel or Google Sheets as cells. With nothing selected, the copy buttons take the whole filtered view.

Double-click a cell, or press Enter, to open the cell panel under the table. It shows the whole value, wrapped, even past the 2,000 characters a grid cell shows. JSON objects and arrays are indented, and "Raw" shows the text as it is in the file. The panel follows the arrow keys, "Copy value" copies what it shows, and Esc closes it.

Double-click the edge of a column header to fit the column to the rows loaded so far.

The Schema button shows each column's type. For Parquet it also shows the full schema tree with physical and logical types, plus repetition, row groups, compression, the writer and the key-value metadata.


## Supported files

| Format | Extensions | Opens by default | Reader |
|---|---|---|---|
| Parquet | `.parquet`, `.pq` | yes | hyparquet (MIT), with snappy, gzip, zstd, brotli and lz4 |
| Excel and OpenDocument | `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods` | yes | SheetJS Community Edition 0.20.3 (Apache-2.0) |
| CSV and TSV | `.csv`, `.tsv`, `.tab`, `.psv` | no, use "Open in Table Viewer" | built-in streaming parser |

CSV files keep opening in the text editor by default, since people edit them as text. The delimiter (comma, tab, semicolon or pipe) is detected from the first lines. When the guess is wrong, for example in a semicolon file whose text has commas in it, pick comma, tab, semicolon, pipe or colon in the toolbar's Delimiter list. Untick "Header row" for a file that has none, and the columns are named column_1, column_2 and so on. Both choices are kept for each file in the workspace. UTF-8 and UTF-16 files with a byte order mark both work. Excel workbooks with several sheets get a sheet picker.

Column types come from the Parquet schema, from Excel cell types, or for CSV from the values themselves (int, float, bool, date, timestamp or string). Integers too large to hold exactly stay as text, so no digits are lost.

## Limits and settings

| Setting | Default | What it does |
|---|---|---|
| `tableViewer.maxRows` | 1,000,000 | Rows to load per file. A banner says when a file has more. |
| `tableViewer.maxFileSizeMB` | 512 | How much of a CSV/TSV file to read. Parquet is read by row group, so only `maxRows` applies. |
| `tableViewer.maxExcelSizeMB` | 50 | Excel files have to be read whole. Bigger workbooks show a message instead of loading. |
| `tableViewer.maxCopyRows` | 100,000 | Most rows copied to the clipboard at once. |
| `tableViewer.askForRating` | true | Ask one time for a Marketplace rating, after 5 files and 2 days. Turn it off with `false` |

On our test machine (Apple Silicon, Node 22), the test suite loads a 1,000,000 row CSV (about 30 MB) in 0.5 s and a 1,000,000 row Parquet file in 0.15 s. It sorts either one by a number column in about 0.2 s and filters in under 0.1 s. Your numbers will differ with the column count and the file.

Table Viewer is read-only. It doesn't edit or save files.

## Compared with Data Wrangler

Microsoft Data Wrangler is a full data-cleaning tool. It needs a Python environment with pandas and runs a kernel. Table Viewer does less. It shows the file, sorts, filters and copies, and it opens before a kernel would have started. Use Data Wrangler when you need to transform data in Python, and Table Viewer when you just want to look.

## Free and Pro

Everything above is free and stays free.

A planned Pro tier adds an SQL query over the file and export to Parquet.

Neither is built yet and nothing is locked today.

## More screenshots

| Parquet, dark theme | Excel, light theme |
|---|---|
| <a href="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/screenshot.png"><img src="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/screenshot.png" alt="A 1,000,000 row Parquet file sorted by fare_usd, with a 5 by 4 cell selection and the type of each column in its header" width="100%"></a> | <a href="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/excel-light.png"><img src="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/excel-light.png" alt="An Excel workbook with three sheets, sorted by magnitude, with the sheet picker and timestamp, float and string columns" width="100%"></a> |

| Parquet schema, dark theme | CSV with filters, light theme |
|---|---|
| <a href="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/schema.png"><img src="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/schema.png" alt="The Schema panel for the Parquet file, with 8 row groups, ZSTD compression, and physical and logical types for each field" width="100%"></a> | <a href="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/csv-light.png"><img src="https://raw.githubusercontent.com/theluckystrike/table-viewer-vscode/main/images/csv-light.png" alt="A 2,226 row CSV filtered to mag &gt;=4.5 and the word Japan, sorted by depth, with 4 rows copied as JSON" width="100%"></a> |

*Real output, light and dark. The Excel and CSV files hold the real USGS earthquake catalog for October 2026 (2,226 events of magnitude 2.5 or more). The Parquet file is a generated 1,000,000 row taxi-trip table (11.7 MB, zstd). Each shot is the extension's own webview page, with its Content Security Policy, fed by the extension's real reader and message protocol and captured in headless Chrome. The Parquet file loaded in 0.8 s on an M-series Mac.*

## Privacy

Table Viewer makes no network requests and collects no telemetry. Files are read on your machine in a worker thread. The table webview runs under a strict Content Security Policy with no remote scripts, and every value from the file is written as plain text, never as HTML.

## Development

```sh
npm install
npm test          # builds with esbuild, then runs node --test
npm run package   # writes dist/table-viewer-vscode-<version>.vsix
npm run fixtures  # rebuilds test/fixtures (needs python3 with pyarrow)
```

## License

MIT. Bundled third-party licenses are in [THIRD-PARTY-NOTICES.txt](https://github.com/theluckystrike/table-viewer-vscode/blob/HEAD/THIRD-PARTY-NOTICES.txt).

[Rate this extension](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode&ssr=false#review-details) on the Marketplace if it saved you time. A rating helps other people find it.

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

## More tools by Zovo

- [SQLite Viewer & DB Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [JSONL Viewer & NDJSON Viewer (JSONL Table)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [Avro Viewer, Arrow Viewer & Feather Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.arrow-avro-viewer) opens Avro, Arrow and Feather files as a paged table.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).
