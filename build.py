#!/usr/bin/env python3
"""Build the page the portal serves.

The client is kept in three readable pieces under client/ rather than one enormous
file, because one enormous file is how the last portal got out of hand:

    1-page.html   the page itself, the stylesheet, and the card artwork
    2-portal.js   signing in, the tables list, history, the member list
    3-table.js    the table, the betting controls, and drawing the screen

This glues them together into index.html, which is what the server serves.
"""
import pathlib

here = pathlib.Path(__file__).parent
parts = [here / 'client' / n for n in ('1-page.html', '2-portal.js', '3-table.js')]
missing = [p.name for p in parts if not p.exists()]
if missing:
    raise SystemExit('missing: ' + ', '.join(missing))

page = ''.join(p.read_text() for p in parts) + '</script></body></html>\n'
(here / 'index.html').write_text(page)
print('built index.html', len(page) // 1024, 'KB from', len(parts), 'parts')
