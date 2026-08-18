#!/usr/bin/env python3
"""E2E v1.10 A1 (Task Movie timeline, browser): on the demo instance, open the
activity drawer of a task with a full history (TB-5, restored by the fixture)
and assert the timeline renders:
  - the drawer opens and shows the task's activity,
  - chronological events are present (created → claimed → settled),
  - timestamps render, and the drawer is not in its empty state.

Env: BASE (default http://127.0.0.1:3099). Requires the A1 client bundle.
The demo instance must be running with the current build (restart after
`pnpm run build`); restore-tb5-fixture.sh resets TB-5 if a previous run
bounced or confirmed it.
"""
import os
import subprocess
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3099')
failures = 0

def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' <- ' + detail if detail else ''}")
    if not ok:
        failures += 1

# Make sure the awaiting_human fixture (TB-5, full activity) is in place.
script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'restore-tb5-fixture.sh')
result = subprocess.run(['bash', script], check=False, capture_output=True, text=True,
                        env={**os.environ, 'E2E_DSH_HOME': os.environ.get('E2E_DSH_HOME', '/tmp/dsh-e2e-v02')})
if result.returncode != 0:
    print('fixture restore failed:', result.stderr)
    sys.exit(1)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    # TB-5 (面板加实时刷新) has created → claimed → settled activity.
    card = pg.locator('[class*="card"], article').filter(has_text='实时刷新').first
    check('A1: fixture card present', card.count() >= 1)
    if card.count() == 0:
        b.close()
        print('E2E-V110-A1-FAIL (1)')
        sys.exit(1)
    abtn = card.get_by_role('button', name='Activity')
    check('A1: Activity button on the card', abtn.count() >= 1, f'{abtn.count()} buttons')
    abtn.first.click()
    pg.wait_for_timeout(1500)

    body = pg.inner_text('body')
    # The drawer tail carries the timeline events; the empty state must be absent.
    check('A1: drawer not in empty state', 'No tasks yet' not in body, '')
    check('A1: created event rendered', 'created' in body or '创建了' in body, '')
    check('A1: claimed event rendered', 'claimed for session' in body or '认领了会话' in body, '')
    check('A1: settled event rendered', 'settled to' in body or '结算到' in body, '')
    check('A1: timestamps rendered', '2026' in body, '')
    # The drawer header names the task.
    check('A1: drawer header names the task', 'TB-5' in body, '')

    b.close()

print('E2E-V110-A1-PASS' if failures == 0 else f'E2E-V110-A1-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
