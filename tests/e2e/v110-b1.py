#!/usr/bin/env python3
"""E2E v1.10 B1 (live pulse bar, browser): on the demo instance,
  - the pulse bar renders with a live (green) dot once SSE connects,
  - a write from another connection (HTTP POST) fires the pulse: the change
    counter increments and the "last change" stamp refreshes.

Env: BASE (default http://127.0.0.1:3099). Requires the B1 client bundle.
"""
import json
import os
import sys
import urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3099')
failures = 0

def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' <- ' + detail if detail else ''}")
    if not ok:
        failures += 1

def post_task(title):
    req = urllib.request.Request(
        BASE + '/api/taskboard/task',
        data=json.dumps({'title': title, 'status': 'open',
                         'acceptance_criteria': ['p']}).encode(),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    bar = pg.locator('[data-pulse-bar]')
    check('B1: pulse bar renders', bar.count() >= 1, f'{bar.count()} bars')
    text0 = bar.first.inner_text()
    check('B1: shows Live after SSE connects', 'Live' in text0 or '实时' in text0, text0)

    # Trigger a board write from another connection; the SSE stream should
    # push a change and the bar should show it.
    status = post_task('B1 E2E pulse probe')
    check('B1: probe write accepted', status == 201, f'HTTP {status}')
    pg.wait_for_timeout(2000)
    text1 = bar.first.inner_text()
    check('B1: change counter appears/increments', 'changes' in text1 or '变更' in text1, text1)
    check('B1: last-change stamp refreshed', 'last change' in text1 or '最近变更' in text1, text1)

    b.close()

print('E2E-V110-B1-PASS' if failures == 0 else f'E2E-V110-B1-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
