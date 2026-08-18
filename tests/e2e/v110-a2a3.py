#!/usr/bin/env python3
"""E2E v1.10 A2+A3 (memory: create-time visibility + bounce carries memory):
  A2: opening the create form surfaces the project's related experience
      (done tasks with evidence) in a [data-experience] section.
  A3: bouncing an awaiting_human task lands a note that carries BOTH the
      human's reason AND a digest of the rejected evidence.

The demo instance's awaiting_human card (TB-5) is the A3 fixture; a previous
run bounces it, so this script RESTORES it (store rewrite) and restarts the
instance before asserting — the run is idempotent.

Env: BASE (default http://127.0.0.1:3099), DSH_HOME (default /tmp/dsh-e2e-v02).
Requires the A2/A3 client bundle.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3099')
# Deliberately NOT DSH_HOME: the shell exports that to the user's real home,
# which this demo fixture must never touch. E2E_DSH_HOME is ours.
HOME = os.environ.get('E2E_DSH_HOME', '/tmp/dsh-e2e-v02')
failures = 0

def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' <- ' + detail if detail else ''}")
    if not ok:
        failures += 1

def restore_fixture():
    """Rewrite TB-5 back to awaiting_human with evidence, then restart 3099
    so the running process picks the store up. Delegated to the shell script
    (the sandbox permits bash's writes to the temp store)."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'restore-tb5-fixture.sh')
    result = subprocess.run(['bash', script], check=False, capture_output=True, text=True,
                            env={**os.environ, 'E2E_DSH_HOME': HOME})
    if result.returncode != 0:
        raise RuntimeError(f'fixture restore failed: {result.stderr}')

restore_fixture()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    # ---- A2: create form shows related experience ----
    pg.locator('button[title="New task"]').first.click()
    pg.wait_for_timeout(1200)
    exp = pg.locator('[data-experience]')
    check('A2: create form renders the experience section', exp.count() >= 1, f'{exp.count()} sections')
    if exp.count() >= 1:
        text = exp.first.inner_text()
        check('A2: experience section shows a done task with evidence', 'TB-7' in text and 'README' in text, text[:120])
        check('A2: experience carries artifacts', 'docs/screenshots' in text, '')
    pg.get_by_role('button', name='×').first.click()
    pg.wait_for_timeout(500)

    # ---- A3: bounce carries memory ----
    # Find the awaiting_human card (TB-5, "面板加实时刷新") and bounce it.
    awaiting = pg.locator('[class*="card"], article').filter(has_text='实时刷新').first
    check('A3: awaiting_human card present', awaiting.count() >= 1)
    if awaiting.count() == 0:
        b.close()
        print('E2E-V110-A2A3-FAIL (1)')
        sys.exit(1)
    await_btn = awaiting.get_by_role('button', name='Bounce to draft')
    check('A3: Bounce button present', await_btn.count() >= 1)
    if await_btn.count() >= 1:
        await_btn.first.click()
        pg.wait_for_timeout(500)
        reason = awaiting.locator('input[placeholder*="Why?"], input[placeholder*="原因"]').first
        check('A3: bounce reason editor opens', reason.count() >= 1)
        if reason.count() >= 1:
            reason.fill('A3 E2E: 复现路径未覆盖边界情况')
            pg.wait_for_timeout(200)
            awaiting.get_by_role('button', name='Bounce with reason').first.click()
            pg.wait_for_timeout(1500)
            # After bounce the card moves to draft; its notes now carry the memory.
            body = pg.inner_text('body')
            check('A3: bounce reason landed in notes', 'A3 E2E' in body, '')
            check('A3: rejected evidence digest carried', 'rejected evidence' in body, '')
            check('A3: original evidence summary carried', 'SSE 端点可用' in body, '')

    b.close()

print('E2E-V110-A2A3-PASS' if failures == 0 else f'E2E-V110-A2A3-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
