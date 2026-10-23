#!/usr/bin/env python3
"""Browser entry point; uses the same application and behavior as desktop."""
from desktop_server import main

if __name__ == "__main__":
    main(default_profile="web")
