#!/usr/bin/env python3
"""E2E v1.10 C1 (executable verification, browser + API): on the demo instance,
  - the create form offers a verification-command field,
  - creating a task with one persists it (API readback) and surfaces it on
    the card as a [data-verification] chip,
  - the field is optional: a task without one has no chip.

Env: BASE (default http://127.0.0.1:3099). Requires the C1 client bundle.
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

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    # Create a task with a verification command via the form.
    pg.locator('button[title="New task"]').first.click()
    pg.wait_for_timeout(1000)
    dialog = pg.locator('[role="dialog"]')
    check('C1: create form opens', dialog.count() >= 1)
    if dialog.count() == 0:
        b.close()
        print('E2E-V110-C1-FAIL (1)')
        sys.exit(1)

    verif_input = dialog.locator('input[placeholder*="Verification command"], input[placeholder*="验证命令"]').first
    check('C1: verification field in the create form', verif_input.count() >= 1)
    if verif_input.count() >= 1:
        verif_input.fill('node tests/e2e/v12.mjs')
    dialog.locator('input').first.fill('C1 E2E verifiable task')
    dialog.locator('button').filter(has_text='Create').first.click()
    pg.wait_for_timeout(2500)

    # The card surfaces the verification chip.
    card = pg.locator('[class*="card"], article').filter(has_text='C1 E2E verifiable task').first
    check('C1: created card present', card.count() >= 1)
    chip = card.locator('[data-verification]')
    check('C1: verification chip on the card', chip.count() >= 1)
    if chip.count() >= 1:
        check('C1: chip shows the command', 'node tests/e2e/v12.mjs' in chip.first.inner_text(), chip.first.inner_text())

    # API readback: the spec carries it.
    req = urllib.request.Request(BASE + '/api/taskboard/board', method='GET')
    with urllib.request.urlopen(req, timeout=5) as resp:
        board = json.load(resp)
    task = next(t for t in board['tasks'] if 'C1 E2E verifiable task' in t['title'])
    check('C1: API persists the verification command',
          (task.get('spec') or {}).get('verification') == 'node tests/e2e/v12.mjs',
          str((task.get('spec') or {}).get('verification')))

    b.close()

print('E2E-V110-C1-PASS' if failures == 0 else f'E2E-V110-C1-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
