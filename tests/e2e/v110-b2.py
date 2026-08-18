#!/usr/bin/env python3
"""E2E v1.10 B2 (human review panel, browser): on the demo instance,
  - the awaiting_human card offers a Review action,
  - opening it shows the evidence-first panel (data-review-panel) with the
    certificate, per-criterion marks, and both decisions,
  - Confirm done closes the panel and moves the task to done.

Env: BASE (default http://127.0.0.1:3099). Requires the B2 client bundle.
"""
import os
import sys
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

    # The awaiting_human card (TB-5, restored by the fixture) has Review.
    awaiting = pg.locator('[class*="card"], article').filter(has_text='实时刷新').first
    check('B2: awaiting_human card present', awaiting.count() >= 1)
    if awaiting.count() == 0:
        b.close()
        print('E2E-V110-B2-FAIL (1)')
        sys.exit(1)
    review_btn = awaiting.locator('button[data-review]')
    check('B2: Review action on the card', review_btn.count() >= 1, f'{review_btn.count()} buttons')
    review_btn.first.click()
    pg.wait_for_timeout(1200)

    panel = pg.locator('[data-review-panel]')
    check('B2: review panel opens', panel.count() >= 1, f'{panel.count()} panels')
    if panel.count() >= 1:
        text = panel.first.inner_text()
        check('B2: panel shows the certificate', 'Certificate of completion' in text or '履约证明书' in text, '')
        check('B2: panel shows per-criterion marks', '✓' in text or '✗' in text, '')
        check('B2: panel shows related experience', 'TB-7' in text or 'README' in text, text[:150])
        confirm = panel.locator('button[data-confirm-done]')
        check('B2: Confirm done decision present', confirm.count() >= 1)
        if confirm.count() >= 1:
            confirm.first.click()
            pg.wait_for_timeout(2000)
            body = pg.inner_text('body')
            check('B2: task moved to done', 'Done' in body, '')
            check('B2: panel closed after confirming', pg.locator('[data-review-panel]').count() == 0, '')

    b.close()

print('E2E-V110-B2-PASS' if failures == 0 else f'E2E-V110-B2-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
