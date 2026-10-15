 
import fcntl
import os
import termios

fcntl.ioctl(0, termios.TIOCSCTTY, 0)
for key in list(os.environ):
    if key.startswith(("PYTHON", "SHIYAN_")):
        os.environ.pop(key, None)
os.execve("/bin/zsh", ["/bin/zsh", "-l"], os.environ)
