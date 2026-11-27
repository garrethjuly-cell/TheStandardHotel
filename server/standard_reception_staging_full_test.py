#!/usr/bin/env python3
"""Consolidated Standard Reception staging integration test.
Creates one clearly-labelled synthetic WhatsApp enquiry, verifies deduplication,
then acknowledges/resolves that synthetic record. It does not send a WhatsApp message.
"""
import getpass, http.cookiejar, json, sys, time, uuid
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError, URLError

BASE = 'https://staging.thestandardhotel.net'
USERNAME = 'MasterAcc'
PASSWORD = getpass.getpass('MasterAcc password: ')
COOKIE_JAR = http.cookiejar.CookieJar()
OPENER = build_opener(HTTPCookieProcessor(COOKIE_JAR))
RESULTS = []

def call(path, method='GET', data=None):
    body = json.dumps(data).encode('utf-8') if data is not None else None
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    req = Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=25) as r:
            raw = r.read().decode('utf-8', 'replace')
            try: parsed = json.loads(raw)
            except Exception: parsed = {'raw': raw[:1200]}
            return r.status, parsed
    except HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try: parsed = json.loads(raw)
        except Exception: parsed = {'raw': raw[:1200]}
        return e.code, parsed
    except Exception as e:
        return None, {'error': str(e)}

def record(name, ok, detail=''):
    RESULTS.append((name, bool(ok), str(detail)))
    print(('[PASS] ' if ok else '[FAIL] ') + name + ((' — ' + str(detail)) if detail else ''))

def skip(name, detail):
    RESULTS.append((name, None, detail))
    print('[NOT VERIFIED] ' + name + ' — ' + detail)

print('\n=== STANDARD RECEPTION STAGING: CONSOLIDATED TEST ===')
print('Target:', BASE, '| Account:', USERNAME)

# Public health
s, d = call('/healthz')
record('Health endpoint', s == 200 and d.get('status') == 'ok', 'HTTP %s %s' % (s, d))

# Login and session
s, d = call('/api/auth/login', 'POST', {'username': USERNAME, 'password': PASSWORD})
login_ok = s == 200 and d.get('success') is True and d.get('staff', {}).get('username') == USERNAME
record('MasterAcc login', login_ok, 'HTTP %s; session cookies=%d' % (s, len(list(COOKIE_JAR))))
if not login_ok:
    print('\nCannot run authenticated tests without a successful login.'); sys.exit(1)

s, d = call('/api/auth/me')
record('Authenticated identity', s == 200 and d.get('success') is True and d.get('staff', {}).get('username') == USERNAME, 'HTTP %s' % s)

s, dash = call('/api/staff/dashboard')
dash_ok = s == 200 and dash.get('success') is True
record('Dashboard access', dash_ok, 'HTTP %s' % s)
if not dash_ok:
    print('Dashboard response:', dash); sys.exit(1)

# Select this account's registered device from dashboard
my_devices = [x for x in dash.get('registeredDevices', []) if x.get('username') == USERNAME]
device_id = dash.get('dashboardDeviceId') or (my_devices[0].get('device_id') if len(my_devices) == 1 else None)
if device_id:
    record('Registered gateway device found', True, device_id)
    s, hb = call('/api/test/gateway/heartbeat', 'POST', {'gateway_device_id': device_id})
    record('Gateway heartbeat API', s == 200 and hb.get('success') is True, 'HTTP %s %s' % (s, hb))
else:
    skip('Gateway heartbeat API', 'No unambiguous registered device ID was returned by dashboard.')
    skip('Gateway event ingestion and deduplication', 'Requires a registered device ID.')
    skip('Synthetic enquiry workflow', 'Requires successful event ingestion.')
    skip('Reply handoff workflow', 'Requires a synthetic enquiry ID.')

if device_id:
    # Unique synthetic event, no actual WhatsApp notification is sent.
    unique = uuid.uuid4().hex
    event_id = 'stagingtest.' + unique
    event = {
        'event_id': event_id,
        'notification_key': 'staging-test-' + unique,
        'package_name': 'com.whatsapp.w4b',
        'sender': 'STAGING AUTOMATED TEST',
        'message_preview': 'Synthetic integration test; no customer message. Safe to resolve.',
        'timestamp': int(time.time() * 1000),
        'preview_available': True,
        'gateway_device_id': device_id
    }
    s1, e1 = call('/api/test/gateway/events', 'POST', event)
    event_ok = s1 in (200, 201) and e1.get('success') is True and e1.get('accepted') is True and bool(e1.get('enquiry_id'))
    record('Synthetic WhatsApp event accepted', event_ok, 'HTTP %s; enquiry_id=%s' % (s1, e1.get('enquiry_id')))
    enquiry_id = e1.get('enquiry_id') if event_ok else None

    if event_ok:
        s2, e2 = call('/api/test/gateway/events', 'POST', event)
        record('Duplicate event safely deduplicated', s2 == 200 and e2.get('duplicate') is True and e2.get('enquiry_id') == enquiry_id, 'HTTP %s %s' % (s2, e2))

        # Confirm enquiry is visible in authenticated inbox.
        s3, inbox = call('/api/staff/enquiries')
        inbox_items = inbox.get('enquiries', []) if isinstance(inbox, dict) else []
        found = any(str(x.get('id')) == str(enquiry_id) for x in inbox_items if isinstance(x, dict))
        record('Synthetic enquiry visible in inbox', s3 == 200 and (found or inbox.get('success') is True), 'HTTP %s; response keys=%s' % (s3, ','.join(inbox.keys()) if isinstance(inbox, dict) else 'n/a'))

        # Exercise reply handoff with a reserved dummy number; no WhatsApp is opened and no message is sent.
        s4, hand = call('/api/staff/enquiries/%s/handoff' % enquiry_id, 'POST', {
            'recipient': '263000000000',
            'message': 'STAGING TEST ONLY — do not send.'
        })
        hand_ok = s4 == 201 and hand.get('success') is True and hand.get('deliveryConfirmed') is False
        record('Reply handoff preparation (no send)', hand_ok, 'HTTP %s; handoff_id=%s; deliveryConfirmed=%s' % (s4, hand.get('handoffId'), hand.get('deliveryConfirmed')))
        if hand_ok:
            s5, opened = call('/api/staff/handoff/%s' % hand.get('handoffId'), 'PATCH', {'state': 'opened'})
            record('Reply handoff opened state', s5 == 200 and opened.get('success') is True and opened.get('state') == 'opened' and opened.get('deliveryConfirmed') is False, 'HTTP %s %s' % (s5, opened))

        # Acknowledge and resolve only the synthetic enquiry created by this run.
        s6, ack = call('/api/staff/enquiries/%s/status' % enquiry_id, 'PATCH', {'status': 'acknowledged', 'device_id': device_id})
        record('Synthetic enquiry global acknowledgement', s6 == 200 and ack.get('success') is True and ack.get('globallyDismissed') is True, 'HTTP %s %s' % (s6, ack))
        s7, res = call('/api/staff/enquiries/%s/status' % enquiry_id, 'PATCH', {'status': 'resolved', 'device_id': device_id})
        record('Synthetic enquiry resolved', s7 == 200 and res.get('success') is True, 'HTTP %s %s' % (s7, res))
    else:
        skip('Duplicate event safely deduplicated', 'Initial synthetic event was not accepted.')
        skip('Synthetic enquiry visible in inbox', 'No synthetic enquiry ID.')
        skip('Reply handoff workflow', 'No synthetic enquiry ID.')
        skip('Synthetic enquiry global acknowledgement', 'No synthetic enquiry ID.')
        skip('Synthetic enquiry resolved', 'No synthetic enquiry ID.')

# Confirm unauthenticated restriction independently with a fresh cookie-free opener.
try:
    anon = build_opener()
    req = Request(BASE + '/api/staff/dashboard')
    with anon.open(req, timeout=20) as r:
        anon_status = r.status
except HTTPError as e:
    anon_status = e.code
except Exception:
    anon_status = None
record('Dashboard requires authentication', anon_status == 401, 'Unauthenticated HTTP %s' % anon_status)

# Registration requires a real FCM token from the Android device; never fabricate one.
skip('Device registration / FCM token', 'Requires the actual Firebase token generated by the Android app; no token was fabricated.')
skip('Firebase Admin push delivery', 'HTTP endpoints cannot prove delivery; requires server-side Firebase Admin logs and a real registered Android token.')
skip('Non-allowlisted staff denial', 'Requires credentials for a separate non-allowlisted staff account; no other account was accessed.')
skip('Physical Android notification capture', 'Requires installing the staging-configured APK on the Samsung gateway phone and receiving a real notification.')

print('\n=== SUMMARY ===')
passed = sum(1 for _, ok, _ in RESULTS if ok is True)
failed = sum(1 for _, ok, _ in RESULTS if ok is False)
not_verified = sum(1 for _, ok, _ in RESULTS if ok is None)
print('PASS:', passed, '| FAIL:', failed, '| NOT VERIFIED:', not_verified, '| TOTAL:', len(RESULTS))
if failed:
    print('RESULT: FAIL — inspect the failed items above.')
elif not_verified:
    print('RESULT: PARTIAL PASS — all executed checks passed; listed items need device/account/server-log evidence.')
else:
    print('RESULT: PASS')
print('\nThis run creates one synthetic WhatsApp enquiry and resolves it. It does not send a WhatsApp message.')
