"""
Builds the Excel test fixtures in tests/fixtures/.
Run: python3 scripts/make-fixtures.py   (needs: pip install openpyxl)
The .xlsx files are committed, so you only need this to change them.
"""
import datetime, os, random
from openpyxl import Workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)

# 1. Realistic multi-sheet workbook with every awkward case we handle.
wb = Workbook()
ws = wb.active
ws.title = "Guest Posts"
ws.append([" Backlinks ", "Target URL", "Anchor Text", "Date", "DA", "Notes"])
rows = [
    ("https://blog.example.com/post-1", "https://lanop.co.uk/", "tax advisors", datetime.date(2026, 3, 14), 45, ""),
    ("https://blog.example.com/post-2", "https://lanop.co.uk/vat", "vat help", datetime.date(2026, 4, 2), 38, ""),
    ("HTTPS://Blog.Example.com/post-1#comments", "https://lanop.co.uk/", "dup with fragment", None, 45, "duplicate"),
    (None, "https://lanop.co.uk/", "missing backlink", None, None, "blank backlink"),
    ("not a link", None, None, None, None, "invalid text"),
    ("javascript:alert(1)", None, None, None, None, "bad protocol"),
    ("www.directory.example.org/listing/99", None, None, None, None, "no scheme"),
    ("http://localhost:8787/admin", None, None, None, None, "internal"),
    ("  https://news.example.net/story?id=7  ", None, None, None, None, "spaces"),
]
for r in rows:
    ws.append(list(r))
ws["D2"].number_format = "dd/mm/yyyy"
ws["D3"].number_format = "dd/mm/yyyy"
# Cell whose text is a label but has a real hyperlink (Excel "Insert link").
ws.append(["View post", "https://lanop.co.uk/", "linked cell", None, 20, "hyperlink"])
ws.cell(row=ws.max_row, column=1).hyperlink = "https://forum.example.com/thread/555"
# =HYPERLINK() formula
ws.append(['=HYPERLINK("https://wiki.example.com/page","Wiki")', None, None, None, None, "formula"])
# Rich text (several formatting runs in one cell)
ws.append([CellRichText(["https://rich.", TextBlock(InlineFont(b=True), "example"), ".com/a"]), None, None, None, None, "rich"])

ws2 = wb.create_sheet("Notes")
ws2.append(["Owner", "Comment"])
ws2.append(["Ali", "No backlinks on this sheet"])

ws3 = wb.create_sheet("Directories")
ws3.append(["Directory submissions 2026"])
ws3.append([])
ws3.append(["Site", "BACKLINKS", "Status"])
ws3.append(["Dir A", "https://dir-a.example.com/lanop", "Live"])
ws3.append(["Dir B", "https://blog.example.com/post-2", "Live"])  # duplicate across sheets
ws3.append(["Dir C", "ftp://files.example.com/x", "Live"])

ws4 = wb.create_sheet("Old")
ws4.sheet_state = "hidden"
ws4.append(["backlinks"])
ws4.append(["https://old.example.com/a"])

wb.create_sheet("Empty")
wb.save(os.path.join(OUT, "multi-sheet.xlsx"))

# 2. No Backlinks column anywhere.
wb = Workbook()
wb.active.append(["URL", "Anchor"])
wb.active.append(["https://example.com", "x"])
wb.save(os.path.join(OUT, "no-backlinks-column.xlsx"))

# 3. Column present but nothing usable.
wb = Workbook()
wb.active.append(["Backlinks"])
for v in ["n/a", "pending", "tbc"]:
    wb.active.append([v])
wb.save(os.path.join(OUT, "no-valid-urls.xlsx"))

# 4. Large: 5,000 rows, ~20% repeats, one sheet.
random.seed(7)
wb = Workbook()
ws = wb.active
ws.title = "Big"
ws.append(["Backlinks", "Target URL", "Anchor Text"])
for i in range(5000):
    n = random.randint(0, 3999)
    ws.append([f"https://site{n % 400}.example.com/post-{n}", "https://lanop.co.uk/", f"anchor {i}"])
wb.save(os.path.join(OUT, "large-5000.xlsx"))

# 5. Not an Excel file at all, renamed.
with open(os.path.join(OUT, "not-really.xlsx"), "w") as f:
    f.write("Backlinks\nhttps://example.com\n")

print("fixtures written to", os.path.abspath(OUT))

# multi-sheet-excel-style.xlsx is multi-sheet.xlsx re-saved by LibreOffice, so it
# uses a shared-strings table like files saved by Microsoft Excel:
#   soffice --headless --convert-to "xlsx:Calc MS Excel 2007 XML" multi-sheet.xlsx
