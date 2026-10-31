"""Reconnect the private RAG tunnel using the currently reachable Mac route."""
import signal
import socket
import subprocess
import threading

stopped = threading.Event()
child = None


def stop(*_):
    stopped.set()
    if child is not None and child.poll() is None:
        child.terminate()


def reachable(host):
    try:
        with socket.create_connection((host, 22), timeout=2):
            return True
    except OSError:
        return False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while not stopped.is_set():
    vpn = reachable('10.8.2.3')
    route = '10.8.2.3' if vpn else '100.127.45.71'
    if not vpn and not reachable(route):
        stopped.wait(10)
        continue
    arguments = ['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                 '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                 '-o', 'HostName=' + route, '-L', '127.0.0.1:18769:127.0.0.1:8769', 'mac']
    child = subprocess.Popen(arguments)
    child.wait()
    child = None
    stopped.wait(5)
