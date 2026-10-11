"""Usage: relay.py <socket-path>

HTTP on a unix socket. POST /ask {prompt, pid} is held open until answered and
prints {"ask": {id, prompt, pid, cmdline}} to stdout. POST /answer {id, secret}
or {id, cancel: true} completes it: 200 with the secret as the body, or 403.
A held request whose client disconnects prints {"gone": id}.
GET /watch streams every answered value as a JSON string per line, then each
new one, until the client disconnects.
"""
import json
import os
import select
import signal
import socket
import socketserver
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler

lock = threading.Lock()
waiting = {}
known = []
watchers = []


def emit(event):
    with lock:
        sys.stdout.write(json.dumps(event) + '\n')
        sys.stdout.flush()


def keep(secret):
    if secret == '':
        return
    line = (json.dumps(secret) + '\n').encode('utf-8')
    with lock:
        if secret in known:
            return
        known.append(secret)
        for watcher in list(watchers):
            try:
                watcher.write(line)
                watcher.flush()
            except OSError:
                watchers.remove(watcher)


def cmdline_of(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            return f.read().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
    except OSError:
        return ''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')

    def do_GET(self):
        if self.path != '/watch':
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        with lock:
            for secret in known:
                self.wfile.write((json.dumps(secret) + '\n').encode('utf-8'))
            self.wfile.flush()
            watchers.append(self.wfile)
        try:
            while self.connection.recv(1) != b'':
                pass
        except OSError:
            pass
        with lock:
            if self.wfile in watchers:
                watchers.remove(self.wfile)

    def do_POST(self):
        if self.path == '/ask':
            self.ask(self.body())
        elif self.path == '/answer':
            self.answer(self.body())
        else:
            self.send_error(404)

    def ask(self, req):
        ask_id = uuid.uuid4().hex
        done = threading.Event()
        slot = {'done': done, 'secret': None}
        with lock:
            waiting[ask_id] = slot
        pid = int(req.get('pid', 0))
        emit({'ask': {
            'id': ask_id,
            'prompt': str(req.get('prompt', '')),
            'pid': pid,
            'cmdline': cmdline_of(pid) if pid else '',
        }})
        while not done.wait(1.0):
            readable, _, _ = select.select([self.connection], [], [], 0)
            if readable and self.connection.recv(1, socket.MSG_PEEK) == b'':
                with lock:
                    waiting.pop(ask_id, None)
                emit({'gone': ask_id})
                return
        with lock:
            waiting.pop(ask_id, None)
        if slot['secret'] is None:
            self.send_response(403)
            self.end_headers()
            return
        data = slot['secret'].encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def answer(self, req):
        with lock:
            slot = waiting.get(str(req.get('id', '')))
        if slot is None:
            self.send_response(410)
            self.end_headers()
            return
        if not req.get('cancel'):
            slot['secret'] = str(req.get('secret', ''))
            keep(slot['secret'])
        slot['done'].set()
        self.send_response(204)
        self.end_headers()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    if len(sys.argv) != 2:
        sys.exit('relay.py: usage: relay.py <socket-path>')
    path = sys.argv[1]
    if os.path.exists(path):
        os.unlink(path)
    old = os.umask(0o177)
    try:
        server = Server(path, Handler)
    finally:
        os.umask(old)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    emit({'ready': path})
    try:
        server.serve_forever()
    finally:
        os.unlink(path)


main()
