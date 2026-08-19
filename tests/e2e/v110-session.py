#!/usr/bin/env python3
"""E2E v1.10 A-session (card title → conversation, browser): on the demo
instance,
  - an in-flight task's title renders as a session jump (data-session-jump)
    with the claiming session's short id,
  - clicking it switches the GUI to that conversation,
  - the footer 'Open in conversation' button is gone while the title is the
    jump (one entry, not two).

Fixture: the demo's in_progress task is repointed at a REAL session id (the
hand-crafted demo board used a fake 'session-shot-1'), then the instance is
restarted so the running process picks the store up.

Env: BASE (default http://127.0.0.1:3099), E2E_DSH_HOME (default
/tmp/dsh-e2e-v02). Requires the A-session client bundle.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3099')
HOME = os.environ.get('E2E_DSH_HOME', '/tmp/dsh-e2e-v02')
failures = 0

def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' <- ' + detail if detail else ''}")
    if not ok:
        failures += 1

def prepare_fixture():
    """Point the demo's in_progress task at a real session id, then restart
    the instance so the running process picks the store up."""
    path = os.path.join(HOME, 'storages/taskboard.json')
    with open(path) as f:
        doc = json.load(f)
    # A real session from this home's session store (the demo board's
    # hand-crafted 'session-shot-1' does not exist in the GUI).
    real = None
    sessions_root = os.path.join(HOME, 'sessions')
    for root, dirs, _ in os.walk(sessions_root):
        for d in dirs:
            if d.startswith('session-'):
                real = d
                break
        if real:
            break
    if real is None:
        raise RuntimeError('no real session found in ' + sessions_root)
    changed = False
    for task in doc['tables']['tasks'].values():
        if task.get('status') == 'in_progress':
            task['claimedBySessionId'] = real
            changed = True
    if not changed:
        raise RuntimeError('no in_progress task to repoint')
    with open(path, 'w') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    subprocess.run(['bash', '-c', 'lsof -ti :3099 | xargs -r kill 2>/dev/null'], check=False)
    time.sleep(1)
    subprocess.Popen(
        ['bash', '-c',
         'export DSH_HOME=%s; cd /; nohup node /Users/ahyk/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 3099 > /tmp/dsh-3099.log 2>&1 &' % HOME],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        try:
            with urllib.request.urlopen(BASE + '/', timeout=2):
                return
        except Exception:
            time.sleep(1)
    raise RuntimeError('instance did not come back after fixture prepare')

prepare_fixture()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    jumps = pg.locator('[data-session-jump]')
    check('A-session: in-flight task title is a session jump', jumps.count() >= 1, f'{jumps.count()} jumps')
    if jumps.count() == 0:
        b.close()
        print('E2E-V110-SESSION-FAIL (1)')
        sys.exit(1)

    title = jumps.first.inner_text()
    check('A-session: jump shows the claiming session short id', 'session' in title or '→' in title, title[:80])

    footer = pg.get_by_role('button', name='Open in conversation')
    check('A-session: no duplicate footer button while title is the jump', footer.count() == 0, f'{footer.count()} footers')

    # Click the title: the GUI switches to the claiming session's view — the
    # conversation header changes away from the board's host session.
    jumps.first.click()
    pg.wait_for_timeout(2500)
    body = pg.inner_text('body')
    # The GUI switched away from the board's host conversation: the host
    # greeting (a distinctive timestamp from the '你好' session) is gone from
    # the frontmost view, and the target session's header is present.
    check('A-session: no longer on the board host session', '8/16 15:28' not in body, body[:120])
    check('A-session: target session view is frontmost',
          'Into the Unknown' in body or 'Session log' in body or 'Chat' in body or 'Trajectory' in body, body[:160])

    b.close()

print('E2E-V110-SESSION-PASS' if failures == 0 else f'E2E-V110-SESSION-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
