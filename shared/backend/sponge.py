"""Account-scoped bridge to the Sponge connection endpoints."""
from fastapi import Request


def register_sponge(app):
    async def remote(request, method, action):
        # The account middleware selects this request's runtime and enforces the
        # existing session and CSRF checks before dispatching these handlers.
        gateway = request.app.state.runtime.gateway
        return await gateway.json(method, "integrations/sponge/" + action,
                                  {} if method == "POST" else None, timeout=25)

    @app.get("/api/integrations/sponge/status")
    async def status(request: Request):
        return await remote(request, "GET", "status")

    @app.post("/api/integrations/sponge/start")
    async def start(request: Request):
        return await remote(request, "POST", "start")

    @app.post("/api/integrations/sponge/disconnect")
    async def disconnect(request: Request):
        return await remote(request, "POST", "disconnect")
