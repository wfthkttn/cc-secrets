"""Runs bin/relay.py and bin/mask-run together, without Claude Code.

Usage: python3 -I tests/mask_run_test.py
"""
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin')
failures = []


def check(name, got, want):
    if got != want:
        failures.append(name)
        print(f'FAIL {name}: got {got!r}, want {want!r}')
    else:
        print(f'ok   {name}')


def post(sock_path, path, body):
    conn = http.client.HTTPConnection('relay')
    conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.sock.connect(sock_path)
    conn.request('POST', path, body=json.dumps(body), headers={'Content-Type': 'application/json'})
    return conn.getresponse().status


def answer_next_ask(events, sock_path, secret):
    """Waits for the relay's next ask and answers it with `secret`."""
    line = events.readline()
    ask = json.loads(line)['ask']
    return post(sock_path, '/answer', {'id': ask['id'], 'secret': secret})


def mask_run(sock_path, command, env_extra=None):
    env = dict(os.environ, SECRETS_RELAY=sock_path, ASK_SECRET=os.path.join(BIN, 'ask-secret'), SECRETS_MASK_MIN='6')
    env.pop('SECRETS_ORIG_PREFIX', None)
    env.update(env_extra or {})
    return subprocess.Popen([os.path.join(BIN, 'mask-run'), command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def main():
    runtime = os.environ.get('XDG_RUNTIME_DIR', '/tmp')
    with tempfile.TemporaryDirectory(dir=runtime, prefix='mr-') as tmp:
        sock_path = os.path.join(tmp, 'r.sock')
        relay = subprocess.Popen([sys.executable, '-I', os.path.join(BIN, 'relay.py'), sock_path], stdout=subprocess.PIPE, text=True)
        try:
            check('relay ready', 'ready' in json.loads(relay.stdout.readline()), True)

            run = mask_run(sock_path, 'x=$($ASK_SECRET "t1"); printf "got %s\\n" "$x"; printf "%s" "$x" >&2; exit 3')
            check('answered', answer_next_ask(relay.stdout, sock_path, 'hunter2'), 204)
            out, err = run.communicate(timeout=10)
            check('value typed mid-command is masked on stdout', out, b'got [secret]\n')
            check('and on stderr', err, b'[secret]')
            check('exit status passes through', run.returncode, 3)

            run = mask_run(sock_path, 'x=$($ASK_SECRET "t2"); printf "%s and hunter2\\n" "$x"')
            check('answered short', answer_next_ask(relay.stdout, sock_path, 'abc'), 204)
            out, _ = run.communicate(timeout=10)
            check('a value under SECRETS_MASK_MIN stays as it is', out, b'abc and [secret]\n')

            run = mask_run(sock_path, 'printf "abc"', {'SECRETS_MASK_MIN': ''})
            out, err = run.communicate(timeout=10)
            check('no minimum set: every value is masked', out, b'[secret]')
            check('no minimum set: says so', b'SECRETS_MASK_MIN' in err, True)

            split ='printf "hun"; sleep 0.3; printf "ter2 and hunt"; sleep 0.3; printf "er2\\n"'
            run = mask_run(sock_path, split)
            out, _ = run.communicate(timeout=10)
            check('a value split across writes is masked', out, b'[secret] and [secret]\n')

            run = mask_run(sock_path, 'printf "hunt"')
            out, _ = run.communicate(timeout=10)
            check('a held-back tail comes out at the end', out, b'hunt')

            run = mask_run(sock_path, 'printf "\\x00\\xffbinary"')
            out, _ = run.communicate(timeout=10)
            check('binary passes', out, b'\x00\xffbinary')

            run = mask_run(sock_path, 'while read -r line; do printf "%s\\n" "$line"; done')
            run.stdin.write(b'{"jsonrpc":"2.0","id":1}\n')
            run.stdin.flush()
            check('a line comes back while the command still runs', run.stdout.readline(), b'{"jsonrpc":"2.0","id":1}\n')
            run.stdin.close()
            run.communicate(timeout=10)

            run = mask_run(sock_path, 'kill -TERM $$')
            run.communicate(timeout=10)
            check('a signal ends it as 128+signal', run.returncode, 128 + signal.SIGTERM)

            run = mask_run(os.path.join(tmp, 'nope.sock'), 'echo hunter2')
            out, err = run.communicate(timeout=10)
            check('no relay: the command still runs', out, b'hunter2\n')
            check('no relay: says so', b'not masked' in err, True)

            started = time.monotonic()
            run = mask_run(sock_path, 'true')
            run.communicate(timeout=10)
            print(f'info a bare command through mask-run takes {1000 * (time.monotonic() - started):.0f} ms')
        finally:
            relay.terminate()
            relay.wait(timeout=5)
    if failures:
        sys.exit(f'{len(failures)} failed')


main()
