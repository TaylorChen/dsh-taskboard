#!/usr/bin/env python3
"""E2E v1.10 B3 (first-run magic, browser): on an EMPTY board instance,
  - the onboarding card renders (data-onboarding) with the three-step loop,
  - its CTA opens the create form (which still shows related experience
    context, and posts a real task when saved).

Env: BASE (default http://127.0.0.1:3101). Requires the B3 client bundle.
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3101')
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

    card = pg.locator('[data-onboarding]')
    check('B3: onboarding card renders on an empty board', card.count() >= 1, f'{card.count()} cards')
    if card.count() >= 1:
        text = card.first.inner_text()
        check('B3: three-step loop described', 'three moves' in text.lower() or '三步' in text, text[:100])
        check('B3: CTA to create the first task', 'Create your first task' in text or '创建第一个任务' in text, '')

        # Click the CTA: the create form opens.
        card.first.locator('button').filter(has_text='first task').first.click()
        pg.wait_for_timeout(1000)
        dialog = pg.locator('[role="dialog"]')
        check('B3: CTA opens the create form', dialog.count() >= 1, f'{dialog.count()} dialogs')

        # Save a real task — the board is no longer empty.
        title_input = dialog.locator('input').first
        title_input.fill('B3 E2E first task')
        dialog.locator('button').filter(has_text='Create').first.click()
        pg.wait_for_timeout(2000)
        body = pg.inner_text('body')
        check('B3: created task appears on the board', 'B3 E2E first task' in body, '')
        check('B3: onboarding card gone once the board has tasks',
              pg.locator('[data-onboarding]').count() == 0, '')

    b.close()

print('E2E-V110-B3-PASS' if failures == 0 else f'E2E-V110-B3-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
